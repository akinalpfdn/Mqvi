import { describe, it, expect } from "vitest";

/**
 * Every key has to exist in every language, and no file may define one twice.
 *
 * Both failures are silent in production: a key missing from one locale renders as the key name, and
 * a duplicate is legal JSON where the last definition quietly wins — a new string was once added
 * above an existing key of the same name and never appeared at all.
 *
 * Loaded as raw text through Vite rather than read from disk, so the files arrive in source order
 * (JSON.parse collapses duplicates) without dragging Node types into the client tsconfig.
 */
const RAW = import.meta.glob("./locales/*/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

type Locale = { lang: string; namespace: string; raw: string };

const locales: Locale[] = Object.entries(RAW).map(([file, raw]) => {
  const [, lang, namespace] = file.match(/\.\/locales\/([^/]+)\/([^/]+)$/)!;
  return { lang, namespace, raw };
});

const languages = [...new Set(locales.map((l) => l.lang))].sort();

/**
 * Top-level keys in source order.
 *
 * Anchored to a two-space indent: these files nest a few objects, and a nested key may legitimately
 * reuse a name from the outer level. Matching every depth reported those as duplicates.
 */
function keysInOrder(raw: string): string[] {
  return [...raw.matchAll(/^ {2}"([^"]+)"\s*:/gm)].map((m) => m[1]);
}

function namespacesOf(lang: string): string[] {
  return locales.filter((l) => l.lang === lang).map((l) => l.namespace).sort();
}

function rawOf(lang: string, namespace: string): string {
  return locales.find((l) => l.lang === lang && l.namespace === namespace)?.raw ?? "{}";
}

describe("i18n locales", () => {
  it("ships more than one language, or this suite proves nothing", () => {
    expect(languages.length).toBeGreaterThan(1);
  });

  it("defines the same namespaces in every language", () => {
    const reference = namespacesOf(languages[0]);
    for (const lang of languages.slice(1)) {
      expect(namespacesOf(lang), `${lang} has a different set of namespace files`).toEqual(reference);
    }
  });

  it("defines the same keys in every language", () => {
    const [referenceLang] = languages;
    for (const namespace of namespacesOf(referenceLang)) {
      const expected = new Set(keysInOrder(rawOf(referenceLang, namespace)));
      for (const lang of languages.slice(1)) {
        const other = new Set(keysInOrder(rawOf(lang, namespace)));
        const missing = [...expected].filter((k) => !other.has(k));
        const extra = [...other].filter((k) => !expected.has(k));
        expect(missing, `${lang}/${namespace} is missing keys — they render as the key name`).toEqual([]);
        expect(extra, `${lang}/${namespace} has keys ${referenceLang} does not`).toEqual([]);
      }
    }
  });

  it("never defines a key twice in one file", () => {
    const offenders: string[] = [];
    for (const { lang, namespace, raw } of locales) {
      const seen = new Set<string>();
      for (const key of keysInOrder(raw)) {
        if (seen.has(key)) offenders.push(`${lang}/${namespace}: ${key}`);
        seen.add(key);
      }
    }
    // A duplicate is valid JSON and the later definition wins, so the earlier one is dead text that
    // reads as if it were in use.
    expect(offenders).toEqual([]);
  });
});
