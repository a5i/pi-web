import type { ParseOptions } from "sugar-high/core";
import { languages } from "sugar-high/lang";
import { dartParseOptions } from "./lang-dart";

// Grammars sugar-high does not ship, keyed by fence/file language name.
const customGrammars = new Map<string, ParseOptions>([
  ["dart", dartParseOptions],
]);

const grammarByAlias = (() => {
  const map = new Map<string, ParseOptions>();
  for (const [name, grammar] of customGrammars) {
    map.set(name, grammar);
  }
  for (const language of languages) {
    if (!language.config) continue;
    for (const name of [language.id, language.extension, ...language.aliases]) {
      if (!map.has(name)) map.set(name, language.config);
    }
  }
  return map;
})();

/**
 * Resolve a fence or file language name (id, alias, or extension) to a
 * sugar-high grammar. null means the language is unknown and the caller
 * should render plain text.
 */
export function resolveGrammar(name: string | null | undefined): ParseOptions | null {
  if (!name) return null;
  return grammarByAlias.get(name.trim().toLowerCase().replace(/^\./, "")) ?? null;
}
