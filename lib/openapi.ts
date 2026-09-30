/**
 * Detection for OpenAPI (3.x) and Swagger (2.x) documents shown in the file
 * viewer. The server reports yaml/json as the language, so the client sniffs
 * the fetched content itself — no server round-trip or language-map change.
 */

// The version key is conventionally the document's first key, so only the
// head is scanned: deep `openapi:` keys in unrelated files cannot trigger the
// preview, and the scan stays cheap on large files.
const HEAD_LINE_COUNT = 60;

// YAML top-level keys sit at column 0; nested mappings are indented, so
// anchoring at ^ keeps a random nested `openapi:` from matching. The version
// value is quoted or bare and may carry a trailing YAML comment.
const YAML_VERSION_KEY = /^(?:openapi|swagger)\s*:\s*["']?[23](?:\.\d+)*["']?\s*(?:#.*)?$/;

// JSON syntax: quoted key, quoted value. The line is not end-anchored so
// minified specs (`{"openapi":"3.0.3",...}`) match too.
const JSON_VERSION_KEY = /^\s*\{?\s*["'](?:openapi|swagger)["']\s*:\s*["'][23](?:\.\d+)*["']/;

export function isOpenApiSpecContent(content: string): boolean {
  if (!content) return false;
  // A UTF-8 BOM would otherwise hide the version key from the line-start
  // anchors when it sits on line 1.
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/, HEAD_LINE_COUNT);
  for (const line of lines) {
    if (YAML_VERSION_KEY.test(line) || JSON_VERSION_KEY.test(line)) return true;
  }
  return false;
}

// $ref values that do not start with '#' point at other files (or URLs).
// Matches YAML (`$ref: ./common.yaml#/Pet`, quoted or not) and JSON
// (`"$ref": "./common.yaml#/Pet"`); a bare `$ref:` mention in prose at worst
// triggers one server round trip that ends in a graceful fallback.
const REF_VALUE = /\$ref(?![\w-])["']?\s*:\s*["']?([^"'\s][^"'\n}]*)/g;

export function hasExternalRefs(content: string): boolean {
  if (!content) return false;
  REF_VALUE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REF_VALUE.exec(content)) !== null) {
    if (match[1] && !match[1].startsWith("#")) return true;
  }
  return false;
}
