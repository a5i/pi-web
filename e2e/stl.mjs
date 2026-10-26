// STL preview e2e: bundles the FileViewer with esbuild (the React Three Fiber
// renderer chunk is bundled in with it), mocks /api/files with synthetic
// binary and ASCII STL files, and drives the 3D preview in headless Chromium.
// Run: node e2e/stl.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const directory = mkdtempSync(join(tmpdir(), "pi-web-stl-"));
let browser;
// Software WebGL is slow; a stall must fail loudly instead of hanging the run.
const watchdog = setTimeout(() => {
  console.error("STL e2e timed out");
  process.exit(1);
}, 180_000);
watchdog.unref();
try {
  // One right triangle, facet normal (0,0,1): 80-byte header ("solid …", the
  // broken-exporter trap), uint32 count, 50 bytes per triangle.
  function binaryStl(triangles) {
    const parts = [Buffer.alloc(80)];
    parts[0].write("solid exporter writes this into binary files too");
    const count = Buffer.alloc(4);
    count.writeUInt32LE(triangles.length);
    parts.push(count);
    for (const triangle of triangles) {
      const record = Buffer.alloc(50);
      record.writeFloatLE(triangle.n[0], 0);
      record.writeFloatLE(triangle.n[1], 4);
      record.writeFloatLE(triangle.n[2], 8);
      triangle.v.forEach((vertex, i) => {
        record.writeFloatLE(vertex[0], 12 + i * 12);
        record.writeFloatLE(vertex[1], 16 + i * 12);
        record.writeFloatLE(vertex[2], 20 + i * 12);
      });
      parts.push(record);
    }
    return Buffer.concat(parts);
  }

  const binaryModel = binaryStl([
    { n: [0, 0, 1], v: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] },
    { n: [0, 0, 1], v: [[0, 0, 0], [0, 1, 0], [0, 0, 1]] },
  ]);

  const asciiModel = [
    "solid ascii part",
    "facet normal 0 0 1",
    "outer loop",
    "vertex 0 0 0",
    "vertex 1 0 0",
    "vertex 0 1 0",
    "endloop",
    "endfacet",
    "endsolid ascii part",
  ].join("\n");

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
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  page.setDefaultTimeout(20_000);
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  // A real origin, not setContent: the R3F chunk measures the viewport and
  // creates a WebGL context, both happier on a fulfilled document.
  await page.route("https://pi-web.test/**", (route) => {
    const url = route.request().url();
    if (route.request().resourceType() === "document") {
      return route.fulfill({
        contentType: "text/html",
        body: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="viewer"></div></body></html>`,
      });
    }
    if (url.includes("/api/files/") && url.includes("type=meta")) {
      const size = url.includes("ascii.stl") ? asciiModel.length : binaryModel.length;
      return route.fulfill({ json: { size } });
    }
    if (url.includes("/api/files/") && url.includes("type=download")) {
      const body = url.includes("ascii.stl") ? asciiModel : binaryModel;
      return route.fulfill({ contentType: "application/octet-stream", body });
    }
    if (url.includes("/api/files/") && url.includes("type=read")) {
      // A real binary STL reads as replacement text and is far bigger than one
      // 256 KB chunk; the preview must not care (CSV rule: preview despite a
      // truncated source view).
      const size = url.includes("ascii.stl") ? asciiModel.length : binaryModel.length;
      return route.fulfill({
        json: { content: "solid \uFFFD\uFFFD\uFFFD", language: "text", size, nextOffset: 256, truncated: size > 256 },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("https://pi-web.test/");
  await page.addScriptTag({ path: outfile });
  const css = join(directory, "viewer.css");
  if (existsSync(css)) {
    await page.addStyleTag({ path: css });
  }

  // Binary STL, preview mode asked for: the R3F canvas mounts and the toolbar
  // reports flavor and triangle count.
  await page.evaluate(() => window.mountViewer({ filePath: "/tmp/part.stl", initialDisplayMode: "preview", watchEnabled: false }));
  await page.waitForSelector(".cad-preview-canvas canvas", { timeout: 30_000 });
  // The chunk boundary's error state is a direct child of .cad-preview; R3F
  // also keeps its own (hidden, always-present) fallback inside <canvas>, so
  // the selector must not match descendants.
  const errorState = page.locator(".cad-preview > .likec4-canvas-state.is-error").first();
  const errorText = await errorState.innerText().catch(() => "");
  assert.equal(await page.locator(".cad-preview > .likec4-canvas-state.is-error").count(), 0, `no error state: ${errorText}`);
  const meta = await page.locator(".cad-preview-meta").innerText();
  assert.match(meta, /binary · 2 triangles/, `toolbar meta: ${meta}`);

  // Without a mode hint an .stl file defaults to the 3D preview — even though
  // the mocked source view is a truncated chunk.
  await page.evaluate(() => window.mountViewer({ filePath: "/tmp/ascii.stl", watchEnabled: false }));
  await page.waitForSelector(".cad-preview-canvas canvas", { timeout: 30_000 });
  const asciiMeta = await page.locator(".cad-preview-meta").innerText();
  assert.match(asciiMeta, /ascii · 1 triangles/, `ascii toolbar meta: ${asciiMeta}`);

  // The Source tab is one click away and shows the (mojibake) text view.
  await page.locator(".file-viewer-mode-switch button", { hasText: "Source" }).click();
  await page.waitForSelector(".file-viewer-content", { timeout: 10_000 });
  assert.equal(await page.locator(".cad-preview-canvas").count(), 0, "preview unmounts on Source");

  assert.deepEqual(consoleErrors, [], `unexpected console errors: ${consoleErrors.join(" | ")}`);

  console.log("STL preview: lazy R3F renderer, binary+ASCII parse, default preview, Source fallback passed");
} finally {
  await browser?.close();
  rmSync(directory, { recursive: true, force: true });
}
