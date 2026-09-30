// Run against `npm run dev`: this exercises Next/Turbopack's actual lazy chunks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { chromium } from "playwright";
import JSZip from "jszip";
import { createJiti } from "jiti";

const origin = process.env.E2E_BASE_URL ?? "http://127.0.0.1:30141";
const filePath = resolve(process.argv[2] ?? "docx-fixture.md");
const markdown = process.argv[2]
  ? readFileSync(filePath, "utf8")
  : "# DOCX export fixture\n\n## Section\n\n1. First\n2. Second\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```sh\nnpm install\n```\n";
const sessionId = "docx-export-fixture";
const timestamp = "2026-09-30T00:00:00.000Z";
const info = { id: sessionId, path: "/tmp/docx-export-fixture.jsonl", cwd: dirname(filePath), name: "DOCX export fixture", created: timestamp, modified: timestamp, messageCount: 1, firstMessage: "DOCX export fixture", projectRoot: dirname(filePath) };
const message = { role: "assistant", content: [{ type: "text", text: `[Open export fixture](${filePath})` }], timestamp: Date.parse(timestamp), provider: "test", model: "test", api: "openai-completions", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  const context = await browser.newContext();
  if (process.env.PI_WEB_PASSWORD) {
    const jiti = createJiti(import.meta.url);
    const { createWebSessionToken, PI_WEB_SESSION_COOKIE } = await jiti.import("../lib/web-auth.ts");
    await context.addCookies([{ name: PI_WEB_SESSION_COOKIE, value: createWebSessionToken(process.env.PI_WEB_PASSWORD), url: origin }]);
  }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route(`${origin}/api/sessions**`, route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/sessions") return route.fulfill({ json: { sessions: [info], runningSessionIds: [], completionNotificationSuppressedSessionIds: [], sessionListVersion: "fixture" } });
    if (url.pathname.endsWith("/state")) return route.fulfill({ json: { running: false } });
    return route.fulfill({ json: { sessionId, filePath: info.path, info, leafId: "fixture-entry", tree: [], context: { messages: [message], entryIds: ["fixture-entry"], oldestEntryId: "fixture-entry", hasMore: false, thinkingLevel: "off", model: null }, stats: { userMessages: 0, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }, totalActiveMs: 0 } });
  });
  await page.route(`${origin}/api/agent/**`, route => {
    if (new URL(route.request().url()).pathname === "/api/agent/running") return route.fulfill({ json: { sessionIds: [] } });
    return route.fulfill({ status: 404, json: { error: "Session not running" } });
  });
  await page.route(`${origin}/api/files/**`, route => {
    const type = new URL(route.request().url()).searchParams.get("type");
    if (type === "read") return route.fulfill({ json: { content: markdown, language: "markdown", size: Buffer.byteLength(markdown), nextOffset: Buffer.byteLength(markdown), truncated: false } });
    if (type === "list") return route.fulfill({ json: { entries: [] } });
    return route.fulfill({ json: { size: Buffer.byteLength(markdown), mtime: 0 } });
  });
  await page.goto(`${origin}/?session=${sessionId}`);
  await page.getByRole("link", { name: "Open export fixture", exact: true }).click();
  const viewer = page.locator(".file-viewer-shell");
  const preview = viewer.getByRole("button", { name: "Preview", exact: true });
  if (await preview.getAttribute("aria-pressed") !== "true") await preview.click();
  for (const withToc of [false, true]) {
    await viewer.getByRole("button", { name: "Export DOCX", exact: true }).click();
    const downloadPromise = page.waitForEvent("download");
    await viewer.getByRole("button", { name: withToc ? "With Word table of contents" : "Without table of contents", exact: true }).click();
    const download = await downloadPromise;
    assert.equal(await download.failure(), null);
    const zip = await JSZip.loadAsync(readFileSync(await download.path()));
    const xml = await zip.file("word/document.xml").async("string");
    assert.match(xml, /Heading1/);
    assert.equal(/TOC /.test(xml), withToc);
    assert.equal(errors.length, 0, errors.join("\n"));
  }
  console.log(`Next/Turbopack DOCX export passed in both modes: ${filePath}`);
} finally {
  await browser.close();
}
