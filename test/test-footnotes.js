/* eslint-env node, mocha */

var fs = require("fs");
var path = require("path");
var JSDOM = require("jsdom").JSDOM;
var chai = require("chai");
var sinon = require("sinon");
chai.config.includeStack = true;
var expect = chai.expect;

var Readability = require("../index").Readability;
var JSDOMParser = require("../JSDOMParser");
var prettyPrint = require("./utils").prettyPrint;

var URI = "http://fakehost/test/page.html";
var TEST_PAGES = path.join(__dirname, "test-pages");

// A document whose footnote targets live in an <aside> that the regular
// extraction removes. It exercises role- and data-type-based references,
// a shared reference, a recursive/cyclic pair, a missing id and a
// cross-page reference.
var ASIDE_HTML = `
<!DOCTYPE html>
<html>
  <head><title>Footnote test</title></head>
  <body>
    <article>
      <h1>Footnote test</h1>
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod
      tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam,
      quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo
      consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse
      cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat
      non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
      <p>Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium
      doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore
      veritatis et quasi architecto beatae vitae dicta sunt explicabo.</p>
      <p>
        First<a role="doc-noteref" href="#fn1">[1]</a>
        second<a data-type="noteref" href="#fn2">[2]</a>
        shared<a role="doc-noteref" href="#fn1">[1]</a>
        missing<a role="doc-noteref" href="#fn-missing">[x]</a>
        offpage<a role="doc-noteref" href="other.html#fn3">[3]</a>
      </p>
    </article>
    <aside>
      <div role="doc-footnote" id="fn1">
        <p>Footnote one, points at <a role="doc-noteref" href="#fn2">[2]</a>.</p>
      </div>
      <div data-type="footnote" id="fn2">
        <p>Footnote two, cycles back to <a role="doc-noteref" href="#fn1">[1]</a>.</p>
      </div>
      <div role="doc-endnote" id="fn3"><p>Cross-page footnote.</p></div>
    </aside>
  </body>
</html>`;

// A document with an inline target the extraction keeps and an ambiguous
// id shared by two targets.
var INLINE_AND_DUPLICATE_HTML = `
<!DOCTYPE html>
<html>
  <head><title>Inline and duplicate footnotes</title></head>
  <body>
    <article>
      <h1>Inline and duplicate footnotes</h1>
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod
      tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam,
      quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo
      consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse
      cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat
      non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
      <p>
        inline<a role="doc-noteref" href="#inline-fn">[1]</a>
        duplicate<a data-type="noteref" href="#dup-fn">[2]</a>
      </p>
      <div role="doc-footnote" id="inline-fn">
        <p>An inline footnote retained by the regular extraction.</p>
      </div>
    </article>
    <aside>
      <div role="doc-footnote" id="dup-fn"><p>First duplicated target.</p></div>
      <div data-type="footnote" id="dup-fn"><p>Second duplicated target.</p></div>
    </aside>
  </body>
</html>`;

// A document using a <base> element, which makes every fragment-only href
// resolve against a different document base.
var BASE_HTML = `
<!DOCTYPE html>
<html>
  <head>
    <base href="http://fakehost/sub/" />
    <title>Base footnote test</title>
  </head>
  <body>
    <article>
      <h1>Base footnote test</h1>
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod
      tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam,
      quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo
      consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse
      cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat
      non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
      <p>
        hash<a role="doc-noteref" href="#fn1">[1]</a>
        relative<a role="doc-noteref" href="page.html#fn2">[2]</a>
      </p>
    </article>
    <aside>
      <div role="doc-footnote" id="fn1"><p>Same-document footnote.</p></div>
      <div role="doc-footnote" id="fn2"><p>Base-shifted footnote.</p></div>
    </aside>
  </body>
</html>`;

// A text-only target (no element children) that the extraction converts
// into a paragraph. Its content must still be recognized as retained.
var TEXT_ONLY_HTML = `
<!DOCTYPE html>
<html>
  <head><title>Text-only inline note</title></head>
  <body>
    <article>
      <h1>Text-only inline note</h1>
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod
      tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam,
      quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo
      consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse
      cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat
      non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
      <p>Reference<a role="doc-noteref" href="#note1">[1]</a>.</p>
      <div role="doc-footnote" id="note1">A text-only footnote target with no child elements.</div>
    </article>
  </body>
</html>`;

function makeJSDOMDocument(html, url) {
  return new JSDOM(html, { url: url || URI }).window.document;
}

function makeJSDOMParserDocument(html, url) {
  return new JSDOMParser().parse(html, url || URI);
}

function parse(html, options, makeDocument) {
  var doc = (makeDocument || makeJSDOMDocument)(html);
  return new Readability(
    doc,
    Object.assign({ charThreshold: 20 }, options)
  ).parse();
}

describe("keepFootnotes option", function () {
  describe("#constructor", function () {
    var doc = makeJSDOMDocument("<html><div>yo</div></html>");

    it("defaults to false", function () {
      expect(new Readability(doc)._keepFootnotes).eql(false);
    });

    it("accepts an explicit value", function () {
      expect(new Readability(doc, { keepFootnotes: true })._keepFootnotes).eql(
        true
      );
      expect(new Readability(doc, { keepFootnotes: false })._keepFootnotes).eql(
        false
      );
    });
  });

  [makeJSDOMDocument, makeJSDOMParserDocument].forEach(function (makeDocument) {
    describe("with " + makeDocument.name, function () {
      it("leaves the default output unchanged when disabled", function () {
        var off = parse(ASIDE_HTML, {}, makeDocument);
        expect(off.content).to.not.contain('id="fn1"');
        expect(off.content).to.not.contain("Footnote one");
        // Reference links in the main text are still present.
        expect(off.content).to.contain('role="doc-noteref"');
      });

      it("restores stripped aside footnote targets when enabled", function () {
        var on = parse(ASIDE_HTML, { keepFootnotes: true }, makeDocument);
        expect(on.content).to.contain('role="doc-footnote" id="fn1"');
        expect(on.content).to.contain("Footnote one");
        expect(on.content).to.contain('data-type="footnote" id="fn2"');
        expect(on.content).to.contain("Footnote two");
      });

      it("appends targets in first-reference order, each at most once", function () {
        var on = parse(ASIDE_HTML, { keepFootnotes: true }, makeDocument);
        var fn1Positions = [];
        var idx = on.content.indexOf('id="fn1"');
        while (idx !== -1) {
          fn1Positions.push(idx);
          idx = on.content.indexOf('id="fn1"', idx + 1);
        }
        // The shared reference must not produce a second target copy.
        expect(fn1Positions.length).eql(1);
        expect(on.content.indexOf('id="fn1"')).to.be.below(
          on.content.indexOf('id="fn2"')
        );
      });

      it("follows recursive references and terminates on cycles", function () {
        var on = parse(ASIDE_HTML, { keepFootnotes: true }, makeDocument);
        // fn1 references fn2 and fn2 references fn1; both appear once and
        // parsing terminates rather than looping forever.
        expect(on.content.match(/id="fn1"/g).length).eql(1);
        expect(on.content.match(/id="fn2"/g).length).eql(1);
      });

      it("does not fetch cross-page references", function () {
        var on = parse(ASIDE_HTML, { keepFootnotes: true }, makeDocument);
        expect(on.content).to.not.contain('id="fn3"');
        expect(on.content).to.not.contain("Cross-page footnote");
      });

      it("does not guess targets for missing ids", function () {
        var on = parse(ASIDE_HTML, { keepFootnotes: true }, makeDocument);
        expect(on.content).to.not.contain('id="fn-missing"');
      });

      it("logs diagnostics for missing and cross-page references", function () {
        var doc = makeDocument(ASIDE_HTML);
        var reader = new Readability(doc, {
          charThreshold: 20,
          keepFootnotes: true,
          debug: true,
        });
        var log = sinon.stub(reader, "log");
        reader.parse();
        var messages = log.getCalls().map(call => call.args.join(" "));
        expect(
          messages.some(m => m.includes("does not match any footnote target"))
        ).eql(true);
        expect(messages.some(m => m.includes("another document"))).eql(true);
      });

      it("does not duplicate targets already kept in the article", function () {
        var on = parse(
          INLINE_AND_DUPLICATE_HTML,
          { keepFootnotes: true },
          makeDocument
        );
        expect(on.content.match(/id="inline-fn"/g)).eql(null);
        expect(on.content).to.contain(
          "An inline footnote retained by the regular extraction."
        );
      });

      it("does not duplicate a retained text-only target", function () {
        var on = parse(TEXT_ONLY_HTML, { keepFootnotes: true }, makeDocument);
        expect(
          on.content.match(/text-only footnote target/g) || []
        ).to.have.lengthOf(1);
        expect(on.content).to.not.contain('id="note1"');
      });

      it("refuses ambiguous duplicated ids instead of guessing", function () {
        var on = parse(
          INLINE_AND_DUPLICATE_HTML,
          { keepFootnotes: true },
          makeDocument
        );
        expect(on.content).to.not.contain('id="dup-fn"');
        expect(on.content).to.not.contain("First duplicated target");
        expect(on.content).to.not.contain("Second duplicated target");
      });

      it("ignores references made cross-page by a base element", function () {
        var on = parse(BASE_HTML, { keepFootnotes: true }, makeDocument);
        // With <base>, even "#fn1" resolves to another document, so no
        // footnote target is pulled into the article.
        expect(on.content).to.not.contain('id="fn1"');
        expect(on.content).to.not.contain('id="fn2"');
      });

      it("does not influence main-content selection", function () {
        function article(html) {
          var start = html.indexOf("<article>");
          var end = html.lastIndexOf("</article>") + "</article>".length;
          return html.slice(start, end);
        }
        var off = parse(ASIDE_HTML, {}, makeDocument);
        var on = parse(ASIDE_HTML, { keepFootnotes: true }, makeDocument);
        // The main article selected with the option off is fully retained
        // with it on; enabling footnotes only appends additional targets.
        expect(article(on.content)).eql(article(off.content));
      });
    });
  });

  describe("fixed HTML regression pages", function () {
    [
      {
        dir: "footnotes-aside",
        title: "restores aside footnotes with shared/cyclic refs",
      },
      {
        dir: "footnotes-duplicate-and-inline",
        title: "keeps inline targets and rejects duplicated ids",
      },
    ].forEach(function (page) {
      var pageDir = path.join(TEST_PAGES, page.dir);
      var source = fs
        .readFileSync(path.join(pageDir, "source.html"), "utf8")
        .trim();

      [makeJSDOMDocument, makeJSDOMParserDocument].forEach(
        function (makeDocument) {
          it(
            page.title + " (" + makeDocument.name + ", on vs off fixtures)",
            function () {
              function run(keepFootnotes) {
                var doc = makeDocument(source);
                return prettyPrint(
                  new Readability(doc, {
                    classesToPreserve: ["caption"],
                    keepFootnotes,
                  }).parse().content
                );
              }
              var off = run(false);
              var on = run(true);
              expect(off).eql(
                fs
                  .readFileSync(path.join(pageDir, "expected.html"), "utf8")
                  .trim()
              );
              expect(on).eql(
                fs
                  .readFileSync(
                    path.join(pageDir, "expected-keep-footnotes.html"),
                    "utf8"
                  )
                  .trim()
              );
            }
          );
        }
      );
    });
  });

  describe("serializer compatibility", function () {
    it("honors a custom serializer when restoring footnotes", function () {
      var doc = makeJSDOMDocument(ASIDE_HTML);
      var element = new Readability(doc, {
        charThreshold: 20,
        keepFootnotes: true,
        serializer: el => el,
      }).parse().content;
      // Identity serializer returns the root element rather than a string.
      expect(element.nodeType).eql(1);
      expect(element.querySelector("#fn1")).to.not.eql(null);
      expect(element.querySelector("#fn2")).to.not.eql(null);
    });
  });
});
