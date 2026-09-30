// OpenAPI preview e2e: bundles the FileViewer with esbuild (the Stoplight
// Elements web-component chunk is bundled in with it), mocks /api/files with a
// small OpenAPI spec, and drives the docs preview in headless Chromium.
// Run: node e2e/openapi.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const directory = mkdtempSync(join(tmpdir(), "pi-web-openapi-"));
let browser;
try {
  const specSource = [
    "openapi: 3.0.3",
    "info:",
    "  title: Swag Petstore",
    "  version: 1.0.0",
    "  description: A tiny sample API",
    "paths:",
    "  /pets:",
    "    get:",
    "      summary: List pets",
    "      operationId: listPets",
    "      responses:",
    '        "200":',
    "          description: A list of pets",
    "components:",
    "  schemas:",
    "    Pet:",
    "      type: object",
    "      properties:",
    "        id:",
    "          type: integer",
    "        name:",
    "          type: string",
  ].join("\n");

  // A multi-file root: its external $ref is resolved server-side, and the
  // bundled document carries a marker string the raw source never mentions.
  const multiSource = [
    "openapi: 3.0.3",
    "info:",
    "  title: Multi-file API",
    "  version: 1.0.0",
    "paths:",
    "  /pets:",
    "    get:",
    "      summary: List pets",
    "      responses:",
    '        "200":',
    "          description: ok",
    "          content:",
    "            application/json:",
    "              schema:",
    '                $ref: "./common.yaml#/components/schemas/Pet"',
  ].join("\n");
  const bundledSpec = {
    openapi: "3.0.3",
    info: { title: "Multi-file API", version: "2.0.0", description: "Resolved from common.yaml" },
    paths: {
      "/pets": {
        get: {
          summary: "List pets",
          responses: {
            "200": { description: "ok", content: {} },
          },
        },
      },
    },
  };

  const outfile = join(directory, "viewer.js");
  await build({
    stdin: {
      contents: [
        'import { FileViewer } from "./components/FileViewer";',
        'import { createRoot } from "react-dom/client";',
        'import React from "react";',
        'import { I18nProvider } from "./hooks/useI18n";',
        "let root = null;",
        "window.mountViewer = (props) => {",
        "  root ||= createRoot(document.getElementById(\"viewer\"));",
        "  root.render(React.createElement(I18nProvider, null, React.createElement(FileViewer, { key: props.filePath, ...props })));",
        "};",
      ].join("\n"),
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile,
    define: { "process.env.NODE_ENV": '"production"' },
  });

  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    // Elements' web-component bridge mounts through ReactDOM.render, whose
    // deprecation warning its own bundled React 18 logs once per mount.
    if (message.type() === "error" && !/ReactDOM\.render is no longer supported/.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });
  // The page must navigate to a real origin: @stoplight/mosaic reads
  // localStorage at module evaluation, which throws a SecurityError on the
  // null origin of a setContent page and would reject the whole lazy chunk.
  await page.route("https://pi-web.test/**", (route) => {
    const url = route.request().url();
    if (route.request().resourceType() === "document") {
      return route.fulfill({
        contentType: "text/html",
        body: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="viewer"></div></body></html>`,
      });
    }
    if (url.includes("/api/files/") && url.includes("type=read")) {
      const content = url.includes("multi.yaml") ? multiSource : specSource;
      return route.fulfill({
        json: { content, language: "yaml", size: content.length, nextOffset: content.length, truncated: false },
      });
    }
    if (url.includes("/api/openapi")) {
      return route.fulfill({ json: { ok: true, bundled: JSON.stringify(bundledSpec) } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("https://pi-web.test/");
  await page.addScriptTag({ path: outfile });
  const css = join(directory, "viewer.css");
  if (existsSync(css)) {
    await page.addStyleTag({ path: css });
  }

  // Source first: the spec is served as yaml, so the viewer must not render
  // the docs pane until Preview is picked.
  await page.evaluate(() => window.mountViewer({ filePath: "/tmp/openapi.yaml", initialDisplayMode: "source", watchEnabled: false }));
  await page.waitForSelector(".file-source-view", { timeout: 20_000 });
  assert.equal(await page.locator(".openapi-preview").count(), 0, "docs pane must stay hidden in source mode");

  await page.locator(".file-viewer-mode-switch button", { hasText: "Preview" }).click();
  await page.waitForSelector(".openapi-preview .sl-elements", { timeout: 30_000 });
  const docsText = await page.locator(".openapi-preview").innerText();
  assert.ok(docsText.includes("Swag Petstore"), `info title missing: ${docsText.slice(0, 300)}`);
  assert.ok(docsText.includes("List pets"), `operation summary missing: ${docsText.slice(0, 300)}`);

  // Without a mode hint the sniffed spec defaults to the docs preview, like
  // .c4 and markdown files do.
  await page.evaluate(() => window.mountViewer({ filePath: "/tmp/api.yaml", watchEnabled: false }));
  await page.waitForSelector(".openapi-preview .sl-elements", { timeout: 30_000 });

  // Multi-file spec: the bundling route resolves the external $ref, and the
  // bundled marker text proves the docs came from the bundled document.
  await page.evaluate(() => window.mountViewer({ filePath: "/tmp/multi.yaml", initialDisplayMode: "preview", watchEnabled: false }));
  await page.waitForSelector(".openapi-preview .sl-elements", { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const multiText = await page.locator(".openapi-preview").innerText();
  assert.ok(multiText.includes("Resolved from common.yaml"), `bundled docs missing: ${multiText.slice(0, 300)}`);
  assert.equal(await page.locator(".openapi-preview-notice").count(), 0, "no fallback notice when bundling succeeds");

  assert.deepEqual(consoleErrors, [], `unexpected console errors: ${consoleErrors.join(" | ")}`);

  console.log("OpenAPI preview: source guard, docs rendering, sniffed auto-preview, external-ref bundling passed");
} finally {
  await browser?.close();
  rmSync(directory, { recursive: true, force: true });
}
