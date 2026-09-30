// LikeC4 (.c4) and MDX preview e2e: bundles the FileViewer with esbuild,
// mocks /api with real server-computed LikeC4 views, and drives both preview
// kinds in headless Chromium. Run: node e2e/likec4.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createJiti } from "jiti";

const directory = mkdtempSync(join(tmpdir(), "pi-web-likec4-"));
let browser;
try {
  // Compute real layouted views in Node so the API mock answers exactly what
  // app/api/likec4 would return for this source.
  const jiti = createJiti(join(process.cwd(), "e2e/"), { tsconfigPaths: true });
  const { computeLikeC4Preview } = await jiti.import("../lib/likec4-preview.ts");
  const c4Source = [
    "specification {",
    "  element customer",
    "  element api",
    "}",
    "model {",
    "  c = customer 'Customer'",
    "  a = api 'API'",
    "  c -> a 'uses'",
    "}",
    "views {",
    "  view index {",
    "    title 'Index'",
    "    include *",
    "  }",
    "  view team {",
    "    title 'Team / Overview'",
    "    include *",
    "    autoLayout LeftRight",
    "  }",
    "}",
  ].join("\n");
  const computed = await computeLikeC4Preview(c4Source);
  assert.ok(computed.views.length === 2, `expected 2 views, got ${computed.views.length}`);

  const mdxSource = [
    "---",
    "title: Doc",
    "---",
    "",
    'import { Chart } from "./chart"',
    "",
    "# Architecture",
    "",
    "<Callout type=\"warning\">",
    "  Inside the box",
    "</Callout>",
    "",
    'Inline <Badge color="red">new</Badge> here.',
    "",
    "Expression {count} muted.",
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
        "  root.render(React.createElement(I18nProvider, null, React.createElement(FileViewer, props)));",
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
  await page.setContent(`<base href="https://pi-web.test/"><div id="viewer"></div>`);
  await page.addScriptTag({ path: outfile });
  const css = join(directory, "viewer.css");
  if (existsSync(css)) {
    await page.addStyleTag({ path: css });
  }

  await page.route("https://pi-web.test/api/**", (route) => {
    const url = route.request().url();
    if (url.includes("/api/likec4")) {
      return route.fulfill({ json: { ok: true, ...computed } });
    }
    if (url.includes("/api/files/") && url.includes("type=read")) {
      const isMdx = url.includes("report.mdx");
      const content = isMdx ? mdxSource : c4Source;
      return route.fulfill({
        json: { content, language: isMdx ? "markdown" : "likec4", size: content.length, nextOffset: content.length, truncated: false },
      });
    }
    return route.fulfill({ json: {} });
  });

  // .c4 file: view selector, laid-out nodes, and view switching.
  await page.evaluate(() => window.mountViewer({ filePath: "/tmp/diagram.c4", initialDisplayMode: "preview", watchEnabled: false }));
  await page.waitForSelector(".likec4-preview-canvas .react-flow__node", { timeout: 20_000 });
  const nodeTexts = await page.locator(".likec4-preview-canvas .react-flow__node").allTextContents();
  assert.ok(nodeTexts.some((text) => text.includes("Customer")), `nodes: ${nodeTexts.join(",")}`);
  assert.ok(nodeTexts.some((text) => text.includes("API")), `nodes: ${nodeTexts.join(",")}`);
  const options = await page.locator("select.likec4-view-select option").allTextContents();
  assert.ok(options.some((text) => text.includes("Index")), `options: ${options.join(",")}`);
  assert.ok(options.some((text) => text.includes("Overview")), `options: ${options.join(",")}`);
  await page.selectOption("select.likec4-view-select", "team");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".likec4-preview-canvas .react-flow__node").count() > 0, true);

  // .mdx file: markdown renders, JSX becomes placeholders, imports collapse.
  await page.evaluate(() => window.mountViewer({ filePath: "/tmp/report.mdx", initialDisplayMode: "preview", watchEnabled: false }));
  await page.waitForSelector(".markdown-file-preview h1", { timeout: 10_000 });
  assert.match(await page.locator(".markdown-file-preview h1").first().textContent(), /Architecture/);
  assert.match(await page.locator(".mdx-jsx-component").first().textContent(), /Callout type="warning"/);
  assert.match(await page.locator(".mdx-jsx-component").first().textContent(), /Inside the box/);
  assert.match(await page.locator(".mdx-jsx-component-inline").first().textContent(), /Badge color="red"/);
  assert.match(await page.locator(".mdx-esm-notice").first().textContent(), /import \{ Chart \} from "\.\/chart"/);
  assert.match(await page.locator("code.mdx-expression").first().textContent(), /\{count\}/);

  console.log("LikeC4/MDX preview: diagram views, view switching, MDX placeholders and import chips passed");
} finally {
  await browser?.close();
  rmSync(directory, { recursive: true, force: true });
}
