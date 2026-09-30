import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";

/**
 * Server-side OpenAPI multi-file bundling.
 *
 * Elements parses a single document client-side and cannot fetch sibling files,
 * so specs that spread across files (root.yaml + $ref: './common.yaml#/Pet')
 * are bundled here: @apidevtools/swagger-parser resolves every external ref
 * relative to the root file's real location and inlines it into one document.
 * The bundled spec travels back to the browser as a JSON string, which the
 * preview binds exactly like raw YAML source.
 *
 * Security: the ref parser would happily follow any path a spec names —
 * including absolute paths and `../` escapes — and inline the contents into
 * the rendered docs. Every file read therefore goes through the same
 * allow-list as /api/files (symlinks resolved), and network resolution is
 * disabled so a spec cannot turn the server into an HTTP fetcher.
 */

export const OPENAPI_ROOT_MAX_BYTES = 1024 * 1024;
export const OPENAPI_BUNDLED_MAX_BYTES = 4 * 1024 * 1024;
const OPENAPI_BUNDLE_TIMEOUT_MS = 15_000;
const CACHE_CAPACITY = 16;

declare global {
  var __piOpenApiBundleCache: Map<string, Promise<string>> | undefined;
}

function getCache(): Map<string, Promise<string>> {
  // Survives Next.js hot reload, like every other __pi* registry.
  if (!globalThis.__piOpenApiBundleCache) globalThis.__piOpenApiBundleCache = new Map();
  return globalThis.__piOpenApiBundleCache;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function bundleUncached(rootPath: string, roots: Set<string>): Promise<string> {
  const root = await readFile(rootPath, "utf8");
  if (Buffer.byteLength(root, "utf8") > OPENAPI_ROOT_MAX_BYTES) {
    throw new Error("OpenAPI root file exceeds the bundle size limit");
  }

  // Lazy import keeps the parser out of every server bundle that never
  // touches OpenAPI (same reason as the LikeC4 language services).
  const { default: SwaggerParser } = await import("@apidevtools/swagger-parser");
  const bundled = (await withTimeout(
    SwaggerParser.bundle(rootPath, {
      // A spec must not make the server fetch the network (offline, SSRF).
      resolve: { http: false, file: { read } },
      continueOnError: false,
    }) as Promise<unknown>,
    OPENAPI_BUNDLE_TIMEOUT_MS,
    "OpenAPI bundling timed out",
  )) as object;

  const serialized = JSON.stringify(bundled);
  if (Buffer.byteLength(serialized, "utf8") > OPENAPI_BUNDLED_MAX_BYTES) {
    throw new Error("Bundled spec exceeds the preview size limit");
  }
  return serialized;

  async function read(file: { url: string }): Promise<string> {
    // Node may hand us a file:// URL or a plain absolute path, depending on
    // how the reference reached the resolver.
    const target = file.url.startsWith("file:") ? fileURLToPath(file.url) : file.url;
    // Symlink-resolved check: a link inside the project that points outside
    // every allowed root is refused, exactly like /api/files (#748).
    if (!(await isExistingFilePathAllowed(target, roots))) {
      throw new Error(`$ref target is outside the allowed file roots: ${target}`);
    }
    return readFile(target, "utf8");
  }
}

/**
 * Bundle the spec at `rootPath` into a single JSON document (a string, ready
 * to feed to Elements as `apiDescriptionDocument`). Joins the run already in
 * flight for the same path + root content; bounded LRU like the LikeC4 cache.
 */
export function bundleOpenApiSpec(rootPath: string): Promise<string> {
  const cache = getCache();
  const run = (async () => {
    const roots = await getAllowedFileRoots();
    const root = await readFile(rootPath, "utf8");
    const key = `${rootPath}:${createHash("sha256").update(root).digest("hex")}`;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const entry = bundleUncached(rootPath, roots).catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, entry);
    while (cache.size > CACHE_CAPACITY) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return entry;
  })();
  return run;
}

export function clearOpenApiBundleCache(): void {
  getCache().clear();
}
