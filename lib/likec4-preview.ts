import { createHash } from "crypto";

/**
 * Server-side LikeC4 (.c4) preview computation.
 *
 * Parsing and Graphviz layout run in Node through @likec4/language-services'
 * headless `fromSource()` API; the browser only receives the layouted views and
 * renders them with @likec4/diagram. The whole likec4 + langium + wasm-graphviz
 * stack therefore stays on the server — importing it from client code would
 * drag Vite/Node-only pieces into the browser bundle.
 *
 * The `likec4` CLI package is deliberately not used: it additionally depends on
 * vite, esbuild and playwright, none of which a preview needs.
 */

export const LIKEC4_PREVIEW_MAX_BYTES = 1024 * 1024;
const LIKEC4_COMPUTE_TIMEOUT_MS = 15_000;
const CACHE_CAPACITY = 16;

export interface LikeC4Diagnostic {
  message: string;
  line: number;
  character: number;
  severity: "error" | "warning";
}

export interface LikeC4PreviewResult {
  views: unknown[];
  diagnostics: LikeC4Diagnostic[];
  /** True when views exist despite diagnostics — errors already exclude broken views. */
  partial: boolean;
}

interface RawDiagnostic {
  message?: unknown;
  line?: unknown;
  severity?: unknown;
  range?: {
    start?: { character?: unknown };
  };
}

declare global {
  var __piLikeC4PreviewCache: Map<string, Promise<LikeC4PreviewResult>> | undefined;
}

function getCache(): Map<string, Promise<LikeC4PreviewResult>> {
  // Survives Next.js hot reload, like every other __pi* registry.
  if (!globalThis.__piLikeC4PreviewCache) globalThis.__piLikeC4PreviewCache = new Map();
  return globalThis.__piLikeC4PreviewCache;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function toDiagnostic(raw: RawDiagnostic): LikeC4Diagnostic | null {
  const message = typeof raw.message === "string" ? raw.message : null;
  if (!message) return null;
  const line = typeof raw.line === "number" ? raw.line : 0;
  const character = typeof raw.range?.start?.character === "number" ? raw.range.start.character : 0;
  return {
    message,
    line,
    character,
    severity: raw.severity === 1 ? "error" : "warning",
  };
}

async function computeUncached(content: string): Promise<LikeC4PreviewResult> {
  // Lazy import keeps langium/graphviz out of the server bundle for requests
  // that never touch LikeC4, and gives ESM-only exports a dynamic boundary.
  const { fromSource } = await import("@likec4/language-services/node");
  const likec4 = await withTimeout(fromSource(content), LIKEC4_COMPUTE_TIMEOUT_MS, "LikeC4 parse timed out");

  let views: unknown[] = [];
  try {
    // Diagrams that fail to compute are absent rather than fatal: the first
    // parse error usually invalidates every view in the file.
    try {
      views = await withTimeout(likec4.diagrams(), LIKEC4_COMPUTE_TIMEOUT_MS, "LikeC4 layout timed out");
    } catch {
      views = [];
    }
    const diagnostics = likec4
      .getErrors()
      .map(toDiagnostic)
      .filter((d): d is LikeC4Diagnostic => d !== null)
      .slice(0, 50);
    return { views, diagnostics, partial: views.length > 0 && diagnostics.length > 0 };
  } finally {
    await likec4.dispose().catch(() => {});
  }
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

/**
 * Compute layouted views for a .c4 source, or join the computation already
 * running for identical content. Results stay cached (bounded) so flipping
 * between views or re-opening the file is instant; a watch-triggered reload
 * with unchanged content reuses the same entry.
 */
export function computeLikeC4Preview(content: string): Promise<LikeC4PreviewResult> {
  const cache = getCache();
  const key = contentHash(content);
  const cached = cache.get(key);
  if (cached) {
    // Refresh insertion order so eviction is LRU, not FIFO.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const entry = computeUncached(content).catch((error: unknown) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, entry);

  // A failed computation must not evict working entries; drop the oldest
  // entries beyond capacity.
  while (cache.size > CACHE_CAPACITY) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return entry;
}

export function clearLikeC4PreviewCache(): void {
  getCache().clear();
}
