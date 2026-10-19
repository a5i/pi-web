import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import ts from "typescript";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("large source previews bypass the per-line syntax highlighter", () => {
  assert.match(source, /const SOURCE_HIGHLIGHT_MAX_LINES = 10_000;/);
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
      ["isDelimitedTable", "viewerContent", "sourceLines", "language", "isHtml", "isMarkdown", "isMdx", "isLikeC4", "isOpenApi", "hasPreview", "effectiveDisplayMode", "useLightweightSource", "lightweightSourceLines"].includes(declaration.name.getText(file)),
    ),
  ).map((node) => node.getText(file)).join("\n");
  const { outputText } = ts.transpileModule(`
    return (data, displayMode, hasGitDiff = false, isDeletedDiff = false, wrapLines = false, filePath = "/tmp/file.txt") => {
      const isDelimitedTablePath = (path) => /\\.(csv|tsv)$/i.test(path);
      const SOURCE_HIGHLIGHT_MAX_LINES = 10_000;
      const HTML_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
      const FILE_LINE_NUMBER_STYLE = {};
      const getFileExt = () => "md";
      const isOpenApiLanguage = () => false;
      ${calculations}
      return lightweightSourceLines;
    };
  `, { compilerOptions: { jsx: ts.JsxEmit.React } });
  const render = new Function("React", "useMemo", outputText)(React, (calculate) => calculate());
  const large = { content: "line\n".repeat(10_000), language: "text" };

  assert.equal(render({ ...large, content: "line\n".repeat(9_999) }, "source"), null);
  assert.equal(render(large, "diff", true), null);
  assert.equal(render(large, "source", true, true), null);
  for (const language of ["html", "markdown", "likec4"]) {
    assert.equal(render({ ...large, language }, "preview"), null);
  }
  // A CSV/TSV table previews a loaded prefix too; markdown waits for the whole file.
  assert.equal(render({ ...large, truncated: true }, "preview", false, false, false, "/tmp/data.csv"), null);
  assert.equal(render({ ...large, language: "markdown", truncated: true }, "preview").length, 10_001);
  // A partly loaded HTML file previews too: the preview fetches it whole.
  assert.equal(render({ ...large, language: "html", truncated: true, size: 900 * 1024 }, "preview"), null);
  for (const mode of ["source", "diff", "preview"]) {
    const rows = render(large, mode);
    assert.equal(rows.length, 10_001, `${mode} must retain its source fallback`);
    assert.equal(rows[0].props["data-line-number"], 1);
    assert.equal(rows[0].props.children[1].props.children, "line");
  }
  assert.equal(render(large, "source", false, false, true)[0].props.children[1].props.style.whiteSpace, "pre-wrap");
});

test("partly loaded HTML previews up to the HTML cap; partly loaded markdown does not", () => {
  const start = source.indexOf("  const hasPreview = ");
  const statement = source.slice(start, source.indexOf(";\n", start) + 1);
  const hasPreview = new Function("data", "isHtml", "isMarkdown", "isDelimitedTable", "HTML_PREVIEW_MAX_BYTES", `const isOpenApi = false;\n${statement}\nreturn hasPreview;`);
  const cap = 10 * 1024 * 1024;
  const partial = { truncated: true, size: 900 * 1024 };

  assert.equal(hasPreview(partial, true, false, false, cap), true);
  assert.equal(hasPreview({ ...partial, size: cap + 1 }, true, false, false, cap), false);
  assert.equal(hasPreview({ truncated: false, size: cap + 1 }, true, false, false, cap), true);
  assert.equal(hasPreview(partial, false, true, false, cap), false);
  assert.equal(hasPreview({ ...partial, size: cap + 1 }, false, false, true, cap), true);
});

test("likec4 files get a preview pane with a source fallback", () => {
  assert.match(source, /const isLikeC4 = language === "likec4";/);
  assert.match(source, /: \(isMarkdown \|\| isLikeC4 \|\| isOpenApi\) && !data\?\.truncated\);/);
  // sugar-high has no likec4 grammar; such files render as plain text lines.
  assert.match(source, /language === "text" \|\| language === "likec4" \? "text" : language/);
  const branchStart = source.indexOf(") : isLikeC4 && effectiveDisplayMode === \"preview\" ? (");
  assert.notEqual(branchStart, -1, "preview pane must branch for likec4");
  assert.match(source.slice(branchStart, branchStart + 400), /<LikeC4Preview/);
  assert.match(source.slice(branchStart, branchStart + 400), /onShowSource=\{\(\) => updateDisplayMode\("source"\)\}/);
  // LikeC4 previews open in preview mode like markdown and HTML.
  assert.match(source, /data\.language === "likec4" && !data\.truncated/);
});

test("markdown preview wires mermaid and likec4 fences", () => {
  assert.match(source, /if \(lang === "mermaid"\) \{/);
  assert.match(source, /if \(lang === "likec4"\) \{\s*return <LikeC4Fence code=\{raw\.replace\(\/\\n\$\/, ""\)\} \/>;/);
});

test("openapi specs get a preview pane behind a content sniff", () => {
  // yaml/json files keep their language; the preview triggers on the document's
  // own version key (lib/openapi.ts), not on a new server language.
  assert.match(source, /import \{ isOpenApiSpecContent \} from "@\/lib\/openapi";/);
  assert.match(source, /\(language === "yaml" \|\| language === "json"\) && isOpenApiSpecContent\(content \?\? ""\)/);
  assert.match(source, /: \(isMarkdown \|\| isLikeC4 \|\| isOpenApi\) && !data\?\.truncated\);/);
  const branchStart = source.indexOf(") : isOpenApi && effectiveDisplayMode === \"preview\" ? (");
  assert.notEqual(branchStart, -1, "preview pane must branch for openapi");
  assert.match(source.slice(branchStart, branchStart + 200), /<OpenApiPreview source=\{viewerContent\}/);
  // OpenAPI previews open in preview mode like markdown, HTML and likec4.
  assert.match(source, /\|\| \(isOpenApiLanguage\(data\.language, data\.content\) && !data\.truncated\)/);
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

test("the line-number gutter is pinned only in views of at most SOURCE_HIGHLIGHT_MAX_LINES rows", () => {
  // Evaluate the module's own style constants (the numbers in the highlighted,
  // plain and diff views all come from these), the highlighted and lightweight
  // source elements and the Diff view's rows, instead of matching the
  // component's text.
  const file = ts.createSourceFile("FileViewer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constants = (...names) => {
    const statements = names.map((name) => {
      const statement = file.statements.find((node) =>
        ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
          ts.isIdentifier(declaration.name) && declaration.name.text === name,
        ),
      );
      assert.ok(statement, `${name} is declared in the module`);
      return statement.getText(file);
    });
    const { outputText } = ts.transpileModule(`${statements.join("\n")}\nreturn [${names.join(", ")}];`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
    return new Function(outputText)();
  };
  const [codeStyle, gutterStyle, pinnedStyle, maxRows] = constants("FILE_CODE_STYLE", "FILE_LINE_NUMBER_STYLE", "FILE_PINNED_LINE_NUMBER_STYLE", "SOURCE_HIGHLIGHT_MAX_LINES");

  // Build the source views without mounting the file-fetching component, with
  // the real gutter styles in place.
  const calculations = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "TextFileViewer").body.statements.filter((node) =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      ["isDelimitedTable", "viewerContent", "sourceLines", "language", "isHtml", "isMarkdown", "isMdx", "isLikeC4", "isOpenApi", "hasPreview", "effectiveDisplayMode", "useLightweightSource", "lightweightSourceLines", "highlightedSource"].includes(declaration.name.getText(file)),
    ),
  ).map((node) => node.getText(file)).join("\n");
  const { outputText } = ts.transpileModule(`
    return (data, displayMode, hasGitDiff = false, isDeletedDiff = false, wrapLines = false, filePath = "/tmp/file.txt") => {
      const isDelimitedTablePath = (path) => /\.(csv|tsv)$/i.test(path);
      const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;
      const HTML_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
      const FILE_LINE_NUMBER_STYLE = gutterStyle;
      const FILE_PINNED_LINE_NUMBER_STYLE = pinnedStyle;
      const getFileExt = () => "md";
      const isOpenApiLanguage = () => false;
      // Stand-ins for what the highlighted element only passes on.
      const [SugarHighCode, FILE_CODE_STYLE] = ["span", codeStyle];
      ${calculations}
      return { lightweightSourceLines, highlightedSource };
    };
  `, { compilerOptions: { jsx: ts.JsxEmit.React } });
  const render = new Function("React", "useMemo", "gutterStyle", "pinnedStyle", "codeStyle", outputText)(React, (calculate) => calculate(), gutterStyle, pinnedStyle, codeStyle);
  const { lightweightSourceLines: rows, highlightedSource } = render({ content: "line\n".repeat(1_000), language: "text" }, "source");
  const numberStyle = rows[0].props.children[0].props.style;
  // The Diff view's first row number, with every row an added line.
  const diffView = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "DiffView");
  const { outputText: diffOutput } = ts.transpileModule(`return ${diffView.getText(file)}`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } });
  const diffNumberStyle = (rowCount) => {
    const added = Array.from({ length: rowCount }, (_, index) => ({ type: "added", text: "line", oldLineNo: null, newLineNo: index + 1 }));
    const DiffView = new Function("React", "useI18n", "diffLines", "SOURCE_HIGHLIGHT_MAX_LINES", "FILE_CODE_STYLE", "FILE_LINE_NUMBER_STYLE", "FILE_PINNED_LINE_NUMBER_STYLE", diffOutput)(
      React, () => ({ t: (key) => key }), () => added, maxRows, codeStyle, gutterStyle, pinnedStyle,
    );
    return DiffView({ patch: "" }).props.children[0].props.children[0].props.children[0].props.style;
  };

  // The pinned gutter is the same column, pinned to the left edge of the
  // viewer's `overflow: auto` content box above the tokens that slide behind it.
  for (const [key, value] of Object.entries(gutterStyle)) assert.equal(pinnedStyle[key], value, key);
  assert.equal(pinnedStyle.position, "sticky");
  assert.equal(pinnedStyle.left, 0);
  assert.ok(pinnedStyle.zIndex >= 1, "the pinned gutter must stack above the scrolling text");
  // Views of at most SOURCE_HIGHLIGHT_MAX_LINES rows pin it: the highlighted
  // Source view (never longer) and a diff up to that many rows.
  assert.deepEqual(highlightedSource.props.lineNumberStyle, pinnedStyle);
  assert.equal(diffNumberStyle(maxRows), pinnedStyle);
  assert.equal(diffNumberStyle(maxRows + 1), gutterStyle);
  // The plain fallback has more rows than that by definition, and the browser
  // repositions every sticky cell on each scroll: its numbers stay unpinned.
  assert.equal(numberStyle, gutterStyle);
  assert.equal(numberStyle.position, undefined);

  // The gutter repeats the code line's height in px, so a code-font change
  // without it puts the numbers off the line boxes they belong to.
  assert.equal(parseFloat(numberStyle.lineHeight), Number((codeStyle.fontSize * codeStyle.lineHeight).toFixed(1)));
});
