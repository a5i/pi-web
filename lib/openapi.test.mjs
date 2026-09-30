import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { isOpenApiSpecContent } = await jiti.import("./openapi.ts");

test("detects OpenAPI 3.x YAML documents", () => {
  assert.equal(isOpenApiSpecContent("openapi: 3.0.3\ninfo:\n  title: x\n"), true);
  assert.equal(isOpenApiSpecContent("openapi: 3.1.0\n"), true);
  assert.equal(isOpenApiSpecContent('openapi: "3.0.2"\n'), true);
  assert.equal(isOpenApiSpecContent("openapi: 3.0.0 # the version\npaths: {}\n"), true);
});

test("detects Swagger 2.0 documents", () => {
  assert.equal(isOpenApiSpecContent("swagger: '2.0'\ninfo:\n  title: x\n"), true);
  assert.equal(isOpenApiSpecContent('swagger: "2.0"\n'), true);
});

test("detects JSON documents, including minified ones", () => {
  assert.equal(isOpenApiSpecContent('{\n  "openapi": "3.0.3",\n  "info": {}\n}\n'), true);
  assert.equal(isOpenApiSpecContent('{"openapi":"3.1.0","info":{}}'), true);
  assert.equal(isOpenApiSpecContent('{ "swagger": "2.0" }'), true);
});

test("accepts the version key anywhere in the head, not only line 1", () => {
  const preamble = Array.from({ length: 10 }, (_, i) => `# generated header ${i}`).join("\n");
  assert.equal(isOpenApiSpecContent(`${preamble}\nopenapi: 3.0.3\n`), true);
});

test("handles a UTF-8 BOM before the version key", () => {
  assert.equal(isOpenApiSpecContent("\uFEFFopenapi: 3.0.3\n"), true);
  assert.equal(isOpenApiSpecContent('\uFEFF{"openapi": "3.0.3"}'), true);
});

test("rejects documents without a version key in the head", () => {
  assert.equal(isOpenApiSpecContent(""), false);
  assert.equal(isOpenApiSpecContent("info:\n  title: not a spec\n"), false);
  assert.equal(isOpenApiSpecContent("a: b\nc: d\n"), false);
});

test("rejects nested openapi keys — only column-0 YAML keys count", () => {
  assert.equal(isOpenApiSpecContent("components:\n  openapi: 3.0.3\n"), false);
  assert.equal(isOpenApiSpecContent("  openapi: 3.0.3\n"), false);
});

test("rejects version keys past the head of the file", () => {
  const filler = Array.from({ length: 120 }, (_, i) => `key${i}: value`).join("\n");
  assert.equal(isOpenApiSpecContent(`${filler}\nopenapi: 3.0.3\n`), false);
});

test("rejects keys whose value is not a 2.x/3.x version", () => {
  assert.equal(isOpenApiSpecContent("openapi: true\n"), false);
  assert.equal(isOpenApiSpecContent("openapi: diagrams\n"), false);
  assert.equal(isOpenApiSpecContent('{"openapi": "latest"}'), false);
});
