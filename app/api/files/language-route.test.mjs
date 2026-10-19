import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";
import { parse, generate } from "sugar-high/core";
import ts from "typescript";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-files-language-")));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./[...path]/route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/allowed-roots.ts");
const { resolveGrammar } = await jiti.import("../../../lib/sugar-high-lang.ts");
allowFileRoot(root);

// A route exports only its handlers, so the extensions it maps come from its source.
const source = fs.readFileSync(new URL("./[...path]/route.ts", import.meta.url), "utf8");
const sourceFile = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
let extensionMap;
sourceFile.forEachChild(function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === "EXT_TO_LANGUAGE") extensionMap = node.initializer;
  else node.forEachChild(visit);
});
assert.ok(extensionMap && ts.isObjectLiteralExpression(extensionMap), "EXT_TO_LANGUAGE not found");
// PDF and Word files are streamed by ?type=read, never shown as source.
const textExtensions = extensionMap.properties
  .map((property) => property.name.text)
  .filter((ext) => ext !== "pdf" && ext !== "docx");
assert.ok(textExtensions.includes("ts") && textExtensions.every(Boolean), "EXT_TO_LANGUAGE keys not read");

async function languageOf(name) {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, "x\n");
  const segments = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const response = await GET(
    new NextRequest("http://localhost/api/files/x?type=read"),
    { params: Promise.resolve({ path: segments }) },
  );
  assert.equal(response.status, 200, name);
  return (await response.json()).language;
}

test("every language a source file gets is a sugar-high grammar or a deliberate plain name", async () => {
  // SugarHighCode renders an unresolvable name as plain text, so a typo shows
  // no error. Everything outside this set must resolve to a grammar; the set
  // holds the map's entries sugar-high has no grammar for yet (they render
  // plain) plus the explicit plain names.
  const plain = new Set([
    "text", "likec4",
    "markup", "objectivec", "elixir", "haskell", "ocaml", "clojure", "nix",
    "scala", "groovy", "perl", "r", "less", "protobuf", "batch", "ini",
    "properties", "latex", "makefile",
  ]);
  const names = [...textExtensions.map((ext) => `sample.${ext}`), "Dockerfile", "Makefile", ".env.local"];
  for (const name of names) {
    const language = await languageOf(name);
    if (!plain.has(language)) assert.notEqual(resolveGrammar(language), null, `${name}: ${language}`);
  }
});

test("only HTML and Markdown files take a language that opens their Preview", async () => {
  const preview = [];
  for (const ext of textExtensions) {
    if (["html", "markdown"].includes(await languageOf(`sample.${ext}`))) preview.push(ext);
  }
  assert.deepEqual(preview.sort(), ["htm", "html", "md", "mdx"]);
  // Templates are not pages: vue and svelte keep their own grammars, and astro
  // (no grammar) takes the markup placeholder that never opens a Preview.
  assert.equal(await languageOf("App.vue"), "vue");
  assert.equal(await languageOf("App.svelte"), "svelte");
  assert.equal(await languageOf("App.astro"), "markup");
});

test("JSX gets its tags colored and an ambiguous extension stays plain", async () => {
  for (const name of ["App.tsx", "App.jsx"]) {
    const grammar = resolveGrammar(await languageOf(name));
    const lines = generate(parse('const a = <a href="x">t</a>;', grammar));
    const classes = new Set();
    (function walk(node) {
      if (node.properties?.className) classes.add(node.properties.className);
      (node.children ?? []).forEach(walk);
    })(lines[0]);
    assert.ok(classes.has("sh__token--entity"), `${name}: tag`);
    assert.ok(classes.has("sh__token--property"), `${name}: attr-name`);
    assert.ok(classes.has("sh__token--string"), `${name}: attr-value`);
  }
  assert.equal(await languageOf("analysis.R"), "r");
  assert.equal(await languageOf("plot.m"), "text");
});
