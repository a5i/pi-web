import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { getHelpText, parseLaunchOptions } = require("../bin/pi-web-options.js");
const cliPath = fileURLToPath(new URL("../bin/pi-web.js", import.meta.url));

test("opens the browser by default", () => {
  assert.deepEqual(parseLaunchOptions([], {}), {
    help: false,
    port: "30141",
    hostname: "127.0.0.1",
    hostnameExplicit: false,
    openBrowser: true,
    tokenAuth: false,
    rotateToken: false,
    yes: false,
  });
});

test("supports --help and -h without starting the server", () => {
  assert.deepEqual(parseLaunchOptions(["--help"], {}), { help: true });
  assert.deepEqual(parseLaunchOptions(["-h"], {}), { help: true });
  assert.match(getHelpText(), /Usage: pi-web/);
  assert.match(getHelpText(), /--port/);
  assert.match(getHelpText(), /--hostname/);
  assert.match(getHelpText(), /--no-open/);
  assert.match(getHelpText(), /PI_WEB_SKIP_VERSION_CHECK/);
  assert.match(getHelpText(), /PI_WEB_IDLE_TIMEOUT_MS/);
  assert.match(getHelpText(), /PI_WEB_APP_NAME/);
});

test("rejects unknown options with a help hint", () => {
  assert.throws(
    () => parseLaunchOptions(["--unknown-flag"], {}),
    /Use --help to see available options/,
  );
});

test("rejects unexpected positional arguments", () => {
  assert.throws(
    () => parseLaunchOptions(["start"], {}),
    /Unexpected argument/,
  );
});

test("CLI writes help and parse errors before exiting", () => {
  const help = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: pi-web/);
  assert.match(help.stdout, /PI_WEB_APP_NAME/);

  const invalid = spawnSync(process.execPath, [cliPath, "--unknown-flag"], {
    encoding: "utf8",
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Use --help to see available options/);
});

test("supports the no-open CLI option", () => {
  assert.equal(parseLaunchOptions(["--no-open"], {}).openBrowser, false);
});

test("supports truthy PI_WEB_NO_OPEN values", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(parseLaunchOptions([], { PI_WEB_NO_OPEN: value }).openBrowser, false);
  }
});

test("does not disable browser opening for false PI_WEB_NO_OPEN values", () => {
  for (const value of ["0", "false", "off", ""]) {
    assert.equal(parseLaunchOptions([], { PI_WEB_NO_OPEN: value }).openBrowser, true);
  }
});

test("preserves port and hostname options", () => {
  assert.deepEqual(
    parseLaunchOptions(["-p", "8080", "-H", "0.0.0.0"], {}),
    {
      help: false,
      port: "8080",
      hostname: "0.0.0.0",
      openBrowser: true,
      port: "8080",
      hostname: "0.0.0.0",
      hostnameExplicit: true,
      openBrowser: true,
      tokenAuth: false,
      rotateToken: false,
      yes: false,
    },
  );
});

test("rejects port values that could inject cmd arguments", () => {
  assert.throws(
    () => parseLaunchOptions(["-p", "30141&whoami"], {}),
    /Port must be a non-negative integer/,
  );
  assert.throws(
    () => parseLaunchOptions([], { PORT: "30141&whoami" }),
    /Port must be a non-negative integer/,
  );
});

test("supports PI_WEB_HOSTNAME without trusting the ambient system HOSTNAME", () => {
  assert.equal(
    parseLaunchOptions([], { HOSTNAME: "container-id" }).hostname,
    "127.0.0.1",
  );
  assert.equal(
    parseLaunchOptions([], { PI_WEB_HOSTNAME: "0.0.0.0" }).hostname,
    "0.0.0.0",
  );
});

test("--token enables token auth", () => {
  const parsed = parseLaunchOptions(["--token"], {});
  assert.equal(parsed.tokenAuth, true);
  assert.equal(parsed.rotateToken, false);
});

test("--rotate-token implies token auth and rotation", () => {
  const parsed = parseLaunchOptions(["--rotate-token"], {});
  assert.equal(parsed.tokenAuth, true);
  assert.equal(parsed.rotateToken, true);
});

test("--token-file is carried through when given", () => {
  const parsed = parseLaunchOptions(["--token", "--token-file", "/tmp/tok"], {});
  assert.equal(parsed.tokenFile, "/tmp/tok");
  assert.equal("tokenFile" in parseLaunchOptions(["--token"], {}), false);
});

test("--token refuses a simultaneously set PI_WEB_PASSWORD", () => {
  assert.throws(
    () => parseLaunchOptions(["--token"], { PI_WEB_PASSWORD: "hunter2" }),
    /PI_WEB_PASSWORD must not also be set/,
  );
  assert.throws(
    () => parseLaunchOptions(["--rotate-token"], { PI_WEB_PASSWORD: "hunter2" }),
    /PI_WEB_PASSWORD must not also be set/,
  );
});

test("help text mentions the token options", () => {
  assert.match(getHelpText(), /--token\b/);
  assert.match(getHelpText(), /--rotate-token/);
  assert.match(getHelpText(), /PI_WEB_TOKEN_FILE/);
});

test("--access is carried through when given", () => {
  assert.equal(parseLaunchOptions(["--access", "tailscale"], {}).access, "tailscale");
  assert.equal("access" in parseLaunchOptions([], {}), false);
});

test("PI_WEB_ACCESS is used when --access is omitted", () => {
  assert.equal(parseLaunchOptions([], { PI_WEB_ACCESS: "lan" }).access, "lan");
});

test("--access rejects unknown modes", () => {
  assert.throws(
    () => parseLaunchOptions(["--access", "wifi"], {}),
    /Access must be one of: local, lan, cloudflare, tailscale/,
  );
  assert.throws(
    () => parseLaunchOptions([], { PI_WEB_ACCESS: "wifi" }),
    /Access must be one of/,
  );
});

test("an explicit hostname is visible to the access flow", () => {
  assert.equal(parseLaunchOptions(["-H", "10.0.0.5"], {}).hostnameExplicit, true);
  assert.equal(parseLaunchOptions([], { PI_WEB_HOSTNAME: "10.0.0.5" }).hostnameExplicit, true);
  assert.equal(parseLaunchOptions([], {}).hostnameExplicit, false);
});

test("-y skips the access menu", () => {
  assert.equal(parseLaunchOptions(["-y"], {}).yes, true);
  assert.equal(parseLaunchOptions(["--access", "lan"], {}).yes, false);
});

test("help text mentions the access options", () => {
  assert.match(getHelpText(), /--access <mode>/);
  assert.match(getHelpText(), /PI_WEB_ACCESS/);
  assert.match(getHelpText(), /-y\s+Reuse the last access choice/);
});
