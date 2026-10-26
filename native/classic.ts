// The browser build's pure game scripts, unchanged and shared with the Node
// tests and the authoritative server (server.js): rng, rules, content,
// session (command ids, undo, replay envelope), store (the save document and
// its cross-device merge) and the string tables (js/*.js, UMD), plus
// js/migrate.js (the engine save document and what the browser build left in
// the account), evaluated as classic scripts so their globals (BSRNG,
// BSRules, BSContent, BSSession, BSStore, BLI18n, BSMigrate) are this
// module's exports.
//
// js/store.js keeps the device's local leaderboard, and js/main.js kept the
// round in progress, in `localStorage`: here that is a small shim over the
// device's starhermit:storage, installed before the scripts run. Progress is
// the game's save (platform.ts).
import { storage } from "starhermit:storage";
import { loadClassic } from "starhermit:script";

const shim = {
  getItem(key: string): string | null {
    try { return storage.getText(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    try { storage.set(key, String(value)); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
  },
  removeItem(key: string): void {
    try { storage.remove(key); } catch { /* gone */ }
  },
};
(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim;

for (const f of ["js/rng.js", "js/rules.js", "js/content.js", "js/session.js", "js/store.js", "js/i18n.js", "js/migrate.js"]) loadClassic(f);

// -- The shapes this client reads -------------------------------------------------
export type Block = "wood" | "stone" | "glass" | "plant" | "lamp" | "rock";
export type Goal = { kind: "count"; type: Block; n: number } | { kind: "height"; n: number } | { kind: "columns"; h: number; n: number };
export interface Mechanics { undo?: boolean; hint?: boolean; remove?: boolean }
export interface Cfg {
  id: string; version: number; kind: string; name: string; seed: number; date?: string; index?: number;
  plot: { cols: number; rows: number; maxH: number };
  blocks: Block[]; start: Partial<Record<Block, number>>; gather: Partial<Record<Block, [number, number]>>;
  goals: Goal[]; rocks: number; moveLimit: number; par: { moves: number } | null;
  mechanics: Mechanics; endless: boolean; theme?: string; intro?: string; mastery?: boolean;
}
export interface Score { place: number; goal: number; win: number; stock: number; par: number; removePenalty: number; waves: number; total: number }
export interface Terminal { reason: string; won: boolean }
export interface RulesEvent { type: string; block?: Block; x?: number; y?: number; h?: number; gains?: Record<string, number>; goal?: Goal; wave?: number; index?: number }
export interface State {
  v: number; cfg: Cfg; seed: number; tick: number; moves: number; grid: Block[][][]; inv: Partial<Record<Block, number>>;
  gathered: number; placed: number; removed: number; wave: number; goalsDone: boolean[]; score: Score;
  elapsedMs: number; terminal: Terminal | null; events: RulesEvent[];
}
export interface Command { type: string; x?: number; y?: number; block?: Block; id?: string; atMs?: number }
export interface Hint { type: string; x?: number; y?: number; block?: Block; why?: string; goal?: number }
export interface Session {
  cfg: Cfg; state: State; initialHash: number; log: Command[]; hashes: { n: number; hash: number }[];
  undoStack: unknown[]; invalid: number; seq: number; terminal: Terminal | null;
}
export interface ExecResult { ok: boolean; reason?: string; duplicate?: boolean; events: RulesEvent[]; state: State }
export interface Envelope { contentId: string; seed: number; score: Score; elapsedMs: number; invalid: number }
export interface Lesson { id: string; title: string; text: string; goal: { event: string; count: number }; cfg: Cfg }
export interface Theme { id: string; name: string; unlockStars: number; palette: Palette }
export interface Palette { sky: number; horizon: number; ground: number; soil: number; sun: number; sunInt: number; fog: number; water: number; leaf: number }
export interface Achievement { key: string; name: string; desc: string }
export interface Progress {
  tutorialDone: Record<string, boolean>; journeyStars: Record<string, number>; journeyBest: Record<string, number>;
  challengeBest: Record<string, number>; dailiesDone: Record<string, number>; endlessBest: number;
  achievements: Record<string, number>;
  stats: { rounds: number; wins: number; placed: number; gathered: number; bestHeight: number; waves: number; playMs: number; funnel?: Record<string, number> };
  cosmetics: { theme: string };
}
export interface Settings {
  captions: boolean; theme: string; colorPalette: string; leftHanded: boolean; haptics: boolean; boardMirror: boolean; confirmMoves: boolean;
  [key: string]: unknown;
}
export interface Doc { v: number; settings: Settings; progress: Progress }
export interface BoardEntry { board: string; name?: string; player?: string; score: number; durationMs?: number; invalid?: number; sessionId: string; at?: number; ruleset?: string; seed?: number }
export interface RngStream { next(): number; range(lo: number, hi: number): number; pick<T>(list: T[]): T; state: number }

interface RulesApi {
  INVALID: Record<string, string>;
  TOPPERS: Record<string, boolean>;
  checkPlace(s: State, x: number, y: number, block: Block): string | null;
  checkRemove(s: State, x: number, y: number): string | null;
  legalTargets(s: State, block: Block): { x: number; y: number }[];
  hint(s: State): Hint | null;
  goalProgress(s: State, g: Goal): { have: number; need: number; done: boolean };
  maxBuiltHeight(s: State): number;
  currentScore(s: State): number;
  validateCommandShape(cmd: Command): string | null;
  applyCommand(s: State, cmd: Command): { ok: boolean; reason?: string; state: State; events: RulesEvent[] };
  createGame(cfg: Cfg): State;
}
interface SessionApi {
  createSession(cfg: Cfg): Session;
  execute(s: Session, fields: Command, atMs?: number): ExecResult;
  canUndo(s: Session): boolean;
  undo(s: Session): { ok: boolean; state?: State };
  envelope(s: Session): Envelope;
}
interface ContentApi {
  CONTENT_VERSION: number;
  BLOCKS: Record<Block, { label: string; color: number; colorHC: number }>;
  THEMES: Theme[]; JOURNEY: Cfg[]; CHALLENGES: Cfg[]; PRACTICE: Cfg[]; SCORE_CHASE: Cfg;
  ACHIEVEMENTS: Achievement[];
  dailyConfig(date: string): Cfg;
  utcDateString(nowMs?: number): string;
  tutorialLessons(): Lesson[];
}
interface StoreApi {
  DEFAULT_SETTINGS: Settings;
  fresh(): Doc;
  loadBoards(): { entries: BoardEntry[] };
  saveBoards(b: { entries: BoardEntry[] }): void;
  sortEntries(e: BoardEntry[]): BoardEntry[];
}
interface RngApi { derive(seed: number, stream: number): RngStream; hashString(s: string): number; STREAM_AV: number }
interface I18nApi {
  t(key: string, vars?: Record<string, string | number> | null, fallback?: string): string;
  setLocale(tag: string): void;
  LOCALES: string[];
  blockLabel(id: string): string;
  cfgName(cfg: Cfg | null | undefined): string;
  cfgIntro(cfg: Cfg | null | undefined): string;
  lessonView(l: Lesson): { id: string; title: string; text: string; goal: Lesson["goal"] };
  achievementView(a: Achievement): { key: string; name: string; desc: string };
  themeName(th: Theme): string;
  readonly lang: string;
}
interface MigrateApi {
  GAME_SETTING_KEYS: string[];
  BROWSER_SETTING_KEYS: string[];
  progressFromSave(doc: unknown): Progress | null;
  docFromBrowserSave(text: string | null): Doc | null;
  saveDoc(progress: Progress): { v: 1; progress: Progress };
  mergeProgress(remote: Progress | null, local: Progress | null): Progress;
  migrateSetting(key: string, value: unknown): unknown;
}

const g = globalThis as unknown as {
  BSRules: RulesApi; BSSession: SessionApi; BSContent: ContentApi; BSStore: StoreApi; BSRNG: RngApi; BLI18n: I18nApi; BSMigrate: MigrateApi;
};
export const Rules = g.BSRules;
export const Session = g.BSSession;
export const Content = g.BSContent;
export const Store = g.BSStore;
export const RNG = g.BSRNG;
export const I18n = g.BLI18n;
export const Migrate = g.BSMigrate;
