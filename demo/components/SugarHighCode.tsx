"use client";

import { memo, useMemo, type CSSProperties } from "react";
import { generate, parse } from "sugar-high/core";
import type { GeneratedToken } from "sugar-high/core";
import { resolveGrammar } from "@/lib/sugar-high-lang";

// Rendered identically without a grammar; skipping parse keeps their DOM flat.
const PLAINTEXT_LANGUAGES = new Set(["text", "plaintext", "likec4", "mermaid"]);

interface PlainLine {
  number: number;
  text: string;
  tokens: null;
}

interface HighlightedLine {
  number: number;
  text: null;
  tokens: GeneratedToken[];
}

type SourceLine = PlainLine | HighlightedLine;

function plainLines(code: string): SourceLine[] {
  return code.split("\n").map((text, index) => ({ number: index + 1, text, tokens: null }));
}

function buildLines(code: string, lang: string | undefined): SourceLine[] {
  if (PLAINTEXT_LANGUAGES.has((lang ?? "").toLowerCase())) return plainLines(code);
  const grammar = resolveGrammar(lang);
  if (!grammar) return plainLines(code);
  try {
    // sugar-high splits every token at newlines, so one generated line equals
    // one source line and the numbering matches FileViewer's sourceLines split.
    return generate(parse(code, grammar)).map((line, index) => ({
      number: index + 1,
      text: null,
      tokens: line.children,
    }));
  } catch {
    // A document the tokenizer chokes on must degrade to unhighlighted lines,
    // never blank the pane.
    return plainLines(code);
  }
}

function TokenSpan({ token }: { token: GeneratedToken }) {
  return (
    <span
      className={token.properties.className}
      style={token.properties.style as CSSProperties}
    >
      {token.children.map((child) => child.value).join("")}
    </span>
  );
}

export interface SugarHighCodeProps {
  code: string;
  /** Fence or file language name; unknown names render plain text. */
  lang?: string;
  lineNumbers?: boolean;
  lineNumberStyle?: CSSProperties;
  wrapLines?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * sugar-high (github.com/huozhi/sugar-high) highlighted source, rendered as
 * one flex row per line. The `.file-source-line[data-line-number]` /
 * `.file-source-line-content` structure is the DOM contract FileViewer's
 * line-selection and @-mention logic reads; colors come from the --sh-*
 * CSS variables (app/globals.css), so themes switch without re-parsing.
 */
export const SugarHighCode = memo(function SugarHighCode({
  code,
  lang,
  lineNumbers = false,
  lineNumberStyle,
  wrapLines = false,
  className,
  style,
}: SugarHighCodeProps) {
  const lines = useMemo(
    () => buildLines(code, lang),
    [code, lang],
  );

  return (
    <div className={className} style={{ display: "block", ...style }}>
      {lines.map((line) => (
        <span
          className="file-source-line"
          data-line-number={line.number}
          key={line.number}
          style={{
            display: "flex",
            minWidth: "100%",
            // The scroller is the pane around this element (or, in chat code
            // blocks, the element itself): width must follow the widest line
            // instead of clipping to the container.
            ...(!wrapLines ? { width: "max-content" } : null),
          }}
        >
          {lineNumbers && (
            <span aria-hidden="true" style={lineNumberStyle}>
              {line.number}
            </span>
          )}
          <span
            className="file-source-line-content"
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              overflowWrap: wrapLines ? "anywhere" : "normal",
              whiteSpace: wrapLines ? "pre-wrap" : "pre",
            }}
          >
            {line.tokens
              ? line.tokens.map((token, tokenIndex) => <TokenSpan key={tokenIndex} token={token} />)
              : line.text}
          </span>
        </span>
      ))}
    </div>
  );
});
