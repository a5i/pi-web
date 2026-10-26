/**
 * STL parsing for the FileViewer's 3D preview.
 *
 * Pure and dependency-free on purpose: an STL file is already the triangle
 * soup the renderer wants, so the browser fetches the raw bytes
 * (`/api/files ?type=download`) and parses them right here — no server route,
 * unlike the LikeC4/OpenAPI previews whose heavy machinery must stay on the
 * server. Both flavors are covered: binary (80-byte header, uint32 little-
 * endian triangle count, then 50 bytes per triangle) and ASCII
 * (`solid … facet normal … vertex … endsolid`). Detection follows the
 * de-facto standard: the binary length check is definitive, because broken
 * exporters emit binary files whose 80-byte header happens to start with
 * "solid"; a length mismatch then falls through to the ASCII parser.
 */

export const STL_PREVIEW_MAX_BYTES = 64 * 1024 * 1024;
export const STL_PREVIEW_MAX_TRIANGLES = 1_000_000;

export type StlFormat = "binary" | "ascii";

export interface StlBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface StlMesh {
  format: StlFormat;
  /** Triangles kept — capped by `maxTriangles`, so this can be less than the file holds. */
  triangleCount: number;
  /** Per-vertex positions, 9 floats per triangle (flat, non-indexed). */
  positions: Float32Array;
  /** Per-vertex normals, 9 floats per triangle: the file's facet normal, or computed when the file leaves it zero. */
  normals: Float32Array;
  bounds: StlBounds;
  /** True when the file holds more triangles than the cap kept. */
  truncated: boolean;
}

export interface ParseStlOptions {
  maxTriangles?: number;
}

const HEADER_BYTES = 80;
const COUNT_BYTES = 4;
const FLOATS_PER_TRIANGLE = 12; // facet normal + 3 vertices
const BINARY_TRIANGLE_BYTES = FLOATS_PER_TRIANGLE * 4 + 2; // + attribute byte count

class StlBoundsBuilder {
  minX = Infinity;
  minY = Infinity;
  minZ = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  maxZ = -Infinity;

  add(x: number, y: number, z: number): void {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (z < this.minZ) this.minZ = z;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
    if (z > this.maxZ) this.maxZ = z;
  }

  build(): StlBounds {
    if (!Number.isFinite(this.minX)) {
      return { min: [0, 0, 0], max: [0, 0, 0] };
    }
    return {
      min: [this.minX, this.minY, this.minZ],
      max: [this.maxX, this.maxY, this.maxZ],
    };
  }
}

/**
 * Writes one triangle's 9 positions and 9 normals. `nx/ny/nz` may be zeros —
 * the normal is then computed from the winding and stays zero only for a
 * degenerate triangle. Returns false when any coordinate is not finite, so a
 * corrupt facet is skipped instead of poisoning the geometry.
 */
function writeTriangle(
  positions: Float32Array,
  normals: Float32Array,
  out: number,
  n: [number, number, number],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
): boolean {
  const coords = [a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]];
  for (let i = 0; i < 9; i++) {
    if (!Number.isFinite(coords[i])) return false;
  }
  let nx = n[0];
  let ny = n[1];
  let nz = n[2];
  if (nx === 0 && ny === 0 && nz === 0) {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    nx = uy * vz - uz * vy;
    ny = uz * vx - ux * vz;
    nz = ux * vy - uy * vx;
  }
  positions.set(coords, out);
  for (let v = 0; v < 3; v++) {
    normals[out + v * 3] = nx;
    normals[out + v * 3 + 1] = ny;
    normals[out + v * 3 + 2] = nz;
  }
  return true;
}

function parseBinaryStl(bytes: Uint8Array, maxTriangles: number): StlMesh | null {
  if (bytes.byteLength < HEADER_BYTES + COUNT_BYTES + BINARY_TRIANGLE_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(HEADER_BYTES, true);
  // The length must account for every triangle exactly; anything else means
  // this is not the binary layout, whatever the header says.
  if (count === 0 || HEADER_BYTES + COUNT_BYTES + count * BINARY_TRIANGLE_BYTES !== bytes.byteLength) {
    return null;
  }

  const kept = Math.min(count, maxTriangles);
  const positions = new Float32Array(kept * 9);
  const normals = new Float32Array(kept * 9);
  const bounds = new StlBoundsBuilder();
  let written = 0;

  for (let t = 0; t < kept; t++) {
    const base = HEADER_BYTES + COUNT_BYTES + t * BINARY_TRIANGLE_BYTES;
    const n: [number, number, number] = [
      view.getFloat32(base, true),
      view.getFloat32(base + 4, true),
      view.getFloat32(base + 8, true),
    ];
    const a: [number, number, number] = [
      view.getFloat32(base + 12, true),
      view.getFloat32(base + 16, true),
      view.getFloat32(base + 20, true),
    ];
    const b: [number, number, number] = [
      view.getFloat32(base + 24, true),
      view.getFloat32(base + 28, true),
      view.getFloat32(base + 32, true),
    ];
    const c: [number, number, number] = [
      view.getFloat32(base + 36, true),
      view.getFloat32(base + 40, true),
      view.getFloat32(base + 44, true),
    ];
    if (!writeTriangle(positions, normals, written * 9, n, a, b, c)) continue;
    bounds.add(a[0], a[1], a[2]);
    bounds.add(b[0], b[1], b[2]);
    bounds.add(c[0], c[1], c[2]);
    written++;
  }

  return {
    format: "binary",
    triangleCount: written,
    positions: written === kept ? positions : positions.subarray(0, written * 9),
    normals: written === kept ? normals : normals.subarray(0, written * 9),
    bounds: bounds.build(),
    truncated: kept < count,
  };
}

/** "solid" (after a BOM and leading whitespace), the ASCII flavor's opening keyword. */
function looksLikeAsciiStl(bytes: Uint8Array): boolean {
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0d || bytes[i] === 0x0a)) {
    i++;
  }
  return (
    bytes[i] === 0x73 // s
    && bytes[i + 1] === 0x6f // o
    && bytes[i + 2] === 0x6c // l
    && bytes[i + 3] === 0x69 // i
    && bytes[i + 4] === 0x64 // d
  );
}

/**
 * One pass counts the `vertex` lines (exact allocation), one fills. Only
 * `facet` and `vertex` lines are tokenized; everything else is skipped by its
 * prefix, so comments and odd whitespace an exporter adds cost nothing.
 */
function parseAsciiStl(bytes: Uint8Array, maxTriangles: number): StlMesh | null {
  const text = new TextDecoder().decode(bytes);

  let vertexCount = 0;
  forLines(text, (line, word0) => {
    if (word0 === "vertex") vertexCount++;
  });
  const triangles = Math.floor(vertexCount / 3);
  if (triangles === 0) return null;

  const kept = Math.min(triangles, maxTriangles);
  const positions = new Float32Array(kept * 9);
  const normals = new Float32Array(kept * 9);
  const bounds = new StlBoundsBuilder();

  let facetNormal: [number, number, number] = [0, 0, 0];
  let current: [number, number, number][] = [];
  let written = 0;
  forLines(text, (line, word0) => {
    if (written >= kept) return;
    if (word0 === "facet") {
      const parts = line.split(/\s+/);
      const nx = Number(parts[2]);
      const ny = Number(parts[3]);
      const nz = Number(parts[4]);
      facetNormal = [Number.isFinite(nx) ? nx : 0, Number.isFinite(ny) ? ny : 0, Number.isFinite(nz) ? nz : 0];
      current = [];
      return;
    }
    if (word0 === "vertex") {
      const parts = line.split(/\s+/);
      current.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
      if (current.length === 3) {
        const [a, b, c] = current;
        if (writeTriangle(positions, normals, written * 9, facetNormal, a, b, c)) {
          bounds.add(a[0], a[1], a[2]);
          bounds.add(b[0], b[1], b[2]);
          bounds.add(c[0], c[1], c[2]);
          written++;
        }
        current = [];
      }
    }
  });

  if (written === 0) return null;
  return {
    format: "ascii",
    triangleCount: written,
    positions: positions.subarray(0, written * 9),
    normals: normals.subarray(0, written * 9),
    bounds: bounds.build(),
    truncated: kept < triangles,
  };
}

function forLines(text: string, visit: (line: string, word0: string) => void): void {
  let start = 0;
  while (start <= text.length) {
    const end = text.indexOf("\n", start);
    const line = (end === -1 ? text.slice(start) : text.slice(start, end)).replace(/\r$/, "").trim();
    if (line) {
      // First word without allocating a token array for skipped lines.
      const space = line.search(/\s/);
      const word0 = space === -1 ? line : line.slice(0, space);
      visit(line, word0);
    }
    if (end === -1 || end === text.length) break;
    start = end + 1;
  }
}

/**
 * Parses an STL file's bytes into flat position/normal arrays ready for a
 * THREE.BufferGeometry. Throws when the bytes are neither STL flavor — the
 * caller shows the message and the Source tab stays available.
 */
export function parseStl(buffer: ArrayBuffer | Uint8Array, options: ParseStlOptions = {}): StlMesh {
  const maxTriangles = options.maxTriangles ?? STL_PREVIEW_MAX_TRIANGLES;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 16) throw new Error("Not an STL file: too short");

  // The binary length check is definitive, so it runs first — a binary file
  // may still open its header with the ASCII "solid" keyword.
  const binary = parseBinaryStl(bytes, maxTriangles);
  if (binary) return binary;

  if (looksLikeAsciiStl(bytes)) {
    const ascii = parseAsciiStl(bytes, maxTriangles);
    if (ascii) return ascii;
  }
  throw new Error("Not a valid STL file");
}
