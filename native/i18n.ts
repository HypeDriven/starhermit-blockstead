// Localization: assets/strings.json (the nine StarHermit locales) on the
// engine's string tables, in the interface language the runtime reports
// (Options › Language, else the account's or the device's); account lines the
// engine has are its `starhermit.*`.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";
import type { Achievement, Cfg, Lesson, Theme } from "./classic.ts";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
const listeners = new Set<() => void>();
strings.onChange((locale) => { ui.setLanguage(locale); for (const fn of listeners) fn(); });

export function currentLocale(): string { return strings.locale; }
/** fn() after the interface language changed. */
export function onLocaleChange(fn: () => void): void { listeners.add(fn); }

type Vars = Record<string, string | number>;
/** A game string by key in the player's language; `{name}` placeholders from vars. */
export function t(key: string, vars?: Vars | null, fallback?: string): string {
  if (fallback !== undefined && !strings.has(key)) return fallback;
  return strings.t(key, vars ?? undefined);
}

/** Content names in the current language (content keeps English names as data). */
export const I18n = {
  blockLabel(id: string): string { return t("block." + id, null, id); },
  cfgName(cfg: Cfg | null | undefined): string {
    if (!cfg) return "";
    if (cfg.kind === "journey") return t("lvl." + cfg.id, null, cfg.name);
    if (cfg.kind === "challenge") return t("ch." + cfg.id, null, cfg.name);
    if (cfg.kind === "practice") return t("prac." + cfg.id, null, cfg.name);
    if (cfg.kind === "score") return t("score.name", null, cfg.name);
    if (cfg.kind === "daily") return t("daily.name", { date: cfg.date ?? "" });
    if (cfg.kind === "tutorial") return t("les." + cfg.id, null, cfg.name || cfg.id);
    return cfg.name || cfg.id || "";
  },
  cfgIntro(cfg: Cfg | null | undefined): string {
    if (!cfg || !cfg.intro) return "";
    if (cfg.kind === "journey") return t("intro." + cfg.id, null, cfg.intro);
    if (cfg.kind === "challenge") return t("chi." + cfg.id, null, cfg.intro);
    if (cfg.kind === "score") return t("score.intro", null, cfg.intro);
    if (cfg.kind === "daily") return t("daily.intro", null, cfg.intro);
    return cfg.intro;
  },
  lessonView(l: Lesson): { id: string; title: string; text: string; goal: Lesson["goal"] } {
    return { id: l.id, goal: l.goal, title: t("les." + l.id, null, l.title), text: t("lest." + l.id, null, l.text) };
  },
  achievementView(a: Achievement): { key: string; name: string; desc: string } {
    return { key: a.key, name: t("ach." + a.key, null, a.name), desc: t("achd." + a.key, null, a.desc) };
  },
  themeName(th: Theme): string { return t("theme." + th.id, null, th.name); },
};

// Colour emoji are not in the runtime's fonts (they draw as boxes): the
// string tables' icons (⛏ in Help's Gather line) are dropped where text is
// drawn. ← → ↑ ↓ ★ ☆ ✓ ○ ♪ are plain text symbols and stay.
const EMOJI = /\s*[\u{1F000}-\u{1FFFF}\u{23E9}-\u{23FA}\u{26CF}\u{26F0}\u{FE0F}]/gu;
/** t() without its emoji icons. */
export function tx(key: string, vars?: Vars | null, fallback?: string): string {
  return t(key, vars, fallback).replace(EMOJI, "").trim();
}
