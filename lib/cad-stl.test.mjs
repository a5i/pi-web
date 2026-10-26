import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseStl, STL_PREVIEW_MAX_TRIANGLES } = await jiti.import("./cad-stl.ts");

function binaryStl(triangles, { header = "", attributeBytes = 0 } = {}) {
  const parts = [Buffer.alloc(80)];
  parts[0].write(header, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(triangles.length);
  parts.push(count);
  for (const triangle of triangles) {
    const record = Buffer.alloc(50);
    record.writeFloatLE(triangle.n[0], 0);
    record.writeFloatLE(triangle.n[1], 4);
    record.writeFloatLE(triangle.n[2], 8);
    triangle.v.forEach((vertex, i) => {
      record.writeFloatLE(vertex[0], 12 + i * 12);
      record.writeFloatLE(vertex[1], 16 + i * 12);
      record.writeFloatLE(vertex[2], 20 + i * 12);
    });
    record.writeUInt16LE(attributeBytes, 48);
    parts.push(record);
  }
  return Buffer.concat(parts);
}

const RIGHT_TRIANGLE = {
  n: [0, 0, 1],
  v: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
};

function asArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

test("parses a binary STL even when its header starts with 'solid'", () => {
  // Broken exporters emit binary files whose 80-byte header opens with the
  // ASCII keyword; the exact length check must win over the text sniff.
  const buffer = binaryStl([RIGHT_TRIANGLE], { header: "solid misleading header" });
  const mesh = parseStl(asArrayBuffer(buffer));
  assert.equal(mesh.format, "binary");
  assert.equal(mesh.triangleCount, 1);
  assert.equal(mesh.truncated, false);
  assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(Array.from(mesh.normals), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual(mesh.bounds, { min: [0, 0, 0], max: [1, 1, 0] });
});

test("computes a binary triangle's normal when the file leaves it zero", () => {
  const zeroNormal = { n: [0, 0, 0], v: [[0, 0, 0], [1, 0, 0], [0, 0, 1]] };
  const mesh = parseStl(asArrayBuffer(binaryStl([zeroNormal])));
  // (1,0,0) x (0,0,1) = (0,-1,0)
  assert.deepEqual(Array.from(mesh.normals.slice(0, 3)), [0, -1, 0]);
});

test("skips corrupt binary facets without poisoning the rest", () => {
  const corrupt = { n: [0, 0, 1], v: [[0, 0, 0], [1, 0, 0], [Number.NaN, 1, 0]] };
  const mesh = parseStl(asArrayBuffer(binaryStl([corrupt, RIGHT_TRIANGLE])));
  assert.equal(mesh.triangleCount, 1);
  assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
});

test("parses an ASCII STL with CRLF lines and scientific notation", () => {
  const text = [
    "solid thing",
    "facet normal 0 0 1",
    "outer loop",
    "vertex 0 0 0",
    "vertex 1.5e0 0 0",
    "vertex 0 2.5 0",
    "endloop",
    "endfacet",
    "endsolid thing",
  ].join("\r\n");
  const mesh = parseStl(asArrayBuffer(new TextEncoder().encode(text)));
  assert.equal(mesh.format, "ascii");
  assert.equal(mesh.triangleCount, 1);
  assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1.5, 0, 0, 0, 2.5, 0]);
  assert.deepEqual(mesh.bounds, { min: [0, 0, 0], max: [1.5, 2.5, 0] });
});

test("computes ASCII normals when a facet leaves the normal zero", () => {
  const text = [
    "solid s",
    "facet normal 0 0 0",
    "outer loop",
    "vertex 0 0 0",
    "vertex 1 0 0",
    "vertex 0 0 1",
    "endloop",
    "endfacet",
    "endsolid s",
  ].join("\n");
  const mesh = parseStl(asArrayBuffer(new TextEncoder().encode(text)));
  assert.equal(mesh.format, "ascii");
  assert.deepEqual(Array.from(mesh.normals.slice(0, 3)), [0, -1, 0]);
});

test("truncates past maxTriangles for both flavors", () => {
  const binary = parseStl(asArrayBuffer(binaryStl([RIGHT_TRIANGLE, RIGHT_TRIANGLE])), { maxTriangles: 1 });
  assert.equal(binary.triangleCount, 1);
  assert.equal(binary.truncated, true);
  assert.equal(binary.positions.length, 9);

  const text = ["solid s"];
  for (let i = 0; i < 2; i++) {
    text.push("facet normal 0 0 1", "outer loop", "vertex 0 0 0", "vertex 1 0 0", "vertex 0 1 0", "endloop", "endfacet");
  }
  text.push("endsolid s");
  const ascii = parseStl(asArrayBuffer(new TextEncoder().encode(text.join("\n"))), { maxTriangles: 1 });
  assert.equal(ascii.triangleCount, 1);
  assert.equal(ascii.truncated, true);
});

test("rejects bytes that are neither flavor", () => {
  assert.throws(() => parseStl(asArrayBuffer(new TextEncoder().encode("just some text, no facets here at all"))), /Not a valid STL/);
  assert.throws(() => parseStl(new ArrayBuffer(8)), /too short/);
  // A binary count that disagrees with the length is not binary, and without
  // "solid" there is no ASCII fallback.
  const buffer = binaryStl([RIGHT_TRIANGLE]);
  buffer.writeUInt32LE(7, 80);
  assert.throws(() => parseStl(asArrayBuffer(buffer)), /Not a valid STL/);
});

test("the shared cap is part of the module contract", () => {
  assert.equal(STL_PREVIEW_MAX_TRIANGLES, 1_000_000);
});
