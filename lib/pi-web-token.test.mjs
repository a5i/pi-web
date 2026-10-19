import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  TOKEN_PATTERN,
  generateToken,
  getTokenFilePath,
  readOrCreateToken,
  readTokenFile,
  rotateTokenFile,
} = require("../bin/pi-web-token.js");

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-token-"));
  return { dir, tokenFile: path.join(dir, ".pi", "agent", "pi-web", "auth-token") };
}

test("generates 64-hex-character tokens", () => {
  const token = generateToken();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(token, generateToken());
});

test("resolves the token file beside the run records", () => {
  const home = "/home/example";
  assert.equal(
    getTokenFilePath({}, home),
    path.join(home, ".pi", "agent", "pi-web", "auth-token"),
  );
});

test("PI_WEB_TOKEN_FILE overrides the location", () => {
  const home = "/home/example";
  assert.equal(
    getTokenFilePath({ PI_WEB_TOKEN_FILE: "/tmp/elsewhere" }, home),
    "/tmp/elsewhere",
  );
});

test("PI_CODING_AGENT_DIR moves the token file with the agent directory", () => {
  assert.equal(
    getTokenFilePath({ PI_CODING_AGENT_DIR: "/data/pi" }, "/home/example"),
    path.join("/data/pi", "pi-web", "auth-token"),
  );
});

test("creates a token file on first use and reuses it after", () => {
  const { tokenFile } = tempHome();
  const first = readOrCreateToken(tokenFile);
  assert.equal(first.created, true);
  assert.match(first.token, TOKEN_PATTERN);
  assert.equal((fs.statSync(tokenFile).mode & 0o777), 0o600);

  const second = readOrCreateToken(tokenFile);
  assert.equal(second.created, false);
  assert.equal(second.token, first.token);
});

test("creates the directory with owner-only permissions", () => {
  const { tokenFile } = tempHome();
  readOrCreateToken(tokenFile);
  assert.equal((fs.statSync(path.dirname(tokenFile)).mode & 0o777), 0o700);
});

test("rotation replaces the token and invalidates the old one", () => {
  const { tokenFile } = tempHome();
  const first = readOrCreateToken(tokenFile).token;
  const rotated = rotateTokenFile(tokenFile);

  assert.notEqual(rotated, first);
  assert.equal(readTokenFile(tokenFile), rotated);
  assert.equal(readOrCreateToken(tokenFile).token, rotated);
});

test("rotation works without an existing file", () => {
  const { tokenFile } = tempHome();
  const rotated = rotateTokenFile(tokenFile);
  assert.match(rotated, TOKEN_PATTERN);
  assert.equal(readTokenFile(tokenFile), rotated);
});

test("refuses a corrupt token file instead of regenerating it", () => {
  const { tokenFile } = tempHome();
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, "not-a-token\n", { mode: 0o600 });

  assert.throws(() => readOrCreateToken(tokenFile), /does not hold a valid token.*--rotate-token/s);
  assert.equal(fs.readFileSync(tokenFile, "utf8"), "not-a-token\n");
});

test("a token file with surrounding whitespace is still valid", () => {
  const { tokenFile } = tempHome();
  const token = generateToken();
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, `  ${token}  \n`, { mode: 0o600 });
  assert.equal(readTokenFile(tokenFile), token);
});

test("readTokenFile returns undefined when there is no file", () => {
  const { tokenFile } = tempHome();
  assert.equal(readTokenFile(tokenFile), undefined);
});
