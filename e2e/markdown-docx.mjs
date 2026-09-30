import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import JSZip from "jszip";

const directory = mkdtempSync(join(tmpdir(), "pi-web-docx-"));
let browser;
try {
  await build({ stdin: { contents: 'import { createMarkdownDocx } from "./lib/markdown-docx"; import { FileViewer } from "./components/FileViewer"; import { createRoot } from "react-dom/client"; import React from "react"; import { I18nProvider } from "./hooks/useI18n"; window.createMarkdownDocx = createMarkdownDocx; window.mountViewer = (props) => createRoot(document.getElementById("viewer")).render(React.createElement(I18nProvider, null, React.createElement(FileViewer, props)));', resolveDir: process.cwd(), loader: "tsx" }, bundle: true, platform: "browser", format: "iife", outfile: join(directory, "export.js"), define: { "process.env.NODE_ENV": '"production"' } });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage();
  await page.setContent(`<base href="https://pi-web.test/"><div id="viewer"></div><style>${readFileSync("node_modules/katex/dist/katex.min.css", "utf8").replace(/@font-face\s*\{[^}]*\}/g, "")}</style>`);
  await page.addScriptTag({ path: join(directory, "export.js") });
  const markdown = `---\ntitle: Документ\ntags: [one, two]\n---\n# Заголовок\n\nText **bold**, *italic*, ~~deleted~~ and [link](https://example.com).\n\n## Раздел\n\n1. First\n   - Nested\n2. Second\n\n> Quote one\n>\n> Quote two\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n\`\`\`js\nconst x = 1;\nconsole.log(x);\n\`\`\`\n\nInline $x^2$ and display:\n\n$$\nx = y + 1\n$$\n\n\`\`\`mermaid\nflowchart LR\n A[Start] --> B[Finish]\n\`\`\`\n`;
  const pixel = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 8; canvas.height = 8; canvas.getContext("2d").fillRect(0, 0, 8, 8); return canvas.toDataURL(); });
  await page.route("https://example.com/sample.png", route => route.fulfill({ body: Buffer.from(pixel.split(",")[1], "base64"), contentType: "image/png", headers: { "access-control-allow-origin": "*" } }));
  const imageMarkdown = markdown + "\n![sample](https://example.com/sample.png)\n";
  for (const withToc of [false, true]) {
    const bytes = await page.evaluate(async ({ markdown, withToc }) => Array.from(new Uint8Array(await (await window.createMarkdownDocx({ markdown, filePath: "/tmp/report.md", withToc, tocTitle: "Table of contents" })).arrayBuffer())), { markdown: imageMarkdown, withToc });
    const zip = await JSZip.loadAsync(Buffer.from(bytes));
    const xml = await zip.file("word/document.xml").async("string");
    assert.match(xml, /Заголовок/);
    assert.match(xml, /Heading1/);
    assert.match(xml, /Quote two/);
    assert.match(xml, /<w:tbl>/);
    assert.match(xml, /<w:numPr>/);
    assert.match(xml, /const x = 1;/);
    assert.match(await zip.file("word/_rels/document.xml.rels").async("string"), /https:\/\/example.com/);
    assert.equal(/TOC /.test(xml), withToc);
    assert.equal(Object.keys(zip.files).filter(name => /^word\/media\/.*\.png$/.test(name)).length, 4);
    assert.match(await zip.file("word/settings.xml").async("string"), /updateFields/);
  }
  await page.route("https://example.com/missing.png", route => route.fulfill({ status: 404, body: "missing", headers: { "access-control-allow-origin": "*" } }));
  const error = await page.evaluate(async () => {
    try { await window.createMarkdownDocx({ markdown: "![missing](https://example.com/missing.png)", filePath: "/tmp/report.md", withToc: false, tocTitle: "Contents" }); return null; }
    catch (error) { return error.message; }
  });
  assert.match(error, /Image unavailable/);
  assert.equal(await page.locator(".markdown-file-preview").count(), 0);
  await page.route("https://pi-web.test/api/**", route => {
    if (route.request().url().includes("/api/files/")) return route.fulfill({ headers: { "access-control-allow-origin": "*" }, json: { content: markdown, language: "markdown", size: markdown.length, nextOffset: markdown.length, truncated: false } });
    return route.fulfill({ headers: { "access-control-allow-origin": "*" }, json: {} });
  });
  await page.evaluate(() => window.mountViewer({ filePath: "/tmp/report.md", initialDisplayMode: "preview", watchEnabled: false }));
  const exportButton = page.getByRole("button", { name: "Export DOCX", exact: true });
  await exportButton.click();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("button", { name: "Without table of contents", exact: true }).count(), 0);
  await exportButton.click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Without table of contents", exact: true }).click();
  assert.equal((await download).suggestedFilename(), "report.docx");
  await exportButton.waitFor({ state: "visible" });
  console.log("DOCX export: both modes, Markdown structure, math/Mermaid images and failure cleanup passed");
} finally {
  await browser?.close();
  rmSync(directory, { recursive: true, force: true });
}
