import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { isWildcardBind, signInLinkUrls } = require("../bin/sign-in-links.js");

const TOKEN = "a".repeat(64);
const INTERFACES = {
  lo: [
    { family: "IPv4", address: "127.0.0.1", internal: true },
    { family: "IPv6", address: "::1", internal: true },
  ],
  eth0: [
    { family: "IPv4", address: "192.168.1.42", internal: false },
    { family: "IPv6", address: "fd00::42", internal: false },
  ],
  docker0: [{ family: "IPv4", address: "172.17.0.1", internal: false }],
};

test("loopback binds print one loopback link", () => {
  assert.deepEqual(signInLinkUrls("127.0.0.1", "30141", TOKEN, INTERFACES), {
    loopback: `http://127.0.0.1:30141/login?token=${TOKEN}`,
    lan: [],
  });
  assert.deepEqual(signInLinkUrls("localhost", "30141", TOKEN, INTERFACES).lan, []);
});

test("a specific hostname prints its own address", () => {
  const { loopback, lan } = signInLinkUrls("192.168.1.5", "30141", TOKEN, INTERFACES);
  assert.equal(loopback, `http://192.168.1.5:30141/login?token=${TOKEN}`);
  assert.deepEqual(lan, []);
});

test("wildcard binds list the machine's external IPv4 addresses", () => {
  const { loopback, lan } = signInLinkUrls("0.0.0.0", "30141", TOKEN, INTERFACES);
  assert.equal(loopback, `http://127.0.0.1:30141/login?token=${TOKEN}`);
  assert.deepEqual(lan, [
    `http://192.168.1.42:30141/login?token=${TOKEN}`,
    `http://172.17.0.1:30141/login?token=${TOKEN}`,
  ]);
});

test("IPv6 wildcard binds become bracketed loopback", () => {
  const { loopback } = signInLinkUrls("::", "30141", TOKEN, INTERFACES);
  assert.equal(loopback, `http://[::1]:30141/login?token=${TOKEN}`);
});

test("wildcard binds with no interfaces still print the loopback link", () => {
  const { loopback, lan } = signInLinkUrls("0.0.0.0", "30141", TOKEN, {});
  assert.equal(loopback, `http://127.0.0.1:30141/login?token=${TOKEN}`);
  assert.deepEqual(lan, []);
});

test("isWildcardBind recognizes the wildcard spellings", () => {
  assert.equal(isWildcardBind("0.0.0.0"), true);
  assert.equal(isWildcardBind("::"), true);
  assert.equal(isWildcardBind("[::]"), true);
  assert.equal(isWildcardBind("127.0.0.1"), false);
  assert.equal(isWildcardBind("localhost"), false);
});
