import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { resolveGrammar } = await jiti.import("../lib/sugar-high-lang.ts");
const { dartParseOptions } = await jiti.import("../lib/lang-dart.ts");
const { parse, generate } = await jiti.import("sugar-high/core");
const { SugarHighCode } = await jiti.import("./SugarHighCode.tsx");

function renderCode(props) {
  return renderToStaticMarkup(createElement(SugarHighCode, props));
}

function lineNumbers(html) {
  return [...html.matchAll(/data-line-number="(\d+)"/g)].map((match) => Number(match[1]));
}

test("resolveGrammar maps aliases and extensions to sugar-high configs", () => {
  assert.ok(resolveGrammar("ts"));
  assert.ok(resolveGrammar("typescript"));
  assert.equal(resolveGrammar("bash"), resolveGrammar("shell"));
  assert.equal(resolveGrammar("py"), resolveGrammar("python"));
  assert.equal(resolveGrammar("TypeScript"), resolveGrammar("typescript"));
  assert.ok(resolveGrammar("c"));
});

test("resolveGrammar serves the custom Dart grammar and null for unknown names", () => {
  assert.equal(resolveGrammar("dart"), dartParseOptions);
  assert.equal(resolveGrammar("nope"), null);
  assert.equal(resolveGrammar(""), null);
  assert.equal(resolveGrammar(undefined), null);
  // "text" is sugar-high's built-in plaintext alias; the component intercepts
  // plaintext names before reaching resolveGrammar (see PLAINTEXT_LANGUAGES).
  assert.ok(resolveGrammar("text"));
});

test("dart grammar highlights keywords, comments and triple-quoted strings", () => {
  const code = [
    "class Foo extends StatelessWidget {",
    "  // greeting text",
    "  final String name = 'world';",
    "}",
  ].join("\n");
  const tokens = generate(parse(code, dartParseOptions))
    .flatMap((line) => line.children.map((token) => [token.tokenType, token.children.map((child) => child.value).join("")]));
  assert.ok(tokens.some(([type, value]) => type === "keyword" && value === "class"));
  assert.ok(tokens.some(([type, value]) => type === "keyword" && value === "extends"));
  assert.ok(tokens.some(([type, value]) => type === "comment" && value.includes("greeting text")));
  assert.ok(tokens.some(([type, value]) => type === "string" && value === "'world'"));
  assert.ok(tokens.some(([type, value]) => type === "class" && value === "Foo"));
});

test("dart grammar consumes multi-line triple-quoted strings as strings", () => {
  const code = "var s = '''\nhello\nworld''';";
  const stringTokens = generate(parse(code, dartParseOptions))
    .flatMap((line) => line.children.filter((token) => token.tokenType === "string"));
  assert.ok(stringTokens.length >= 3);
  assert.ok(generate(parse(code, dartParseOptions)).length === 3);
});

test("renders the file-source-line DOM contract with numbered lines", () => {
  const html = renderCode({
    code: "const a = 1;\nconst b = 2;",
    lang: "javascript",
    lineNumbers: true,
  });
  assert.deepEqual(lineNumbers(html), [1, 2]);
  assert.ok(html.includes('class="file-source-line"'));
  assert.ok(html.includes("file-source-line-content"));
  assert.ok(html.includes("sh__token--keyword"));
});

test("trailing newline keeps line numbering in sync with a split('\\n')", () => {
  const code = "const a = 1;\nconst b = 2;\n";
  const html = renderCode({ code, lang: "javascript" });
  assert.equal(lineNumbers(html).length, code.split("\n").length);
});

test("unknown and plaintext languages render plain text without token spans", () => {
  for (const lang of ["text", "plaintext", "likec4", "mermaid", "nope"]) {
    const html = renderCode({ code: "a\nb", lang });
    assert.deepEqual(lineNumbers(html), [1, 2], lang);
    assert.ok(!html.includes("sh__token"), lang);
    assert.ok(html.includes("file-source-line"), lang);
  }
});

test("markup in code is escaped, not injected", () => {
  const html = renderCode({ code: '<img src=x onerror="alert(1)">', lang: "javascript" });
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;"));
  assert.ok(html.includes("onerror"));
});
