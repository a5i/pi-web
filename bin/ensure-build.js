"use strict";

// `next start` needs a production build. A git checkout does not have one
// (`.next` only holds dev artifacts there), and the published npm package
// always ships a complete `.next` with no app source to rebuild from. Before
// starting, build when the build id is missing — or when any source a build
// consumes is newer than it, so `npm run start` picks up edits without a
// manual `npm run build` — the same `next build --webpack` the package's own
// build script runs. Installs never trigger either: no source, no staleness.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

/** Directories whose contents a production build consumes. */
const BUILD_SOURCE_ROOTS = ["app", "components", "hooks", "lib", "public", "styles"];
/** Root files a build reads; the ones that exist are checked. */
const BUILD_SOURCE_FILES = [
  "next.config.ts",
  "next.config.js",
  "postcss.config.mjs",
  "tailwind.config.ts",
  "tsconfig.json",
  "package.json",
];

function hasProductionBuild(nextDir) {
  return fs.existsSync(path.join(nextDir, "BUILD_ID"));
}

/** Whether this package carries the app source a build could run on. */
function hasAppSource(pkgDir) {
  return fs.existsSync(path.join(pkgDir, "app"));
}

/** The build id's modification time: when the shipped build was last made. */
function buildIdMtime(nextDir) {
  try {
    return fs.statSync(path.join(nextDir, "BUILD_ID")).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The newest modification time under `dir`, 0 for none. Symlinks are skipped
 * rather than followed, so a link cannot loop the scan out of the tree.
 */
function newestMtimeUnder(dir) {
  let newest = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    let stats;
    try {
      stats = fs.lstatSync(path.join(dir, entry.name));
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      const nested = newestMtimeUnder(path.join(dir, entry.name));
      if (nested > newest) newest = nested;
    } else if (stats.mtimeMs > newest) {
      newest = stats.mtimeMs;
    }
  }
  return newest;
}

/**
 * Whether any source a build consumes is newer than the build in `.next`.
 * A heuristic on modification times: a `git pull`, an edit or a rebuild
 * script touching a file after the last build means the shipped build no
 * longer matches the sources.
 */
function isProductionBuildStale(nextDir, pkgDir) {
  const builtAt = buildIdMtime(nextDir);
  if (builtAt === 0) return false; // "missing", not stale
  for (const root of BUILD_SOURCE_ROOTS) {
    if (newestMtimeUnder(path.join(pkgDir, root)) > builtAt) return true;
  }
  for (const file of BUILD_SOURCE_FILES) {
    try {
      if (fs.lstatSync(path.join(pkgDir, file)).mtimeMs > builtAt) return true;
    } catch {
      // Not present in this checkout: nothing to compare.
    }
  }
  return false;
}

/** "current" | "missing" | "stale" | "no-source", without building anything. */
function productionBuildStatus({ nextDir, pkgDir }) {
  if (!hasAppSource(pkgDir)) {
    return hasProductionBuild(nextDir) ? "current" : "no-source";
  }
  if (!hasProductionBuild(nextDir)) return "missing";
  return isProductionBuildStale(nextDir, pkgDir) ? "stale" : "current";
}

/**
 * Build when `.next` holds no production build, or one older than the
 * sources. `canBuild` (default: allowed) is awaited first: a caller that
 * knows a server holds the port can refuse, because `next build` writes into
 * the same `.next` a dev server is serving from.
 *
 * Returns `{ built: true }` after a successful build, `{ built: false }` when
 * the build is current, `{ built: false, reason: "no-source" }` when there is
 * nothing to build from (a broken install, where `.next` is missing while the
 * source is not shipped: the caller fails the launch with its own message),
 * or `{ built: false, reason: "port-held", stale }` when `canBuild` refused.
 * A failed build throws.
 */
async function ensureProductionBuild({
  nextDir,
  pkgDir,
  runBuild,
  buildArgs = ["build", "--webpack"],
  log = console.log,
  canBuild = async () => true,
}) {
  const status = productionBuildStatus({ nextDir, pkgDir });
  if (status === "current") {
    return { built: false };
  }
  if (status === "no-source") {
    return { built: false, reason: "no-source" };
  }
  if (!(await canBuild())) {
    return { built: false, reason: "port-held", stale: status === "stale" };
  }

  log(status === "stale"
    ? "The build in .next is older than the sources — running next build first…"
    : "No production build found — running next build first (once per clean checkout)…");
  const result = runBuild(buildArgs);
  if (result.status !== 0) {
    const error = new Error(`next build exited with code ${result.status}.`);
    error.code = "ERR_PI_WEB_BUILD_FAILED";
    throw error;
  }
  if (!hasProductionBuild(nextDir)) {
    const error = new Error("next build finished without producing a build id in .next.");
    error.code = "ERR_PI_WEB_BUILD_FAILED";
    throw error;
  }
  return { built: true };
}

module.exports = {
  BUILD_SOURCE_FILES,
  BUILD_SOURCE_ROOTS,
  ensureProductionBuild,
  hasAppSource,
  hasProductionBuild,
  isProductionBuildStale,
  newestMtimeUnder,
  productionBuildStatus,
};
