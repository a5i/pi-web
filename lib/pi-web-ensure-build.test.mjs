import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { ensureProductionBuild, hasAppSource, hasProductionBuild } = require("../bin/ensure-build.js");

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-build-"));
  const pkgDir = path.join(root, "pkg");
  fs.mkdirSync(pkgDir, { recursive: true });
  return { root, pkgDir, nextDir: path.join(pkgDir, ".next") };
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

test("skips the build when a production build is already there", () => {
  const { pkgDir, nextDir } = tempDirs();
  fs.mkdirSync(path.join(pkgDir, "app"));
  fs.mkdirSync(nextDir);
  fs.writeFileSync(path.join(nextDir, "BUILD_ID"), "xyz\n");

  const calls = [];
  assert.deepEqual(
    ensureProductionBuild({ nextDir, pkgDir, runBuild: (args) => (calls.push(args), { status: 0 }) }),
    { built: false },
  );
  assert.equal(calls.length, 0);
});

test("no source to build from asks the caller to fail the launch", () => {
  const { pkgDir, nextDir } = tempDirs();
  fs.mkdirSync(nextDir);
  assert.deepEqual(
    ensureProductionBuild({ nextDir, pkgDir, runBuild: () => assert.fail("must not build") }),
    { built: false, reason: "no-source" },
  );
});

test("builds with the webpack build args when the build id is missing", () => {
  const { pkgDir, nextDir } = tempDirs();
  fs.mkdirSync(path.join(pkgDir, "app"));
  fs.mkdirSync(nextDir);

  const calls = [];
  const messages = [];
  const result = ensureProductionBuild({
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

test("a failed build throws instead of starting a broken server", () => {
  const { pkgDir, nextDir } = tempDirs();
  fs.mkdirSync(path.join(pkgDir, "app"));
  fs.mkdirSync(nextDir);

  assert.throws(
    () => ensureProductionBuild({ nextDir, pkgDir, runBuild: () => ({ status: 1 }) }),
    /next build exited with code 1/,
  );
});

test("a build that produces no build id throws", () => {
  const { pkgDir, nextDir } = tempDirs();
  fs.mkdirSync(path.join(pkgDir, "app"));
  fs.mkdirSync(nextDir);

  assert.throws(
    () => ensureProductionBuild({ nextDir, pkgDir, runBuild: () => ({ status: 0 }) }),
    /without producing a build id/,
  );
});
