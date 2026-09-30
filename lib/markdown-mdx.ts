import type { Plugin } from "unified";

/**
 * MDX preview support.
 *
 * A real MDX evaluation is out of reach for a file viewer: the imported
 * components live in the project's build, and executing expressions would run
 * arbitrary JavaScript in the page origin. The preview therefore renders MDX
 * *structurally*: markdown renders as markdown, JSX components become labeled
 * placeholder boxes (children still render inside), expressions become muted
 * `{...}` tokens, and import/export statements collapse into a notice chip.
 *
 * remark-mdx (composed into markdownMdxPreviewRemarkPlugins in lib/markdown.ts)
 * parses the MDX syntax (JSX elements, expressions, ESM blocks); this plugin
 * then rewrites those node types into plain mdast nodes through
 * `data.hName`/`data.hProperties`, the same remark-rehype mechanism
 * `remarkKeepLineBreaks` in lib/markdown.ts relies on. rehype-sanitize keeps
 * guarding the output — every emitted node is a normal element allowed by the
 * existing schema, and `className` is allowed on all elements by default.
 */

interface MdxNode {
  type: string;
  name?: string | null;
  value?: string;
  attributes?: MdxJsxAttributeLike[];
  children?: MdxNode[];
  data?: Record<string, unknown>;
}

interface MdxJsxAttributeLike {
  type?: string;
  name: string;
  value?: string | { type?: string; value?: string } | null;
}

const SUMMARY_MAX_LENGTH = 80;

function attributeValue(value: MdxJsxAttributeLike["value"]): string | null {
  if (value == null) return null;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value.value === "string") return `{${value.value.replace(/^\{|\}$/g, "")}}`;
  return "{}";
}

function componentSummary(name: string | null | undefined, attributes: MdxJsxAttributeLike[] | undefined): string {
  const parts: string[] = [];
  for (const attribute of attributes ?? []) {
    if (attribute.type && attribute.type !== "mdxJsxAttribute") continue;
    const value = attributeValue(attribute.value);
    parts.push(value === null ? attribute.name : `${attribute.name}=${value}`);
  }
  let summary = `<${name ?? ""}${parts.length ? ` ${parts.join(" ")}` : ""}`;
  if (!summary.endsWith("/>") && summary.length > SUMMARY_MAX_LENGTH) {
    summary = `${summary.slice(0, SUMMARY_MAX_LENGTH - 1)}…`;
  }
  return `${summary}>`;
}

function inlineCodeNode(value: string, className?: string): MdxNode {
  const node: MdxNode = { type: "inlineCode", value };
  if (className) {
    node.data = { hProperties: { className: [className] } };
  }
  return node;
}

function firstStatementLine(value: string | undefined): string {
  const line = esmStatementLines(value)[0] ?? "";
  return line.length > SUMMARY_MAX_LENGTH ? `${line.slice(0, SUMMARY_MAX_LENGTH - 1)}…` : line;
}

/** Top-level import/export statements, one per line that introduces one. */
function esmStatementLines(value: string | undefined): string[] {
  return (value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:import|export)\b/.test(line));
}

/**
 * Rewrite MDX-only node types into renderable mdast. Children are visited
 * depth-first so nested JSX and expressions inside component bodies convert
 * too.
 */
function rewriteChildren(parent: MdxNode): void {
  const children = parent.children;
  if (!children) return;

  for (let index = children.length - 1; index >= 0; index--) {
    const node = children[index];
    rewriteChildren(node);

    switch (node.type) {
      case "mdxjsEsm": {
        // import/export statements — shown as a notice chip with the first
        // statement, never executed. The statement count rides in a className
        // (rehype-sanitize drops data attributes) for the translated label.
        const statementCount = esmStatementLines(node.value).length || 1;
        children[index] = {
          type: "paragraph",
          data: {
            hName: "div",
            hProperties: { className: ["mdx-esm-notice", `mdx-esm-count-${statementCount}`] },
          },
          children: [inlineCodeNode(firstStatementLine(node.value))],
        };
        break;
      }
      case "mdxFlowExpression": {
        children[index] = {
          type: "paragraph",
          children: [inlineCodeNode(`{${(node.value ?? "").trim()}}`, "mdx-expression")],
        };
        break;
      }
      case "mdxTextExpression": {
        children[index] = inlineCodeNode(`{${(node.value ?? "").trim()}}`, "mdx-expression");
        break;
      }
      case "mdxJsxFlowElement": {
        // A block-level container: label + the component's own children, which
        // stay regular markdown and keep rendering inside the box.
        children[index] = {
          type: "blockquote",
          data: { hName: "div", hProperties: { className: ["mdx-jsx-component"] } },
          children: [
            {
              type: "paragraph",
              data: { hProperties: { className: ["mdx-jsx-component-label"] } },
              children: [inlineCodeNode(componentSummary(node.name, node.attributes))],
            },
            ...(node.children ?? []),
          ],
        };
        break;
      }
      case "mdxJsxTextElement": {
        children[index] = {
          type: "emphasis",
          data: { hName: "span", hProperties: { className: ["mdx-jsx-component-inline"] } },
          children: [
            inlineCodeNode(componentSummary(node.name, node.attributes), "mdx-jsx-component-label"),
            ...(node.children ?? []),
          ],
        };
        break;
      }
      default:
        break;
    }
  }
}

const remarkMdxPlaceholders: Plugin = function () {
  return (tree) => {
    rewriteChildren(tree as MdxNode);
  };
};

export { remarkMdxPlaceholders };