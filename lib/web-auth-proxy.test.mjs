import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalPassword = process.env.PI_WEB_PASSWORD;
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("../proxy.ts");
const { createWebSessionToken, isValidWebSessionToken } = await jiti.import("./web-auth.ts");
const { getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess } = await import("./auth-throttle.ts");

before(() => { process.env.PI_WEB_PASSWORD = "secret"; });
beforeEach(() => { recordAuthSuccess(); });
after(() => {
  recordAuthSuccess();
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
});

function request(path, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { Host: "localhost", ...headers },
  });
}

test("redirects page navigation to the login page and preserves its query", () => {
  const response = proxy(request("/?session=abc"));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/login?next=%2F%3Fsession%3Dabc");
});

test("accepts a signed session for pages", () => {
  const token = createWebSessionToken("secret");
  const response = proxy(request("/", { Cookie: `pi_web_session=${token}` }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("keeps Basic Auth compatibility for APIs but not pages", () => {
  const authorization = `Basic ${Buffer.from("pi:secret").toString("base64")}`;
  assert.equal(proxy(request("/api/sessions", { Authorization: authorization })).status, 200);
  assert.equal(proxy(request("/", { Authorization: authorization })).status, 307);
  assert.equal(proxy(request("/api/sessions")).status, 401);
});

test("leaves the login endpoint reachable without a session", () => {
  assert.equal(proxy(request("/login")).status, 200);
  assert.equal(proxy(request("/api/web-auth")).status, 200);
});

function basic(password) {
  return `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
}

test("a wrong Basic password blocks further attempts, even with the right password", () => {
  assert.equal(proxy(request("/api/sessions", { Authorization: basic("guess") })).status, 401);
  assert.ok(getAuthRetryAfterMs() > 0);

  for (const path of ["/api/sessions", "/api/web-auth"]) {
    const response = proxy(request(path, { Authorization: basic("secret") }));
    assert.equal(response.status, 429, path);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("GET /api/web-auth cannot be used to check Basic passwords without the throttle", () => {
  assert.equal(proxy(request("/api/web-auth", { Authorization: basic("guess") })).status, 200);
  assert.ok(getAuthRetryAfterMs() > 0);
  assert.equal(proxy(request("/api/web-auth", { Authorization: basic("guess-2") })).status, 429);
});

test("a signed session keeps working while Basic attempts are blocked", () => {
  proxy(request("/api/sessions", { Authorization: basic("guess") }));
  const token = createWebSessionToken("secret");
  const response = proxy(request("/api/sessions", {
    Authorization: basic("guess"),
    Cookie: `pi_web_session=${token}`,
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("only Basic credentials count as password attempts", () => {
  assert.equal(proxy(request("/api/sessions", { Authorization: "Bearer token" })).status, 401);
  assert.equal(getAuthRetryAfterMs(), 0);
});

test("a Basic success does not reset earlier failures", () => {
  recordAuthFailure(Date.now() - 2_000);
  assert.equal(getAuthRetryAfterMs(), 0);
  assert.equal(proxy(request("/api/sessions", { Authorization: basic("secret") })).status, 200);

  assert.equal(proxy(request("/api/sessions", { Authorization: basic("guess") })).status, 401);
  // The second failure in a row doubles the block instead of starting over.
  assert.ok(getAuthRetryAfterMs() > 1_000);
});

function sessionCookieValue(response) {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /pi_web_session=([^;]+)/.exec(setCookie);
  return match?.[1];
}

test("a sign-in link signs the browser in and lands on a clean URL", () => {
  const response = proxy(request("/login?token=secret"));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "http://localhost/");
  assert.ok(!response.headers.get("location").includes("token="));

  const cookie = sessionCookieValue(response);
  assert.ok(cookie);
  assert.ok(isValidWebSessionToken(cookie, "secret"));
  assert.match(response.headers.get("set-cookie"), /Max-Age=31536000/);
  assert.ok(!/Secure/.test(response.headers.get("set-cookie")), "no Secure flag over plain http");
});

test("a sign-in link honors and sanitizes its next destination", () => {
  const good = proxy(request("/login?token=secret&next=%2F%3Fsession%3Dabc"));
  assert.equal(good.headers.get("location"), "http://localhost/?session=abc");

  const evil = proxy(request("/login?token=secret&next=%2F%2Fevil.example"));
  assert.equal(evil.headers.get("location"), "http://localhost/");
});

test("a wrong sign-in link records a failure and never echoes the guess", () => {
  const response = proxy(request("/login?token=guess"));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "http://localhost/login");
  assert.ok(getAuthRetryAfterMs() > 0);
});

test("a blocked throttle refuses even a valid sign-in link", () => {
  recordAuthFailure();
  assert.ok(getAuthRetryAfterMs() > 0);

  const response = proxy(request("/login?token=secret"));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("a valid sign-in link does not reset earlier failures", () => {
  recordAuthFailure(Date.now() - 2_000);
  assert.equal(getAuthRetryAfterMs(), 0);

  assert.equal(proxy(request("/login?token=secret")).status, 303);

  assert.equal(proxy(request("/api/sessions", { Authorization: basic("guess") })).status, 401);
  // The failure count survived the sign-in: the delay doubled instead of restarting.
  assert.ok(getAuthRetryAfterMs() > 1_000);
});

test("an already signed-in browser visiting a sign-in link goes home", () => {
  const token = createWebSessionToken("secret");
  const response = proxy(request("/login?token=secret", { Cookie: `pi_web_session=${token}` }));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/");
});
