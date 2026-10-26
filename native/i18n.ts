// Localization: the browser build's string tables (js/i18n.js, the nine
// StarHermit locales) in the interface language the runtime reports
// (preferences().language: the player's choice in Options › Language, else
// the account's preferred language or the device's). The runtime's Options
// replaced the game's own Language menu (sh-language.js).
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { I18n } from "./classic.ts";

const PRIMARY: Record<string, string> = { en: "en-US", es: "es-419", de: "de-DE", fr: "fr-FR", pt: "pt-BR", it: "it-IT" };

/** The shipped locale nearest a BCP 47 tag (en-GB, es-ES and fr-CA by region). */
export function pickLocale(tag: string): string {
  const t = String(tag || "en-US");
  const exact = I18n.LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.split("-")[0]!.toLowerCase();
  if (lang === "en" && /-(gb|ie|au|nz|za|in)$/i.test(t)) return "en-GB";
  if (lang === "es" && /-es$/i.test(t)) return "es-ES";
  if (lang === "fr" && /-ca$/i.test(t)) return "fr-CA";
  return PRIMARY[lang] ?? "en-US";
}

let locale = "";
const listeners = new Set<() => void>();
function apply(tag: string): void {
  const next = pickLocale(tag);
  if (next === locale) return;
  locale = next;
  I18n.setLocale(locale);
  ui.setLanguage(locale);
  for (const fn of listeners) fn();
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

export function currentLocale(): string { return locale; }
/** fn() after the interface language changed. */
export function onLocaleChange(fn: () => void): void { listeners.add(fn); }

type Vars = Record<string, string | number>;
/** A game string by key in the player's language; `{name}` placeholders from vars. */
export function t(key: string, vars?: Vars | null, fallback?: string): string {
  return I18n.t(key, vars ?? null, fallback);
}

// Colour emoji are not in the runtime's fonts (they draw as boxes): the
// string tables' icons (⛏ in Help's Gather line) are dropped where text is
// drawn. ← → ↑ ↓ ★ ☆ ✓ ○ ♪ are plain text symbols and stay.
const EMOJI = /\s*[\u{1F000}-\u{1FFFF}\u{23E9}-\u{23FA}\u{26CF}\u{26F0}\u{FE0F}]/gu;
/** t() without its emoji icons. */
export function tx(key: string, vars?: Vars | null, fallback?: string): string {
  return t(key, vars, fallback).replace(EMOJI, "").trim();
}
