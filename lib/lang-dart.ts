import type { ParseOptions } from "sugar-high/core";

// sugar-high ships no Dart preset. This follows the shape of its built-in
// presets (lib/presets/clike-base.js): keyword sets plus scanner hooks, with
// the JavaScript-only scanner modes (jsx/regex/templateStrings) disabled the
// way every non-JS built-in does.
const keywords = new Set([
  "abstract", "as", "assert", "async", "await", "base", "break", "case",
  "catch", "class", "const", "continue", "covariant", "default", "deferred",
  "do", "dynamic", "else", "enum", "export", "extends", "extension",
  "external", "factory", "false", "final", "finally", "for", "get", "hide",
  "if", "implements", "import", "in", "interface", "is", "late", "library",
  "mixin", "new", "null", "on", "operator", "part", "required", "rethrow",
  "return", "sealed", "set", "show", "static", "super", "switch", "sync",
  "this", "throw", "true", "try", "typedef", "var", "void", "when", "while",
  "with", "yield",
]);

// Lowercase built-in types. Capitalized ones (String, Future, List, ...) need
// no entry: sugar-high already classifies capitalized identifiers as classes.
const typeKeywords = new Set(["int", "double", "num", "bool", "Never", "Record"]);

const onCommentStart = (curr: string, next: string): number | boolean => {
  if (curr === "/") {
    if (next === "/") return 1;
    if (next === "*") return 2;
  }
  return 0;
};

const onCommentEnd = (prev: string, curr: string): number | boolean => {
  if (curr === "\n") return 1;
  return prev + curr === "*/" ? 2 : 0;
};

// '''...''' and """...""" multi-line strings. The generic quote scanner would
// stop at the second quote, so consume the whole literal here; onLiteral
// returning 0 falls through to it for ordinary strings.
const onLiteral = (curr: string, index: number, code: string): number | null | undefined => {
  if (curr !== "'" && curr !== '"') return 0;
  const triple = curr.repeat(3);
  if (!code.startsWith(triple, index)) return 0;
  const end = code.indexOf(triple, index + 3);
  return (end === -1 ? code.length : end + 3) - index;
};

export const dartParseOptions: ParseOptions = {
  keywords,
  typeKeywords,
  jsx: false,
  regex: false,
  templateStrings: false,
  onCommentStart,
  onCommentEnd,
  onLiteral,
};
