import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  CloudflareTunnel,
  bindHost,
  chooseAccess,
  cloudflaredSource,
  findCloudflared,
  isAccessMode,
  isTailscaleAddress,
  lanAddresses,
  loadAccessSettings,
  saveAccessSettings,
  tailscaleAddress,
} = require("../bin/access.js");

const INTERFACES = {
  lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
  eth0: [{ family: "IPv4", address: "192.168.1.123", internal: false }],
  docker0: [{ family: "IPv4", address: "172.17.0.1", internal: false }],
  tailscale0: [{ family: "IPv4", address: "100.127.92.41", internal: false }],
  eth0v6: [{ family: "IPv6", address: "fd00::42", internal: false }],
};

test("recognizes Tailscale's 100.64.0.0/10 range", () => {
  assert.equal(isTailscaleAddress("100.64.0.1"), true);
  assert.equal(isTailscaleAddress("100.127.92.41"), true);
  assert.equal(isTailscaleAddress("100.63.255.255"), false);
  assert.equal(isTailscaleAddress("100.128.0.1"), false);
  assert.equal(isTailscaleAddress("192.168.1.123"), false);
});

test("lan addresses exclude Tailscale and internals", () => {
  assert.deepEqual(lanAddresses(INTERFACES), ["192.168.1.123", "172.17.0.1"]);
});

test("the tailscale address prefers the interface named for it", () => {
  assert.equal(tailscaleAddress(INTERFACES), "100.127.92.41");
  assert.equal(
    tailscaleAddress({ something: [{ family: "IPv4", address: "100.100.0.5", internal: false }] }),
    "100.100.0.5",
  );
  assert.equal(tailscaleAddress({ eth0: INTERFACES.eth0 }), undefined);
});

test("bindHost opens the machine only for lan, the tailnet for tailscale", () => {
  assert.equal(bindHost("local", INTERFACES), "127.0.0.1");
  assert.equal(bindHost("lan", INTERFACES), "0.0.0.0");
  assert.equal(bindHost("tailscale", INTERFACES), "100.127.92.41");
  assert.equal(bindHost("tailscale", {}), "127.0.0.1");
});

test("isAccessMode accepts the four modes", () => {
  for (const mode of ["local", "lan", "cloudflare", "tailscale"]) {
    assert.equal(isAccessMode(mode), true);
  }
  assert.equal(isAccessMode("wifi"), false);
  assert.equal(isAccessMode(undefined), false);
});

test("access settings round-trip and ignore damage", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-access-"));
  assert.deepEqual(loadAccessSettings(dir), {});

  saveAccessSettings(dir, "tailscale");
  assert.deepEqual(loadAccessSettings(dir), { access: "tailscale" });
  assert.equal((fs.statSync(path.join(dir, "access.json")).mode & 0o777), 0o600);

  fs.writeFileSync(path.join(dir, "access.json"), "{not json", { mode: 0o600 });
  assert.deepEqual(loadAccessSettings(dir), {});
  fs.writeFileSync(path.join(dir, "access.json"), '{"access":"wifi"}', { mode: 0o600 });
  assert.deepEqual(loadAccessSettings(dir), {});
});

test("chooseAccess takes --access as given without asking", async () => {
  const calls = { menu: 0, prepare: [] };
  const result = await chooseAccess({
    given: "local",
    saved: "lan",
    ask: true,
    menu: async () => (calls.menu++, "cloudflare"),
    prepare: async (mode) => (calls.prepare.push(mode), true),
  });
  assert.deepEqual(result, { mode: "local" });
  assert.equal(calls.menu, 0);
  assert.deepEqual(calls.prepare, ["local"]);
});

test("chooseAccess uses the saved choice when nobody can answer", async () => {
  const result = await chooseAccess({
    given: undefined,
    saved: "tailscale",
    ask: false,
    menu: async () => assert.fail("must not ask"),
    prepare: async () => true,
  });
  assert.deepEqual(result, { mode: "tailscale" });

  assert.deepEqual(
    await chooseAccess({ given: undefined, saved: undefined, ask: false, menu: async () => undefined, prepare: async () => true }),
    { mode: "local" },
  );
});

test("chooseAccess asks when someone is there, and propagates a closed menu", async () => {
  const asked = [];
  const result = await chooseAccess({
    given: undefined,
    saved: "lan",
    ask: true,
    menu: async (current) => (asked.push(current), undefined),
    prepare: async () => assert.fail("must not prepare"),
  });
  assert.equal(result, "closed");
  assert.deepEqual(asked, ["lan"]);
});

test("an unready mode from the menu goes back to the menu", async () => {
  const picked = ["tailscale", "cloudflare"];
  const prepared = [];
  const result = await chooseAccess({
    given: undefined,
    saved: undefined,
    ask: true,
    menu: async () => picked.shift(),
    prepare: async (mode) => (prepared.push(mode), mode !== "tailscale"),
  });
  assert.deepEqual(result, { mode: "cloudflare" });
  assert.deepEqual(prepared, ["tailscale", "cloudflare"]);
});

test("an unready mode from --access or the saved choice ends the start", async () => {
  assert.equal(
    await chooseAccess({ given: "cloudflare", ask: false, menu: async () => undefined, prepare: async () => false }),
    "unready",
  );
  assert.equal(
    await chooseAccess({ given: undefined, saved: "tailscale", ask: false, menu: async () => undefined, prepare: async () => false }),
    "unready",
  );
});

test("prepare may hand back the cloudflared binary to run", async () => {
  const result = await chooseAccess({
    given: "cloudflare",
    ask: false,
    menu: async () => undefined,
    prepare: async () => "/the/bin/cloudflared",
  });
  assert.deepEqual(result, { mode: "cloudflare", binary: "/the/bin/cloudflared" });
});

test("cloudflaredSource maps platforms to downloads or install hints", () => {
  assert.deepEqual(cloudflaredSource("linux", "x64"), {
    url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
  });
  assert.deepEqual(cloudflaredSource("linux", "arm64"), {
    url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64",
  });
  assert.match(cloudflaredSource("darwin", "arm64").install, /brew install/);
  assert.match(cloudflaredSource("win32", "x64").install, /winget/);
  assert.match(cloudflaredSource("android", "arm64").install, /pkg install/);
  assert.ok(!("url" in cloudflaredSource("linux", "riscv64")));
});

test("findCloudflared looks in PATH and the data folder's bin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-cloudflared-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, "cloudflared");
  fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });

  assert.equal(findCloudflared(dir, { PATH: "/nonexistent" }), file);
  assert.equal(findCloudflared(dir, { PATH: "" }), file);
  assert.equal(findCloudflared(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-empty-")), { PATH: "/nonexistent" }), undefined);
});

test("the tunnel reports its address once registered", async () => {
  const events = { ready: [], problems: [], exits: [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-tunnel-"));
  const script = path.join(dir, "fake-cloudflared.sh");
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      "echo '2026-01-01 INF +------------------------------------------------------------+'",
      "echo '2026-01-01 INF |  https://abc-def-ghi.trycloudflare.com                   |'",
      "echo '2026-01-01 INF +--------------------------------------------+'",
      "echo '2026-01-01 INF Registered tunnel connection some-uuid'",
      "exec sleep 60",
    ].join("\n"),
    { mode: 0o755 },
  );

  const tunnel = new CloudflareTunnel(script, 30141, path.join(dir, "cloudflared.log"), {
    ready: (url) => events.ready.push(url),
    problem: (line) => events.problems.push(line),
    exit: (code) => events.exits.push(code),
  });
  tunnel.start();

  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (events.ready.length > 0) {
        clearInterval(poll);
        resolve();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(poll);
      resolve();
    }, 5000).unref();
  });

  assert.deepEqual(events.ready, ["https://abc-def-ghi.trycloudflare.com"]);
  assert.equal(tunnel.url, "https://abc-def-ghi.trycloudflare.com");
  // The log exists and stays owner-only: it can hold request addresses.
  assert.equal((fs.statSync(path.join(dir, "cloudflared.log")).mode & 0o777), 0o600);

  await tunnel.stop();
  assert.equal(tunnel.url, "https://abc-def-ghi.trycloudflare.com");
});
