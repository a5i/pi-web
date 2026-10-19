"use strict";

// `next start` needs a production build, which a git checkout does not have:
// `.next` only holds dev artifacts there (and the published npm package
// always ships a complete `.next`, so building never triggers in installs).
// Before starting, build once when the build id is missing — the same
// `next build --webpack` the package's own build script runs — so
// `npm run start` works straight after `npm install`.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

function hasProductionBuild(nextDir) {
  return fs.existsSync(path.join(nextDir, "BUILD_ID"));
}

/** Whether this package carries the app source a build could run on. */
function hasAppSource(pkgDir) {
  return fs.existsSync(path.join(pkgDir, "app"));
}

/**
 * Build when `.next` holds no production build.
 *
 * Returns `{ built: true }` after a successful build, or `{ built: false }`
 * when one is already there. `{ built: false, reason: "no-source" }` means
 * there is nothing to build from (a broken install, where `.next` is missing
 * while the source is not shipped): the caller fails the launch with its own
 * message. A failed build throws.
 */
function ensureProductionBuild({
  nextDir,
  pkgDir,
  runBuild,
  buildArgs = ["build", "--webpack"],
  log = console.log,
}) {
  if (hasProductionBuild(nextDir)) {
    return { built: false };
  }
  if (!hasAppSource(pkgDir)) {
    return { built: false, reason: "no-source" };
  }

  log("No production build found — running next build first (once per clean checkout)…");
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

module.exports = { ensureProductionBuild, hasAppSource, hasProductionBuild };
