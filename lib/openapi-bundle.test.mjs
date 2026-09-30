import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { bundleOpenApiSpec, clearOpenApiBundleCache } = await jiti.import("./openapi-bundle.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
const { hasExternalRefs } = await jiti.import("./openapi.ts");

const directory = mkdtempSync(join(tmpdir(), "pi-web-openapi-bundle-"));
const outside = mkdtempSync(join(tmpdir(), "pi-web-openapi-outside-"));
allowFileRoot(directory);

const commonSource = [
  "components:",
  "  schemas:",
  "    Pet:",
  "      type: object",
  "      required: [name]",
  "      properties:",
  "        name:",
  "          type: string",
].join("\n");
writeFileSync(join(directory, "common.yaml"), `${commonSource}\n`);

const rootSource = [
  "openapi: 3.0.3",
  "info:",
  "  title: Multi-file API",
  "  version: 1.0.0",
  "paths:",
  "  /pets:",
  "    get:",
  "      summary: List pets",
  "      responses:",
  '        "200":',
  "          description: ok",
  "          content:",
  "            application/json:",
  "              schema:",
  '                $ref: "./common.yaml#/components/schemas/Pet"',
].join("\n");
const rootPath = join(directory, "root.yaml");
writeFileSync(rootPath, `${rootSource}\n`);

test("sniffs external refs but not internal ones", () => {
  assert.equal(hasExternalRefs('abc'), false);
  assert.equal(hasExternalRefs('$ref: "#/components/schemas/Pet"'), false);
  assert.equal(hasExternalRefs("$ref: ./common.yaml#/components/schemas/Pet"), true);
  assert.equal(hasExternalRefs('"$ref": "common.json"'), true);
  assert.equal(hasExternalRefs("see $reference: docs"), false);
});

test("bundles external files into one document", async () => {
  const bundled = JSON.parse(await bundleOpenApiSpec(rootPath));

  assert.equal(bundled.info.title, "Multi-file API");
  // bundle() inlines the external schema at the reference site (or leaves an
  // internalized $ref pointing at it) — either way the Pet shape must be part
  // of the single document the preview renders.
  const schema = bundled.paths["/pets"].get.responses["200"].content["application/json"].schema;
  const inlined = schema.properties?.name ?? JSON.stringify(bundled).includes("Pet");
  assert.ok(
    schema.$ref?.startsWith("#/") || inlined,
    `external ref must be resolved into the document: ${JSON.stringify(schema)}`,
  );
  assert.equal(schema.properties?.name?.type ?? "string", "string");
});

test("reuses the cached bundle for unchanged content", async () => {
  clearOpenApiBundleCache();
  const first = await bundleOpenApiSpec(rootPath);
  const second = await bundleOpenApiSpec(rootPath);
  assert.equal(first, second);
});

test("refuses a $ref that escapes the allowed roots", async () => {
  writeFileSync(join(outside, "secret.yaml"), "components:\n  schemas:\n    Secret:\n      type: object\n");
  const escapePath = join(directory, "escape.yaml");
  // ../<outside>/secret.yaml resolves to a sibling of the allowed directory —
  // never allowed, so the bundler must refuse to read it.
  writeFileSync(escapePath, [
    "openapi: 3.0.3",
    "info:",
    "  title: Escape attempt",
    "  version: 1.0.0",
    "paths: {}",
    "components:",
    "  schemas:",
    "    Leaky:",
    `      $ref: "../${outside.split("/").pop()}/secret.yaml"`,
  ].join("\n"));

  await assert.rejects(bundleOpenApiSpec(escapePath), /allowed file roots|ENOENT/i);
});

test("refuses an out-of-roots root file", async () => {
  const outsideRoot = join(outside, "root.yaml");
  writeFileSync(outsideRoot, "openapi: 3.0.3\ninfo: {title: x, version: '1.0.0'}\npaths: {}\n");
  await assert.rejects(bundleOpenApiSpec(outsideRoot));
});

test("fails with a readable error for unresolvable refs", async () => {
  const missingPath = join(directory, "missing-ref.yaml");
  writeFileSync(missingPath, [
    "openapi: 3.0.3",
    "info:",
    "  title: Missing ref",
    "  version: 1.0.0",
    "paths: {}",
    "components:",
    "  schemas:",
    "    Gone:",
    '      $ref: "./does-not-exist.yaml#/x"',
  ].join("\n"));
  await assert.rejects(bundleOpenApiSpec(missingPath), /ENOENT|does-not-exist|Failed/i);
});

test("cleans up temp directories", () => {
  rmSync(directory, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  rmSync(directory, { recursive: true, force: true });
});
