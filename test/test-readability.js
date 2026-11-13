/* eslint-env node, mocha */

var JSDOM = require("jsdom").JSDOM;
var xmlNameValidator = require("xml-name-validator").name;
var chai = require("chai");
var sinon = require("sinon");
chai.config.includeStack = true;
var expect = chai.expect;

var Readability = require("../index").Readability;
var JSDOMParser = require("../JSDOMParser");
var prettyPrint = require("./utils").prettyPrint;

var testPages = require("./utils").getTestPages();

function reformatError(err) {
  var formattedError = new Error(err.message);
  formattedError.stack = err.stack;
  return formattedError;
}

function inOrderTraverse(fromNode) {
  if (fromNode.firstChild) {
    return fromNode.firstChild;
  }
  while (fromNode && !fromNode.nextSibling) {
    fromNode = fromNode.parentNode;
  }
  return fromNode ? fromNode.nextSibling : null;
}

function inOrderIgnoreEmptyTextNodes(fromNode) {
  do {
    fromNode = inOrderTraverse(fromNode);
  } while (fromNode && fromNode.nodeType == 3 && !fromNode.textContent.trim());
  return fromNode;
}

function traverseDOM(callback, expectedDOM, actualDOM) {
  var actualNode = actualDOM.documentElement || actualDOM.childNodes[0];
  var expectedNode = expectedDOM.documentElement || expectedDOM.childNodes[0];
  while (actualNode || expectedNode) {
    // We'll stop if we don't have both actualNode and expectedNode
    if (!callback(actualNode, expectedNode)) {
      break;
    }
    actualNode = inOrderIgnoreEmptyTextNodes(actualNode);
    expectedNode = inOrderIgnoreEmptyTextNodes(expectedNode);
  }
}

// Collapse subsequent whitespace like HTML:
function htmlTransform(str) {
  return str.replace(/\s+/g, " ");
}

function runTestsWithItems(
  label,
  domGenerationFn,
  source,
  expectedContent,
  expectedMetadata,
  options
) {
  describe(label, function () {
    this.timeout(30000);

    var result;

    before(function () {
      try {
        var doc = domGenerationFn(source);
        // Provide one class name to preserve, which we know appears in a few
        // of the test documents.
        var myReader = new Readability(
          doc,
          Object.assign({ classesToPreserve: ["caption"] }, options)
        );
        result = myReader.parse();
      } catch (err) {
        throw reformatError(err);
      }
    });

    it("should return a result object", function () {
      expect(result).to.include.keys("content", "title", "excerpt", "byline");
    });

    it("should extract expected content", function () {
      function nodeStr(n) {
        if (!n) {
          return "(no node)";
        }
        if (n.nodeType == 3) {
          return "#text(" + htmlTransform(n.textContent) + ")";
        }
        if (n.nodeType != 1) {
          return "some other node type: " + n.nodeType + " with data " + n.data;
        }
        var rv = n.localName;
        if (n.id) {
          rv += "#" + n.id;
        }
        if (n.className) {
          rv += ".(" + n.className + ")";
        }
        return rv;
      }

      function genPath(node) {
        if (node.id) {
          return "#" + node.id;
        }
        if (node.tagName == "BODY") {
          return "body";
        }
        var parent = node.parentNode;
        var parentPath = genPath(parent);
        var index = Array.prototype.indexOf.call(parent.childNodes, node) + 1;
        return parentPath + " > " + nodeStr(node) + ":nth-child(" + index + ")";
      }

      function findableNodeDesc(node) {
        return genPath(node) + "(in: ``" + node.parentNode.innerHTML + "``)";
      }

      function attributesForNode(node) {
        return Array.from(node.attributes)
          .filter(function (attr) {
            return xmlNameValidator(attr.name);
          })
          .map(function (attr) {
            return attr.name + "=" + attr.value;
          });
      }

      var actualDOM = domGenerationFn(prettyPrint(result.content));
      var expectedDOM = domGenerationFn(prettyPrint(expectedContent));

      traverseDOM(
        function (actualNode, expectedNode) {
          if (actualNode && expectedNode) {
            var actualDesc = nodeStr(actualNode);
            var expectedDesc = nodeStr(expectedNode);
            if (actualDesc != expectedDesc) {
              expect(actualDesc, findableNodeDesc(actualNode)).eql(
                expectedDesc
              );
              return false;
            }
            // Compare text for text nodes:
            if (actualNode.nodeType == 3) {
              var actualText = htmlTransform(actualNode.textContent);
              var expectedText = htmlTransform(expectedNode.textContent);
              expect(actualText, findableNodeDesc(actualNode)).eql(
                expectedText
              );
              if (actualText != expectedText) {
                return false;
              }
              // Compare attributes for element nodes:
            } else if (actualNode.nodeType == 1) {
              var actualNodeAttributes = attributesForNode(actualNode);
              var expectedNodeAttributes = attributesForNode(expectedNode);
              var desc =
                "node " +
                nodeStr(actualNode) +
                " attributes (" +
                actualNodeAttributes.join(",") +
                ") should match (" +
                expectedNodeAttributes.join(",") +
                ") 1";
              expect(actualNodeAttributes.length, desc).eql(
                expectedNodeAttributes.length
              );
              for (var i = 0; i < actualNodeAttributes.length; i++) {
                var attr = actualNodeAttributes[i].name;
                var actualValue = actualNode.getAttribute(attr);
                var expectedValue = expectedNode.getAttribute(attr);
                expect(
                  expectedValue,
                  "node (" +
                    findableNodeDesc(actualNode) +
                    ") attribute " +
                    attr +
                    " should match"
                ).eql(actualValue);
              }
            }
          } else {
            expect(
              nodeStr(actualNode),
              "Should have a node from both DOMs"
            ).eql(nodeStr(expectedNode));
            return false;
          }
          return true;
        },
        actualDOM,
        expectedDOM
      );
    });

    it("should extract expected title", function () {
      expect(result.title).eql(expectedMetadata.title);
    });

    it("should extract expected byline", function () {
      expect(result.byline).eql(expectedMetadata.byline);
    });

    it("should extract expected excerpt", function () {
      expect(result.excerpt).eql(expectedMetadata.excerpt);
    });

    it("should extract expected site name", function () {
      expect(result.siteName).eql(expectedMetadata.siteName);
    });

    expectedMetadata.dir &&
      it("should extract expected direction", function () {
        expect(result.dir).eql(expectedMetadata.dir);
      });

    expectedMetadata.lang &&
      it("should extract expected language", function () {
        expect(result.lang).eql(expectedMetadata.lang);
      });

    expectedMetadata.publishedTime &&
      it("should extract expected published time", function () {
        expect(result.publishedTime).eql(expectedMetadata.publishedTime);
      });
  });
}

function removeCommentNodesRecursively(node) {
  for (var i = node.childNodes.length - 1; i >= 0; i--) {
    var child = node.childNodes[i];
    if (child.nodeType === child.COMMENT_NODE) {
      node.removeChild(child);
    } else if (child.nodeType === child.ELEMENT_NODE) {
      removeCommentNodesRecursively(child);
    }
  }
}

describe("Readability API", function () {
  describe("#constructor", function () {
    var doc = new JSDOMParser().parse("<html><div>yo</div></html>");
    it("should accept a debug option", function () {
      expect(new Readability(doc)._debug).eql(false);
      expect(new Readability(doc, { debug: true })._debug).eql(true);
    });

    it("should accept a nbTopCandidates option", function () {
      expect(new Readability(doc)._nbTopCandidates).eql(5);
      expect(
        new Readability(doc, { nbTopCandidates: 42 })._nbTopCandidates
      ).eql(42);
    });

    it("should accept a maxElemsToParse option", function () {
      expect(new Readability(doc)._maxElemsToParse).eql(0);
      expect(
        new Readability(doc, { maxElemsToParse: 42 })._maxElemsToParse
      ).eql(42);
    });

    it("should accept a keepClasses option", function () {
      expect(new Readability(doc)._keepClasses).eql(false);
      expect(new Readability(doc, { keepClasses: true })._keepClasses).eql(
        true
      );
      expect(new Readability(doc, { keepClasses: false })._keepClasses).eql(
        false
      );
    });

    it("should accept a allowedVideoRegex option or default it", function () {
      expect(new Readability(doc)._allowedVideoRegex).eql(
        Readability.prototype.REGEXPS.videos
      );
      const allowedVideoRegex = /\/\/mydomain.com\/.*'/;
      expect(
        new Readability(doc, { allowedVideoRegex })._allowedVideoRegex
      ).eql(allowedVideoRegex);
    });
  });

  describe("#parse", function () {
    var exampleSource = testPages[0].source;

    it("shouldn't parse oversized documents as per configuration", function () {
      var doc = new JSDOMParser().parse("<html><div>yo</div></html>");
      expect(function () {
        new Readability(doc, { maxElemsToParse: 1 }).parse();
      }).to.Throw("Aborting parsing document; 2 elements found");
    });

    it("should run _cleanClasses with default configuration", function () {
      var doc = new JSDOMParser().parse(exampleSource);
      var parser = new Readability(doc);

      parser._cleanClasses = sinon.fake();

      parser.parse();

      expect(parser._cleanClasses.called).eql(true);
    });

    it("should run _cleanClasses when option keepClasses = false", function () {
      var doc = new JSDOMParser().parse(exampleSource);
      var parser = new Readability(doc, { keepClasses: false });

      parser._cleanClasses = sinon.fake();

      parser.parse();

      expect(parser._cleanClasses.called).eql(true);
    });

    it("shouldn't run _cleanClasses when option keepClasses = true", function () {
      var doc = new JSDOMParser().parse(exampleSource);
      var parser = new Readability(doc, { keepClasses: true });

      parser._cleanClasses = sinon.fake();

      parser.parse();

      expect(parser._cleanClasses.called).eql(false);
    });

    it("should use custom content serializer sent as option", function () {
      var dom = new JSDOM("My cat: <img src=''>");
      var expected_xhtml =
        '<div xmlns="http://www.w3.org/1999/xhtml" id="readability-page-1" class="page">My cat: <img src="" /></div>';
      var xml = new dom.window.XMLSerializer();
      var content = new Readability(dom.window.document, {
        serializer(el) {
          return xml.serializeToString(el.firstChild);
        },
      }).parse().content;
      expect(content).eql(expected_xhtml);
    });

    it("should use custom video regex sent as option", function () {
      var dom = new JSDOM(
        "<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nunc mollis leo lacus, vitae semper nisl ullamcorper ut.</p>" +
          '<iframe src="https://mycustomdomain.com/some-embeds"></iframe>'
      );
      var expected_xhtml =
        '<div id="readability-page-1" class="page">' +
        "<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nunc mollis leo lacus, vitae semper nisl ullamcorper ut.</p>" +
        '<iframe src="https://mycustomdomain.com/some-embeds"></iframe>' +
        "</div>";
      var content = new Readability(dom.window.document, {
        charThreshold: 20,
        allowedVideoRegex: /.*mycustomdomain.com.*/,
      }).parse().content;
      expect(content).eql(expected_xhtml);
    });
  });

  describe("preserveMath option", function () {
    // Enough ordinary prose to keep the document above the char threshold and
    // make the article a stable top candidate.
    var filler = new Array(8)
      .fill(
        "The quick brown fox jumps over the lazy dog while formulas are preserved."
      )
      .join(" ");

    function parseDoc(bodyHtml, options) {
      var dom = new JSDOM(
        "<!DOCTYPE html><html><head><title>Math article</title></head><body><article><p>" +
          filler +
          "</p>" +
          bodyHtml +
          "</article></body></html>",
        { url: "http://fakehost/test/page.html" }
      );
      return new Readability(
        dom.window.document,
        Object.assign({ charThreshold: 50 }, options)
      ).parse();
    }

    it("should default preserveMath to false", function () {
      var doc = new JSDOM("<html><body><div>yo</div></body></html>").window
        .document;
      expect(new Readability(doc)._preserveMath).eql(false);
      expect(new Readability(doc, { preserveMath: true })._preserveMath).eql(
        true
      );
    });

    it("leaves the default output untouched when preserveMath is off", function () {
      var body =
        "<p>Inline <math><mi>x</mi></math> and " +
        '<script type="math/tex">E=mc^2</script> plus ' +
        "<script>alert(1)</script> done.</p><p>" +
        filler +
        "</p>";
      var off = parseDoc(body);
      var offAgain = parseDoc(body, { preserveMath: false });
      // Math/tex and ordinary scripts are both removed by the default path.
      expect(off.content).eql(offAgain.content);
      expect(off.content).to.not.contain("data-readability-math");
      expect(off.content).to.not.contain("<script");
      expect(off.content).to.not.contain("E=mc^2");
    });

    it("converts MathJax tex scripts into inert code/pre and keeps position", function () {
      var body =
        '<p>Inline <script type="math/tex">E=mc^2</script> and block ' +
        '<script type="math/tex; mode=display">\\int_0^1 x\\,dx</script>.</p>';
      var result = parseDoc(body, { preserveMath: true });
      expect(result.content).to.contain(
        '<code data-readability-math="tex">E=mc^2</code>'
      );
      expect(result.content).to.contain(
        '<pre data-readability-math="tex">\\int_0^1 x\\,dx</pre>'
      );
      // No executable script survives.
      expect(result.content).to.not.match(/<script/);
      // The inline formula precedes the block formula.
      expect(result.content.indexOf("E=mc^2")).to.be.below(
        result.content.indexOf("int_0^1")
      );
    });

    it("accepts math/tex type variants for inline and display math", function () {
      var body =
        '<p><script type="Math/Tex">inl</script>' +
        '<script type=" math/tex ; mode = display ">blk</script>' +
        '<script type="math/tex; mode=text">notmath</script></p>';
      var result = parseDoc(body, { preserveMath: true });
      expect(result.content).to.contain(
        '<code data-readability-math="tex">inl</code>'
      );
      expect(result.content).to.contain(
        '<pre data-readability-math="tex">blk</pre>'
      );
      // A non-display math/tex parameter still qualifies as inline math.
      expect(result.content).to.contain(
        '<code data-readability-math="tex">notmath</code>'
      );
      expect(result.content).to.not.match(/<script/);
    });

    it("still removes ordinary scripts and noscript while preserving math", function () {
      var body =
        '<p>Math <script type="math/tex">x</script> then ' +
        "<script>alert(1)</script><noscript>fallback</noscript>end.</p>";
      var result = parseDoc(body, { preserveMath: true });
      expect(result.content).to.contain(
        '<code data-readability-math="tex">x</code>'
      );
      expect(result.content).to.not.match(/<script/);
      expect(result.content).to.not.contain("alert(1)");
      expect(result.content).to.not.contain("fallback");
    });

    it("keeps MathML and removes the KaTeX visual copy but retains semantics", function () {
      var body =
        '<p><span class="katex"><span class="katex-mathml">' +
        "<math><semantics><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow>" +
        '<annotation encoding="application/x-tex">a+b</annotation>' +
        '<annotation-xml encoding="text/html"><b>vis</b></annotation-xml>' +
        "</semantics></math></span>" +
        '<span class="katex-html" aria-hidden="true">VISUAL-COPY</span></span></p>';
      var result = parseDoc(body, { preserveMath: true });
      expect(result.content).to.contain("<math");
      expect(result.content).to.contain("<mi>a</mi>");
      expect(result.content).to.not.contain("katex");
      expect(result.content).to.not.contain("VISUAL-COPY");
      expect(result.content).to.not.contain("annotation");
      // Marked so it is counted once and recognized as a formula.
      expect(result.content).to.contain('data-readability-math="mathml"');
    });

    it("marks display KaTeX as block math and inline KaTeX as inline", function () {
      var body =
        '<p><span class="katex"><span class="katex-mathml"><math><mi>a</mi></math></span>' +
        '<span class="katex-html" aria-hidden="true">a</span></span>' +
        '<span class="katex katex-display"><span class="katex-mathml">' +
        '<math><mi>b</mi></math></span><span class="katex-html" aria-hidden="true">b</span></span></p>';
      var result = parseDoc(body, { preserveMath: true });
      var inlineMath = result.content.match(
        /<math data-readability-math="mathml"><mi>a<\/mi><\/math>/
      );
      expect(
        inlineMath,
        "inline math must not gain display=block"
      ).to.not.equal(null);
      expect(result.content).to.contain(
        '<math display="block" data-readability-math="mathml"><mi>b</mi></math>'
      );
    });

    it("counts every formula exactly once in textContent and matches length", function () {
      var body =
        "<p>One <math><semantics><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow>" +
        '<annotation encoding="application/x-tex">a+b</annotation></semantics></math>' +
        ' two <script type="math/tex">a+b</script> three.</p>';
      var result = parseDoc(body, { preserveMath: true });
      // The display branch "a+b" and the TeX annotation must not double count,
      // while the separate MathJax formula is a second occurrence.
      expect(result.textContent.match(/a\+b/g)).to.have.length(2);
      expect(result.length).eql(result.textContent.length);
    });

    it("keeps presentational MathML wrappers and their attributes", function () {
      var body =
        '<p><math><mstyle mathcolor="red"><mi>x</mi></mstyle>' +
        "<merror><mtext>err</mtext></merror></math></p>";
      var result = parseDoc(body, { preserveMath: true });
      expect(result.content).to.contain('<mstyle mathcolor="red">');
      expect(result.content).to.contain("<merror>");
    });

    it("prefers TeX comment, then alttext, then display branch text", function () {
      var withComment = parseDoc(
        "<p><math><!-- \\sqrt{x} --><mi>y</mi></math></p>",
        { preserveMath: true }
      );
      expect(withComment.textContent).to.contain("\\sqrt{x}");

      var withAlt = parseDoc(
        '<p><math alttext="x^2"><msup><mi>x</mi><mn>2</mn></msup></math></p>',
        { preserveMath: true }
      );
      expect(withAlt.textContent).to.contain("x^2");

      var branchOnly = parseDoc(
        "<p><math><mfrac><mn>1</mn><mn>2</mn></mfrac></math></p>",
        { preserveMath: true }
      );
      // Display branch contributes its own text once.
      expect(branchOnly.textContent).to.match(/1\s*2/);
      expect(branchOnly.length).eql(branchOnly.textContent.length);
    });

    it("falls back to raw TeX when a math element has no display text", function () {
      // JSDOM parses a text/html annotation's children outside the math tree,
      // so use a TeX-only annotation with an empty display branch wrapper.
      var result = parseDoc(
        '<p><math><semantics><mrow></mrow><annotation encoding="application/x-tex">\\emptyset</annotation></semantics></math></p>',
        { preserveMath: true }
      );
      expect(result.textContent).to.contain("\\emptyset");
    });

    it("keeps hostile TeX as inert escaped text with no live elements", function () {
      var body =
        '<p><script type="math/tex">\\href{javascript:alert(1)}{x} ' +
        '\\"onmouseover=alert(2)\\"</script></p>';
      var result = parseDoc(body, { preserveMath: true });
      // The payload lives inside an inert <code> element as a text node: it
      // never becomes a script, an attribute or an anchor href.
      expect(result.content).to.not.match(/<script/);
      expect(result.content).to.not.match(/<a [^>]*href/i);
      expect(result.content).to.not.contain(" onmouseover=");
      // The TeX source itself is still present as literal text.
      expect(result.textContent).to.contain("javascript:alert(1)");
      expect(result.textContent).to.contain("onmouseover=alert(2)");
    });

    it("does not restore formulas outside the selected article", function () {
      var dom = new JSDOM(
        "<!DOCTYPE html><html><head><title>Math article</title></head><body>" +
          "<article><p>" +
          filler +
          "</p><p>Inside <math><mi>kept</mi></math></p></article>" +
          '<aside class="sidebar"><math><mi>dropped</mi></math>' +
          '<script type="math/tex">\\sqrt{z}</script></aside></body></html>',
        { url: "http://fakehost/test/page.html" }
      );
      var result = new Readability(dom.window.document, {
        preserveMath: true,
        charThreshold: 50,
      }).parse();
      expect(result.content).to.contain("<mi>kept</mi>");
      expect(result.content).to.not.contain("dropped");
      expect(result.content).to.not.contain("sqrt");
    });

    it("preserves math across grabArticle candidate retries", function () {
      // A tiny article forces the char-threshold retry path that restores the
      // cached page innerHTML and re-runs grabArticle with flags removed.
      var dom = new JSDOM(
        "<!DOCTYPE html><html><head><title>Math article</title></head><body>" +
          "<article><p>Short lead.</p>" +
          '<p>Formula <script type="math/tex">E=mc^2</script> and ' +
          "<math><mi>z</mi></math> here.</p></article></body></html>",
        { url: "http://fakehost/test/page.html" }
      );
      var result = new Readability(dom.window.document, {
        preserveMath: true,
        charThreshold: 5000,
      }).parse();
      expect(result, "a result should still be produced").to.not.equal(null);
      expect(result.content).to.contain(
        '<code data-readability-math="tex">E=mc^2</code>'
      );
      expect(result.content).to.contain("<mi>z</mi>");
      expect(result.content).to.not.match(/<script/);
    });

    it("works with a custom serializer", function () {
      var dom = new JSDOM(
        "<!DOCTYPE html><html><body><article><p>" +
          filler +
          "</p><p>Math <math><mi>x</mi></math> inline.</p></article></body></html>",
        { url: "http://fakehost/test/page.html" }
      );
      var xml = new dom.window.XMLSerializer();
      var result = new Readability(dom.window.document, {
        preserveMath: true,
        charThreshold: 50,
        serializer(el) {
          return xml.serializeToString(el.firstChild);
        },
      }).parse();
      // XMLSerializer output is XHTML with explicit namespace.
      expect(result.content).to.contain('xmlns="http://www.w3.org/1999/xhtml"');
      expect(result.content).to.contain("<math");
      expect(result.content).to.contain('data-readability-math="mathml"');
    });
  });
});

describe("Test pages", function () {
  testPages.forEach(function (testPage) {
    describe(testPage.dir, function () {
      var uri = "http://fakehost/test/page.html";
      // The preserve-math page exercises the opt-in formula preservation;
      // every other page keeps the default options so its output is unchanged.
      var options =
        testPage.dir === "preserve-math" ? { preserveMath: true } : {};

      runTestsWithItems(
        "jsdom",
        function (source) {
          var doc = new JSDOM(source, {
            url: uri,
          }).window.document;
          removeCommentNodesRecursively(doc);
          return doc;
        },
        testPage.source,
        testPage.expectedContent,
        testPage.expectedMetadata,
        options
      );

      runTestsWithItems(
        "JSDOMParser",
        function (source) {
          var parser = new JSDOMParser();
          var doc = parser.parse(source, uri);
          if (parser.errorState) {
            console.error("Parsing this DOM caused errors:", parser.errorState);
            return null;
          }
          return doc;
        },
        testPage.source,
        testPage.expectedContent,
        testPage.expectedMetadata,
        options
      );
    });
  });
});
