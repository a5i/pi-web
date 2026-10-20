import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  ensureProductionBuild,
  hasAppSource,
  hasProductionBuild,
  isProductionBuildStale,
  productionBuildStatus,
} = require("../bin/ensure-build.js");

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-build-"));
  const pkgDir = path.join(root, "pkg");
  fs.mkdirSync(pkgDir, { recursive: true });
  return { root, pkgDir, nextDir: path.join(pkgDir, ".next") };
}

/** Sets a file's timestamps `secondsAfter` the epoch-relative `base` instant. */
function aged(file, baseMs, secondsAfter) {
  const at = new Date(baseMs + secondsAfter * 1000);
  fs.utimesSync(file, at, at);
}

test("hasProductionBuild follows BUILD_ID", () => {
  const { root } = tempDirs();
  const nextDir = path.join(root, ".next");
  fs.mkdirSync(nextDir);
  assert.equal(hasProductionBuild(nextDir), false);
  fs.writeFileSync(path.join(nextDir, "BUILD_ID"), "xyz\n");
  assert.equal(hasProductionBuild(nextDir), true);
});

test("hasAppSource looks for the app directory", () => {
  const { pkgDir } = tempDirs();
  assert.equal(hasAppSource(pkgDir), false);
  fs.mkdirSync(path.join(pkgDir, "app"));
  assert.equal(hasAppSource(pkgDir), true);
});

test("skips the build when a production build is already there", async () => {
  const { pkgDir, nextDir } = tempDirs();
  fs.mkdirSync(path.join(pkgDir, "app"));
  fs.mkdirSync(nextDir);
  fs.writeFileSync(path.join(nextDir, "BUILD_ID"), "xyz\n");

  const calls = [];
  assert.deepEqual(
    await ensureProductionBuild({ nextDir, pkgDir, runBuild: (args) => (calls.push(args), { status: 0 }) }),
    { built: false },
  );
  assert.equal(calls.length, 0);
});

test("no source to build from asks the caller to fail the launch", async () => {
  const { pkgDir, nextDir } = tempDirs();
  fs.mkdirSync(nextDir);
  assert.deepEqual(
    await ensureProductionBuild({ nextDir, pkgDir, runBuild: () => assert.fail("must not build") }),
    { built: false, reason: "no-source" },
  );
});

test("builds with the webpack build args when the build id is missing", async () => {
  const { pkgDir, nextDir } = tempDirs();
  fs.mkdirSync(path.join(pkgDir, "app"));
  fs.mkdirSync(nextDir);

  const calls = [];
  const messages = [];
  const result = await ensureProductionBuild({
    nextDir,
    pkgDir,
    runBuild: (args) => {
      calls.push(args);
      fs.writeFileSync(path.join(nextDir, "BUILD_ID"), "fresh\n");
      return { status: 0 };
    },
    log: (m) => messages.push(m),
  });

  assert.deepEqual(result, { built: true });
  assert.deepEqual(calls, [["build", "--webpack"]]);
  assert.match(messages.join("\n"), /running next build first/);
});

test("a failed build throws instead of starting a broken server", async () => {
  const { pkgDir, nextDir } = tempDirs();
  fs.mkdirSync(path.join(pkgDir, "app"));
  fs.mkdirSync(nextDir);

  await assert.rejects(
    () => ensureProductionBuild({ nextDir, pkgDir, runBuild: () => ({ status: 1 }) }),
    /next build exited with code 1/,
  );
});

test("a build that produces no build id throws", async () => {
  const { pkgDir, nextDir } = tempDirs();
  fs.mkdirSync(path.join(pkgDir, "app"));
  fs.mkdirSync(nextDir);

  await assert.rejects(
    () => ensureProductionBuild({ nextDir, pkgDir, runBuild: () => ({ status: 0 }) }),
    /without producing a build id/,
  );
});

test("a source newer than the build id makes the build stale and rebuilds", async () => {
  const { pkgDir, nextDir } = tempDirs();
  fs.mkdirSync(path.join(pkgDir, "app"), { recursive: true });
  fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
  fs.mkdirSync(nextDir);
  const base = Date.now() - 60_000;
  fs.writeFileSync(path.join(pkgDir, "app", "page.tsx"), "x");
  aged(path.join(pkgDir, "app", "page.tsx"), base, 0);
  fs.writeFileSync(path.join(pkgDir, "lib", "helper.ts"), "x");
  aged(path.join(pkgDir, "lib", "helper.ts"), base, 0);
  fs.writeFileSync(path.join(nextDir, "BUILD_ID"), "id\n");
  aged(path.join(nextDir, "BUILD_ID"), base, 10);

  assert.equal(productionBuildStatus({ nextDir, pkgDir }), "current");
  assert.equal(isProductionBuildStale(nextDir, pkgDir), false);

  // An edit after the build: stale, and the rebuild runs with its own message.
  fs.writeFileSync(path.join(pkgDir, "lib", "edit.ts"), "y");
  aged(path.join(pkgDir, "lib", "edit.ts"), base, 20);
  assert.equal(productionBuildStatus({ nextDir, pkgDir }), "stale");

  const messages = [];
  const result = await ensureProductionBuild({
    nextDir,
    pkgDir,
    runBuild: () => {
      fs.writeFileSync(path.join(nextDir, "BUILD_ID"), "fresh\n");
      return { status: 0 };
    },
    log: (m) => messages.push(m),
  });
  assert.deepEqual(result, { built: true });
  assert.match(messages.join("\n"), /older than the sources/);
  assert.equal(productionBuildStatus({ nextDir, pkgDir }), "current");
});

test("a newer root config file also marks the build stale", () => {
  const { pkgDir, nextDir } = tempDirs();
  fs.mkdirSync(path.join(pkgDir, "app"));
  fs.mkdirSync(nextDir);
  const base = Date.now() - 60_000;
  fs.writeFileSync(path.join(nextDir, "BUILD_ID"), "id\n");
  aged(path.join(nextDir, "BUILD_ID"), base, 0);
  fs.writeFileSync(path.join(pkgDir, "next.config.ts"), "export {};");
  aged(path.join(pkgDir, "next.config.ts"), base, 30);
  assert.equal(productionBuildStatus({ nextDir, pkgDir }), "stale");
});

test("a refused rebuild reports the port is held and keeps the build", async () => {
  const { pkgDir, nextDir } = tempDirs();
  fs.mkdirSync(path.join(pkgDir, "app"), { recursive: true });
  fs.mkdirSync(nextDir);
  fs.writeFileSync(path.join(nextDir, "BUILD_ID"), "id\n");
  aged(path.join(nextDir, "BUILD_ID"), Date.now() - 60_000, 0);
  fs.writeFileSync(path.join(pkgDir, "app", "page.tsx"), "newer");

  const calls = [];
  assert.deepEqual(
    await ensureProductionBuild({
      nextDir,
      pkgDir,
      runBuild: (args) => (calls.push(args), { status: 0 }),
      canBuild: async () => false,
      log: () => assert.fail("must not log a build it refuses"),
    }),
    { built: false, reason: "port-held", stale: true },
  );
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(path.join(nextDir, "BUILD_ID"), "utf8"), "id\n");
});

test("symlinked directories in the source roots never loop the staleness scan", () => {
  const { pkgDir, nextDir } = tempDirs();
  fs.mkdirSync(path.join(pkgDir, "app"));
  fs.mkdirSync(nextDir);
  fs.writeFileSync(path.join(pkgDir, "app", "page.tsx"), "x");
  fs.writeFileSync(path.join(nextDir, "BUILD_ID"), "id\n");
  // A link back to the package root would recurse forever if followed.
  fs.symlinkSync(pkgDir, path.join(pkgDir, "app", "loop"), "dir");
  assert.equal(isProductionBuildStale(nextDir, pkgDir), false);
});
