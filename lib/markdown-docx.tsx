import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownPreviewRemarkPlugins, markdownPreviewRehypePlugins, normalizeDisplayMath } from "./markdown";
import { parseFrontmatter, formatFrontmatterValue } from "./frontmatter";
import { resolveLocalFileHref } from "./file-links";
import { encodeFilePathForApi, getFileDirectory, getFileName } from "./file-paths";

export interface MarkdownDocxOptions {
  markdown: string;
  filePath: string;
  cwd?: string;
  sourceSessionId?: string | null;
  withToc: boolean;
  tocTitle: string;
}

/** Export a frozen Markdown snapshot. No server-side remote URL fetching. */
export async function createMarkdownDocx(options: MarkdownDocxOptions): Promise<Blob> {
  const d = await import("docx");
  const { toBlob } = await import("html-to-image");
  const parsed = parseFrontmatter(options.markdown);
  const host = document.createElement("div");
  host.className = "markdown-body markdown-file-preview";
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:640px;padding:16px;background:white;color:black;--text:black;--text-muted:#555;--bg:white;--bg-secondary:#f5f5f5;color-scheme:light";
  host.innerHTML = renderToStaticMarkup(<ReactMarkdown remarkPlugins={markdownPreviewRemarkPlugins} rehypePlugins={markdownPreviewRehypePlugins}>{normalizeDisplayMath(parsed.rest)}</ReactMarkdown>);
  document.body.appendChild(host);
  try {
    await document.fonts.ready;
    for (const code of host.querySelectorAll("code.language-mermaid")) {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "default" });
      const source = code.textContent ?? "";
      if (!await mermaid.parse(source, { suppressErrors: true })) throw new Error("Invalid Mermaid diagram");
      const result = await mermaid.render(`docx-${typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`, source);
      const diagram = document.createElement("div");
      diagram.dataset.docxImage = "true";
      diagram.innerHTML = result.svg;
      (code.closest("pre") ?? code).replaceWith(diagram);
    }
    for (const img of host.querySelectorAll("img")) {
      const src = img.getAttribute("src") ?? "";
      const local = resolveLocalFileHref(src, getFileDirectory(options.filePath), options.cwd ?? getFileDirectory(options.filePath));
      let url = src;
      if (local) {
        const query = new URLSearchParams({ type: "read" });
        if (options.sourceSessionId) query.set("sessionId", options.sourceSessionId);
        url = `/api/files/${encodeFilePathForApi(local)}?${query}`;
      }
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Image unavailable: ${src}`);
      const blob = await response.blob();
      img.src = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      img.loading = "eager";
      await img.decode();
      img.style.maxWidth = "100%";
    }
    const imageRuns = new Map<Element, InstanceType<typeof d.ImageRun>>();
    // KaTeX's outer span contains both MathML and visual HTML: capture it once.
    for (const el of host.querySelectorAll<HTMLElement>(".katex-display, .katex:not(.katex-display .katex), [data-docx-image], img")) {
      if (el.classList.contains("katex")) el.style.display = "inline-block";
      el.style.margin = "0";
      const bounds = el.getBoundingClientRect();
      const blob = await toBlob(el, { backgroundColor: "white", pixelRatio: 2, width: Math.max(1, Math.ceil(bounds.width)), height: Math.max(1, Math.ceil(bounds.height)) });
      if (!blob) throw new Error("Could not render document image");
      const scale = Math.min(1, 640 / Math.max(1, bounds.width), 960 / Math.max(1, bounds.height));
      imageRuns.set(el, new d.ImageRun({ type: "png", data: new Uint8Array(await blob.arrayBuffer()), transformation: { width: Math.max(1, bounds.width * scale), height: Math.max(1, bounds.height * scale) } }));
    }
    type Run = InstanceType<typeof d.TextRun> | InstanceType<typeof d.ImageRun> | InstanceType<typeof d.ExternalHyperlink>;
    function inline(node: Node, style: { bold?: boolean; italics?: boolean; strike?: boolean; font?: string } = {}): Run[] {
      if (node.nodeType === Node.TEXT_NODE) return [new d.TextRun({ text: node.textContent ?? "", ...style })];
      if (!(node instanceof Element)) return [];
      const image = imageRuns.get(node);
      if (image) return [image];
      if (node instanceof HTMLInputElement && node.type === "checkbox") return [new d.TextRun(node.checked ? "☑ " : "☐ ")];
      if (node.tagName === "BR") return [new d.TextRun({ break: 1 })];
      const next = { ...style, ...(["STRONG", "B"].includes(node.tagName) ? { bold: true } : {}), ...(["EM", "I"].includes(node.tagName) ? { italics: true } : {}), ...(node.tagName === "DEL" ? { strike: true } : {}), ...(node.tagName === "CODE" ? { font: "Consolas" } : {}) };
      const runs = Array.from(node.childNodes).flatMap(child => inline(child, next));
      if (node.tagName === "A" && /^(https?:|mailto:)/i.test(node.getAttribute("href") ?? "")) return [new d.ExternalHyperlink({ link: node.getAttribute("href")!, children: runs })];
      return runs;
    }
    type Block = InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>;
    const headings = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5, d.HeadingLevel.HEADING_6];
    function blocks(parent: Element, depth = 0, quote = false): Block[] {
      return Array.from(parent.children).flatMap((el): Block[] => {
        if (["LINK", "STYLE"].includes(el.tagName)) return [];
        if (/^H[1-6]$/.test(el.tagName)) return [new d.Paragraph({ heading: headings[Number(el.tagName[1]) - 1], children: inline(el) })];
        if (el.tagName === "TABLE") return [new d.Table({ width: { size: 100, type: d.WidthType.PERCENTAGE }, rows: Array.from(el.querySelectorAll("tr")).map(row => new d.TableRow({ children: Array.from(row.children).map(cell => new d.TableCell({ children: [new d.Paragraph({ children: inline(cell, { bold: cell.tagName === "TH" }) })] })) })) })];
        if (el.tagName === "UL" || el.tagName === "OL") {
          const ordered = el.tagName === "OL";
          const reference = `list-${listConfigs.length}`;
          if (ordered) listConfigs.push({ reference, levels: Array.from({ length: 9 }, (_, level) => ({ level, format: d.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: d.AlignmentType.START, start: Number(el.getAttribute("start")) || 1, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 260 } } } })) });
          return Array.from(el.children).flatMap(li => {
            const nested = Array.from(li.children).filter(child => ["UL", "OL"].includes(child.tagName));
            const content = Array.from(li.childNodes).filter(child => !nested.includes(child as Element)).flatMap(child => inline(child));
            return [new d.Paragraph({ children: content, ...(ordered ? { numbering: { reference, level: Math.min(depth, 8) } } : { bullet: { level: Math.min(depth, 8) } }) }), ...nested.flatMap(list => blocksList(list, depth + 1))];
          });
        }
        if (el.tagName === "BLOCKQUOTE") return blocks(el, depth, true);
        if (el.tagName === "PRE") return (el.textContent ?? "").replace(/\n$/, "").split("\n").map(line => new d.Paragraph({ children: [new d.TextRun({ text: line, font: "Consolas", size: 18 })], shading: { fill: "F5F5F5" }, spacing: { after: 0 } }));
        if (el.tagName === "HR") return [new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "CCCCCC" } } })];
        return [new d.Paragraph({ children: inline(el), ...(quote ? { indent: { left: 360 }, shading: { fill: "F5F5F5" } } : {}) })];
      });
    }
    function blocksList(list: Element, depth: number): Block[] {
      const container = document.createElement("div");
      // Preserve element identity for embedded image lookups.
      const originalParent = list.parentElement;
      const nextSibling = list.nextSibling;
      container.replaceChildren(list);
      const result = blocks(container, depth);
      originalParent?.insertBefore(list, nextSibling);
      return result;
    }
    const listConfigs: Array<NonNullable<ConstructorParameters<typeof d.Document>[0]["numbering"]>["config"][number]> = [];
    const body = blocks(host);
    if (parsed?.data) {
      body.unshift(new d.Table({ rows: Object.entries(parsed.data).map(([key, value]) => new d.TableRow({ children: [key, formatFrontmatterValue(value)].map(text => new d.TableCell({ children: [new d.Paragraph(text)] })) })) }));
    }
    const doc = new d.Document({
      title: getFileName(options.filePath),
      styles: { default: { document: { run: { font: "Calibri", size: 22 }, paragraph: { spacing: { after: 160 } } } } },
      numbering: { config: listConfigs },
      features: { updateFields: true },
      sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children: [
        ...(options.withToc ? [new d.Paragraph({ children: [new d.TextRun({ text: options.tocTitle, bold: true, size: 32 })] }), new d.TableOfContents(options.tocTitle, { hyperlink: true, headingStyleRange: "1-3" }), new d.Paragraph({ pageBreakBefore: true })] : []),
        ...body,
      ] }],
    });
    return await d.Packer.toBlob(doc);
  } finally {
    host.remove();
  }
}
