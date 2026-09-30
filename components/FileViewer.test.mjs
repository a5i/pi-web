import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import ts from "typescript";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("large source previews bypass the per-line syntax highlighter", () => {
  assert.match(source, /const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;/);
  assert.match(source, /const useLightweightSource = sourceLines\.length > SOURCE_HIGHLIGHT_MAX_LINES/);

  // Both source trees are memoized so unrelated re-renders (panel open/close,
  // selection changes) reuse them instead of rebuilding every line element.
  assert.match(source, /const highlightedSource = useMemo\(/);

  const lightweightStart = source.indexOf("const lightweightSourceLines = useMemo(");
  const lightweightEnd = source.indexOf("[sourceLines, useLightweightSource, wrapLines]", lightweightStart);
  assert.notEqual(lightweightStart, -1);
  assert.notEqual(lightweightEnd, -1);

  const lightweightSource = source.slice(lightweightStart, lightweightEnd);
  assert.match(lightweightSource, /useLightweightSource \? sourceLines\.map\(\(line, lineIndex\) =>/);
  assert.match(lightweightSource, /className="file-source-line"/);
  assert.match(lightweightSource, /className="file-source-line-content"/);
  assert.match(lightweightSource, /style=\{FILE_LINE_NUMBER_STYLE\}/);

  // The lightweight branch still wins over the syntax highlighter in the JSX.
  const branchStart = source.indexOf(") : useLightweightSource ? (");
  assert.notEqual(branchStart, -1);
  assert.match(source.slice(branchStart), /className="file-source-view is-lightweight"/);
  assert.notEqual(source.indexOf("highlightedSource", branchStart), -1);
});

test("lightweight source rows are skipped for highlighted, diff, and preview views", () => {
  // Execute the source-view calculations without mounting the file-fetching component.
  const file = ts.createSourceFile("FileViewer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const viewer = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "TextFileViewer");
  const calculations = viewer.body.statements.filter((node) =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      ["viewerContent", "sourceLines", "language", "isHtml", "isMarkdown", "isMdx", "isLikeC4", "hasPreview", "effectiveDisplayMode", "useLightweightSource", "lightweightSourceLines"].includes(declaration.name.getText(file)),
    ),
  ).map((node) => node.getText(file)).join("\n");
  const { outputText } = ts.transpileModule(`
    return (data, displayMode, hasGitDiff = false, isDeletedDiff = false, wrapLines = false) => {
      const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;
      const FILE_LINE_NUMBER_STYLE = {};
      const getFileExt = () => "md";
      const filePath = "/tmp/report.md";
      ${calculations}
      return lightweightSourceLines;
    };
  `, { compilerOptions: { jsx: ts.JsxEmit.React } });
  const render = new Function("React", "useMemo", outputText)(React, (calculate) => calculate());
  const large = { content: "line\n".repeat(1_000), language: "text" };

  assert.equal(render({ ...large, content: "line\n".repeat(999) }, "source"), null);
  assert.equal(render(large, "diff", true), null);
  assert.equal(render(large, "source", true, true), null);
  for (const language of ["html", "markdown", "likec4"]) {
    assert.equal(render({ ...large, language }, "preview"), null);
  }
  for (const mode of ["source", "diff", "preview"]) {
    const rows = render(large, mode);
    assert.equal(rows.length, 1_001, `${mode} must retain its source fallback`);
    assert.equal(rows[0].props["data-line-number"], 1);
    assert.equal(rows[0].props.children[1].props.children, "line");
  }
  assert.equal(render(large, "source", false, false, true)[0].props.children[1].props.style.whiteSpace, "pre-wrap");
});

test("likec4 files get a preview pane with a source fallback", () => {
  assert.match(source, /const isLikeC4 = language === "likec4";/);
  assert.match(source, /const hasPreview = !data\?\.truncated && \(isHtml \|\| isMarkdown \|\| isLikeC4\);/);
  // Prism has no likec4 grammar; refractor throws on unregistered names.
  assert.match(source, /language === "text" \|\| language === "likec4" \? "plaintext" : language/);
  const branchStart = source.indexOf(") : isLikeC4 && effectiveDisplayMode === \"preview\" ? (");
  assert.notEqual(branchStart, -1, "preview pane must branch for likec4");
  assert.match(source.slice(branchStart, branchStart + 400), /<LikeC4Preview/);
  assert.match(source.slice(branchStart, branchStart + 400), /onShowSource=\{\(\) => updateDisplayMode\("source"\)\}/);
  // LikeC4 previews open in preview mode like markdown and HTML.
  assert.match(source, /data\?\.language === "markdown" \|\| data\?\.language === "html" \|\| data\?\.language === "likec4"/);
});

test("markdown preview wires mermaid and likec4 fences", () => {
  assert.match(source, /if \(lang === "mermaid"\) \{/);
  assert.match(source, /if \(lang === "likec4"\) \{\s*return <LikeC4Fence code=\{raw\.replace\(\/\\n\$\/, ""\)\} \/>;/);
});

test("mdx previews parse MDX syntax behind a plain-markdown fallback boundary", () => {
  assert.match(source, /const isMdx = isMarkdown && getFileExt\(filePath\) === "mdx";/);
  assert.match(source, /remarkPlugins=\{markdownMdxPreviewRemarkPlugins\}/);
  assert.match(source, /rehypePlugins=\{markdownMdxPreviewRehypePlugins\}/);
  // The boundary's fallback re-renders with the plain pipeline so a broken
  // .mdx still reads as markdown.
  const boundaryStart = source.indexOf("<MdxPreviewBoundary");
  assert.notEqual(boundaryStart, -1);
  const boundaryBlock = source.slice(boundaryStart, source.indexOf("</MdxPreviewBoundary>", boundaryStart));
  assert.match(boundaryBlock, /fallback=\{\(/);
  assert.match(boundaryBlock, /remarkPlugins=\{markdownPreviewRemarkPlugins\}/);
  assert.match(boundaryBlock, /components=\{markdownComponents\}/);
  // import/export chips are labelled through the shared components map.
  assert.match(source, /className\.includes\("mdx-esm-notice"\)/);
  assert.match(source, /t\("i18n\.mdxImportsNotice", \{ count \}\)/);
});

test("markdown preview links carry PDF page fragments", () => {
  assert.match(source, /parsePdfPageFragment/);
  assert.match(source, /onOpenFile\(linkedFile, parsePdfPageFragment\(href\) \?\? undefined\)/);
});
