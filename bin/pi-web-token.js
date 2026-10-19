"use strict";

// The owner's sign-in token for `pi-web --token`: a random secret kept in a
// file under pi's agent directory (like the run records), passed to the Next
// server as PI_WEB_PASSWORD so every existing check covers it — the
// session-cookie signature, Basic Auth for API clients, the login throttle,
// and the MCP stdio env sanitization that never passes PI_WEB_PASSWORD on.
// The file holds the only copy: the launcher prints the sign-in link, but the
// token never lands in run records or any other log.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require("crypto");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getAgentDir } = require("./run-records");

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function generateToken() {
  // 32 random bytes as hex: the same length pi-web's session nonces use.
  return crypto.randomBytes(32).toString("hex");
}

/** PI_WEB_TOKEN_FILE wins; the default sits beside the run records. */
/** The pi-web data directory beside the run records (`<agentDir>/pi-web`). */
function getTokenDataDir(env = process.env, home = os.homedir()) {
  return path.join(getAgentDir(env, home), "pi-web");
}

/** PI_WEB_TOKEN_FILE wins; the default sits beside the run records. */
function getTokenFilePath(env = process.env, home = os.homedir()) {
  if (env.PI_WEB_TOKEN_FILE) {
    return env.PI_WEB_TOKEN_FILE;
  }
  return path.join(getTokenDataDir(env, home), "auth-token");
}

/** The token the file holds, or undefined when there is no file yet. */
function readTokenFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const token = content.trim();
  if (!TOKEN_PATTERN.test(token)) {
    const error = new Error(
      `the token file at ${filePath} does not hold a valid token (expected 64 hex characters). ` +
        "Move the file away, or start with --rotate-token to issue a fresh token.",
    );
    error.code = "ERR_PI_WEB_TOKEN_CORRUPT";
    throw error;
  }
  return token;
}

// Write-and-rename so a concurrent reader (a second launcher, `pi-web open`)
// never sees a half-written token; the temp file carries the mode over.
function writeTokenFile(filePath, token) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });

  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${token}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort: a stray temp file is harmless.
    }
    throw error;
  }
}

/** The existing token, or a fresh one written to disk (`created` says which). */
function readOrCreateToken(filePath) {
  const existing = readTokenFile(filePath);
  if (existing !== undefined) {
    return { token: existing, created: false };
  }
  const token = generateToken();
  writeTokenFile(filePath, token);
  return { token, created: true };
}

/**
 * A fresh token, replacing whatever the file held. Every session cookie and
 * sign-in link that used the old token stops working immediately.
 */
function rotateTokenFile(filePath) {
  const token = generateToken();
  writeTokenFile(filePath, token);
  return token;
}

module.exports = {
  TOKEN_PATTERN,
  generateToken,
  getTokenFilePath,
  readOrCreateToken,
  readTokenFile,
  getTokenDataDir,
  rotateTokenFile,
};
