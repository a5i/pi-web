import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { markdownMdxPreviewRemarkPlugins, markdownMdxPreviewRehypePlugins } = await jiti.import("./markdown.ts");
const { remarkMdxPlaceholders } = await jiti.import("./markdown-mdx.ts");

function renderMdx(mdx) {
  return renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: markdownMdxPreviewRemarkPlugins,
    rehypePlugins: markdownMdxPreviewRehypePlugins,
  }, mdx));
}

test("flow JSX components render as labeled boxes with markdown children inside", () => {
  const html = renderMdx([
    "<Card title=\"Sales\" columns={3}>",
    "  ## Inside",
    "  Body *text*.",
    "</Card>",
  ].join("\n"));

  assert.match(html, /<div class="mdx-jsx-component">/);
  assert.match(html, /&lt;Card title=&quot;Sales&quot; columns=\{3\}&gt;/);
  assert.match(html, /<h2>Inside<\/h2>/);
  assert.match(html, /<em>text<\/em>/);
});

test("inline JSX components keep their content and show a label", () => {
  const html = renderMdx('Inline <Badge color="red">new</Badge> token.');

  assert.match(html, /<span class="mdx-jsx-component-inline">/);
  assert.match(html, /&lt;Badge color=&quot;red&quot;&gt;/);
  assert.match(html, /new<\/span>/);
});

test("expressions become muted tokens, never executed", () => {
  const html = renderMdx("Value {count} here.\n\n{40 + 2}\n");

  const inlineMatches = html.match(/<code class="mdx-expression">\{count\}<\/code>/g);
  assert.ok(inlineMatches, html);
  assert.match(html, /<code class="mdx-expression">\{40 \+ 2\}<\/code>/);
});

test("import/export statements collapse into one notice chip per block", () => {
  const html = renderMdx([
    'import { Chart } from "./chart"',
    "export const meta = 1",
    "",
    "Text",
  ].join("\n"));

  const chips = html.match(/<div class="mdx-esm-notice mdx-esm-count-2">/g);
  assert.equal(chips?.length, 1, html);
  assert.match(html, /import \{ Chart \} from &quot;\.\/chart&quot;/);
  // The export statement's body is not rendered as content.
  assert.doesNotMatch(html, /meta = 1/);
});

test("regular markdown still renders through the MDX pipeline", () => {
  const html = renderMdx("# Head\n\n**bold** and [link](https://example.com)\n\n```js\nconst x = 1;\n```\n");

  assert.match(html, /<h1>Head<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<a href="https:\/\/example\.com">link<\/a>/);
  assert.match(html, /language-js/);
});

test("placeholder markers survive rehype-sanitize", () => {
  const html = renderMdx('import { X } from "y"\n\n<Box>hi</Box> {expr}');
  // rehype-sanitize keeps className only where the MDX schema allows it; these
  // markers are what the FileViewer CSS keys on.
  for (const marker of ["mdx-esm-notice", "mdx-jsx-component", "mdx-jsx-component-inline", "mdx-expression"]) {
    assert.ok(html.includes(marker), `${marker} missing from ${html}`);
  }
});

test("sanitized attribute injection cannot forge placeholder classes through raw content", () => {
  // The MDX pipeline disables raw HTML, so a class written in the document
  // never reaches an element the plugin did not create.
  const html = renderMdx('<span className="mdx-esm-notice">fake</span>');
  assert.match(html, /<span class="mdx-jsx-component-inline">/);
  assert.doesNotMatch(html, /class="mdx-esm-notice"/);
});

test("malformed MDX throws during parse so the viewer's boundary can fall back", () => {
  // remark-mdx reports invalid expressions/JSX as VFileMessage; ReactMarkdown
  // surfaces it synchronously and MdxPreviewBoundary swaps in the plain
  // markdown pipeline. Asserting the throws keeps that contract visible.
  for (const broken of ["text { var } end", "<Card>\nnever closed", "text { count end"]) {
    assert.throws(() => renderMdx(broken), undefined, broken);
  }
});

test("remarkMdxPlaceholders is exported for direct pipeline composition", () => {
  assert.equal(typeof remarkMdxPlaceholders, "function");
});
