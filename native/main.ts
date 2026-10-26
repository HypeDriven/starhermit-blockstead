// Blockstead on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, content, session and save document
// are the browser build's unchanged js/*.js (classic.ts); this module is
// what js/main.js did around them — the round (validated commands through
// the session layer with ids and the replay envelope, undo, hints, the
// remove tool, confirm-moves, keyboard target cycling, lessons, the seeded
// weather, terminal → progression, stars, achievements, the device-local
// score boards and the high-score post, the saved round in progress), the
// screen stack (title → modes → setup / journey / learn → play ⇄ pause →
// results, with settings, help, profile and the scores), input routing
// (actions, board taps and drags, wheel zoom, hover ghost) and the
// lifecycle — with the screens and HUD drawn by screens.ts (starhermit:ui)
// and the valley by render.ts (starhermit:scene).
//
// The round clock is the runtime's fixed steps (60 a second), counted only
// while the round is active, so pausing, a hidden window or a slow frame
// never moves it; commands carry it as their atMs (the rules quantize it).
import { frame, onFixedUpdate, onPreferencesChange, onQuit, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { bindingLabel, onAction, onPointerButton, onPointerMove, onTouch, onWheel, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onPlayerChange, onSessionEnded } from "starhermit:platform";
import {
  Content, I18n, RNG, Rules, Session, Store, type Achievement, type Block, type BoardEntry, type Cfg, type Command,
  type Goal, type Lesson, type RulesEvent, type Session as RoundSession, type State,
} from "./classic.ts";
import * as audio from "./audio.ts";
import { onLocaleChange, t } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens, loadArt } from "./screens.ts";
import { applyPalette, initStyles } from "./style.ts";

export type ScreenName = "title" | "modes" | "setup" | "journey" | "learn" | "pause" | "results" | "settings" | "help" | "profile" | "leaderboard";
export interface ResultsView {
  won: boolean; title: string; headline: string; rows: [string, string][]; stars: number;
  achievements: { name: string; desc: string }[]; compare: string; hasNext: boolean; nextLabel: string;
}
export interface SetupView { cfg: Cfg; mode: string; facts: string[]; ranked: boolean; options: { label: string; value: string; active: boolean }[] | null }
type Phase = "title" | "active" | "paused" | "results";
interface Round {
  phase: Phase; session: RoundSession | null; state: State | null; mode: string; levelIndex: number;
  lesson: Lesson | null; lessonEvents: Record<string, number>;
  selectedBlock: Block | null; removeMode: boolean; pendingCell: string | null;
  focusTargets: { x: number; y: number }[]; focusIndex: number;
  elapsedMs: number; introText: string | null; weatherMs: number; weatherStep: number; weatherOrder: ("sun" | "cloud" | "rain")[];
}

export const app = {
  /** The screen stack (title at the root); empty while playing (the HUD shows). */
  stack: ["title"] as ScreenName[],
  /** Frame the top screen opened on (the action that opened it must not also close it). */
  openedFrame: 0,
  focusNext: false,
  toast: null as { text: string; until: number } | null,
  message: null as { text: string; until: number | null } | null,
  caption: null as { text: string; until: number } | null,
  results: null as ResultsView | null,
  lb: null as { pending?: boolean; posted?: boolean; rank?: number | null } | null,
  setup: null as SetupView | null,
  lbActive: "global",
  practiceId: "casual",
  confirmErase: false,
  signedOut: false,
};
export const round: Round = {
  phase: "title", session: null, state: null, mode: "", levelIndex: -1, lesson: null, lessonEvents: {},
  selectedBlock: null, removeMode: false, pendingCell: null, focusTargets: [], focusIndex: -1,
  elapsedMs: 0, introText: null, weatherMs: 0, weatherStep: 0, weatherOrder: ["sun"],
};
export const settings = platform.settings;
const now = (): number => frame().time;
const sessionId = "s" + RNG.hashString(String(Math.random()) + Date.now()).toString(36).slice(0, 8);
export const guestLabel = (): string => t("guest", { id: sessionId.slice(1, 5) });

// ------------------------------------------------------------------ helpers
export function currentScreen(): ScreenName | null { return app.stack.length ? app.stack[app.stack.length - 1]! : null; }
export function goalLabel(g: Goal): string {
  if (g.kind === "count") return t("goal.count", { block: I18n.blockLabel(g.type) });
  if (g.kind === "height") return t("goal.height");
  return t("goal.columns", { h: g.h });
}
export function goalsView(s: State): { label: string; have: number; need: number; done: boolean }[] {
  return s.cfg.goals.map((g, i) => {
    const p = Rules.goalProgress(s, g);
    return { label: goalLabel(g), have: p.have, need: p.need, done: s.goalsDone[i] || p.done };
  });
}
export function movesText(s: State): string {
  return s.cfg.moveLimit ? t("moves.limit", { n: s.moves, max: s.cfg.moveLimit }) : t("moves", { n: s.moves });
}
export function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
export const utcDate = (): string => Content.utcDateString(Date.now());
export function themeById(id: string | undefined): (typeof Content.THEMES)[number] {
  return Content.THEMES.find((th) => th.id === id) ?? Content.THEMES[0]!;
}
/** A key name for the Help cards ("G", "Space", "Esc", "Arrow Left"…), the first binding only. */
export function keyName(action: string): string {
  const raw = bindingLabel(action, "keyboard");
  if (!raw) return "";
  const first = raw.split(/\s*[,/]\s*|\s+or\s+/)[0]!;
  const named: Record<string, string> = { Space: t("key.Space"), Enter: t("key.Enter"), Escape: t("key.Esc"), Esc: t("key.Esc") };
  return named[first] ?? first;
}
export function announce(msg: string): void { if (msg) ui.announce(msg); }
export function toast(text: string): void { app.toast = { text, until: now() + 2.4 }; announce(text); }
/** The HUD guidance line (sticky until the next one, else 2.6 s). */
export function message(text: string, sticky = false): void {
  app.message = text ? { text, until: sticky ? null : now() + 2.6 } : null;
  if (text) announce(text);
}
function haptic(ms: number): void {
  if (settings.haptics) { try { vibrate(ms); } catch { /* no vibration here */ } }
}
audio.setOnCaption((event) => {
  if (settings.captions) app.caption = { text: t("cap." + event), until: now() + 1.6 };
});
function funnel(key: string): void {
  const f = (platform.progress.stats.funnel ??= {});
  f[key] = (f[key] ?? 0) + 1;
  platform.persist();
}

// ------------------------------------------------------------------ screens
/** Shows a screen: the title resets the stack, `replace` swaps the top. */
export function showScreen(name: ScreenName, replace = false): void {
  if (name === "title") app.stack = ["title"];
  else if (replace && app.stack.length) app.stack[app.stack.length - 1] = name;
  else if (currentScreen() !== name) app.stack.push(name);
  app.openedFrame = frame().frame;
  app.focusNext = true;
  app.confirmErase = false;
  announce(t("scr." + name, null, name));
  if (name === "title") showTitle();
}
/** Back one screen (an overlay over the round goes back to the round). */
export function back(): void {
  if (app.stack.length > 1) app.stack.pop();
  else if (round.phase !== "title" && app.stack.length) app.stack.pop();
  app.openedFrame = frame().frame;
  app.focusNext = true;
  if (!app.stack.length && round.phase === "paused") resumeRound();
  if (currentScreen() === "title") showTitle();
}
/** The HUD only (the round plays). */
function hideScreens(): void { app.stack = []; ui.setFocus(null); }

function showTitle(): void {
  round.phase = "title";
  render.showShowcase();
  render.setPalette(themeById(settings.theme).palette, hv());
  audio.setWeather("sun");
  render.setWeather("sun");
}
export const hasSnapshot = (): boolean => loadRoundSnapshot() !== null;

// ------------------------------------------------------------------ the round
const hv = (): boolean => preferences().highContrast || settings.colorPalette === "high-visibility";

function legalCellSet(): Set<string> {
  const set = new Set<string>();
  const s = round.state;
  if (!s || s.terminal) return set;
  if (round.removeMode) {
    for (let y = 0; y < s.cfg.plot.rows; y++) for (let x = 0; x < s.cfg.plot.cols; x++) if (Rules.checkRemove(s, x, y) === null) set.add(x + "," + y);
  } else if (round.selectedBlock) {
    for (const c of Rules.legalTargets(s, round.selectedBlock)) set.add(c.x + "," + c.y);
  }
  return set;
}
export function legalCells(): Set<string> { return legalCellSet(); }
function refreshScene(events?: RulesEvent[]): void {
  const s = round.state;
  if (!s) return;
  render.show(s, events);
  const cells: { x: number; y: number; h: number }[] = [];
  for (const key of legalCellSet()) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    const h = s.grid[y]![x]!.length;
    cells.push({ x, y, h: round.removeMode ? h - 1 : h });
  }
  render.highlightTargets(cells, round.selectedBlock);
}
export function invalidText(reason: string): string { return t("inv." + reason, null, t("inv.default")); }

export function execute(fields: Command): void {
  if (!round.session || round.phase !== "active") return;
  const res = Session.execute(round.session, fields, round.elapsedMs);
  if (!res.ok) {
    if (!res.duplicate) { audio.play("invalid"); haptic(30); message(invalidText(res.reason ?? "")); }
    return;
  }
  if (res.duplicate) return;
  round.state = res.state;
  processEvents(res.events);
  refreshScene(res.events);
  checkLesson(res.events);
  if (!round.state) return; // a completed lesson already left the round
  if (round.state.terminal) { endRound(); return; }
  saveRoundSnapshot();
}

function processEvents(events: RulesEvent[]): void {
  const p = platform.progress;
  for (const e of events) {
    switch (e.type) {
      case "gather": {
        audio.play("gather"); haptic(15);
        p.stats.gathered++;
        const gains = Object.entries(e.gains ?? {}).map(([b, n]) => n + " " + I18n.blockLabel(b)).join(", ");
        message(t("msg.gathered", { list: gains }));
        break;
      }
      case "place":
        audio.play("place-" + e.block); haptic(20);
        if ((e.h ?? 0) >= 5) unlock("tower-5");
        p.stats.placed++;
        unlock("first-place");
        break;
      case "remove": audio.play("remove"); haptic(20); break;
      case "goal":
        audio.play("goal"); haptic(40);
        message(t("msg.goal", { g: goalLabel(e.goal!) }));
        announce(t("an.goal", { g: goalLabel(e.goal!) }));
        break;
      case "wave": audio.play("wave"); message(t("msg.wave", { n: e.wave ?? 0 })); break;
      case "win": audio.play("win"); break;
      case "lose": audio.play("lose"); break;
    }
  }
}

function seedWeather(seed: number): void {
  const rng = RNG.derive(seed >>> 0, 0x51ed270b);
  round.weatherOrder = ["sun"];
  for (let i = 0; i < 5; i++) round.weatherOrder.push(rng.pick(["sun", "sun", "cloud", "rain"] as const));
  round.weatherMs = 0; round.weatherStep = 0;
  render.setWeather("sun"); audio.setWeather("sun");
}
/** Every 40 s of play the seeded weather moves on (cosmetic). */
function weatherTick(ms: number): void {
  round.weatherMs += ms;
  if (round.weatherMs < 40000) return;
  round.weatherMs -= 40000;
  round.weatherStep = (round.weatherStep + 1) % round.weatherOrder.length;
  const w = round.weatherOrder[round.weatherStep]!;
  render.setWeather(w);
  audio.setWeather(w);
  if (w === "rain") audio.play("weather-rain");
  else if (w === "cloud") audio.play("weather-cloud");
}

function beginRound(sess: RoundSession, mode: string, levelIndex: number): void {
  const cfg = sess.cfg;
  round.session = sess;
  round.state = sess.state;
  round.mode = mode;
  round.levelIndex = levelIndex;
  round.lesson = null; round.lessonEvents = {};
  round.selectedBlock = cfg.blocks[0] ?? null;
  round.removeMode = false;
  round.pendingCell = null;
  round.focusTargets = []; round.focusIndex = -1;
  round.elapsedMs = sess.state.elapsedMs;
  round.phase = "active";
  audio.start();
  audio.setPaused(false);
  audio.setAvRng(RNG.derive(cfg.seed >>> 0, RNG.STREAM_AV));
  render.setPalette(themeById(cfg.theme ?? settings.theme).palette, hv());
  render.show(sess.state, [], false);
  render.ghost(null);
  render.skipAnimations();
  seedWeather(cfg.seed);
  hideScreens();
  app.results = null;
  audio.play("round-start");
  refreshScene();
}
export function startRound(cfg: Cfg, mode: string, levelIndex = -1): void {
  beginRound(Session.createSession(cfg), mode, levelIndex);
  round.introText = cfg.intro ? I18n.cfgIntro(cfg) : null;
  message(round.introText ?? "", !!cfg.intro);
  funnel("start-" + mode);
  announce(t("an.roundStart", { x: I18n.cfgIntro(cfg) || I18n.cfgName(cfg) }));
  saveRoundSnapshot();
}

function endRound(): void {
  round.phase = "results";
  const s = round.state!;
  const p = platform.progress;
  p.stats.rounds++;
  if (s.terminal!.won) p.stats.wins++;
  p.stats.bestHeight = Math.max(p.stats.bestHeight, Rules.maxBuiltHeight(s));
  p.stats.playMs += s.elapsedMs;
  const before = new Set(Object.keys(p.achievements));
  if (s.terminal!.won) {
    unlock("first-win");
    if (s.score.total >= 2500) unlock("score-2500");
  }
  if (round.mode === "journey" && s.terminal!.won) {
    let stars = 1;
    if (s.cfg.par && s.moves <= s.cfg.par.moves) stars++;
    if (s.removed === 0) stars++;
    p.journeyStars[s.cfg.id] = Math.max(p.journeyStars[s.cfg.id] ?? 0, stars);
    p.journeyBest[s.cfg.id] = Math.max(p.journeyBest[s.cfg.id] ?? 0, s.score.total);
    const done = Object.keys(p.journeyStars).length;
    if (done >= 20) unlock("journey-half");
    if (done >= Content.JOURNEY.length) unlock("journey-done");
  }
  if (round.mode === "daily" && s.terminal!.won) {
    const date = s.cfg.date!;
    p.dailiesDone[date] = Math.max(p.dailiesDone[date] ?? 0, s.score.total);
    if (Object.keys(p.dailiesDone).length >= 7) unlock("daily-7");
  }
  if (round.mode === "challenge" && s.terminal!.won) {
    p.challengeBest[s.cfg.id] = Math.max(p.challengeBest[s.cfg.id] ?? 0, s.score.total);
    if (Content.CHALLENGES.every((c) => (p.challengeBest[c.id] ?? 0) > 0)) unlock("challenger");
  }
  if (round.mode === "score") {
    p.endlessBest = Math.max(p.endlessBest, s.score.total);
    p.stats.waves = Math.max(p.stats.waves, s.wave);
  }
  if (p.stats.placed >= 500) unlock("blocks-500");
  platform.persist();
  const achievements = Object.keys(p.achievements).filter((k) => !before.has(k))
    .map((k) => Content.ACHIEVEMENTS.find((a) => a.key === k)).filter((a): a is Achievement => !!a);
  funnel("round-end-" + (s.terminal!.won ? "win" : "lose"));
  clearRoundSnapshot();
  lastAchievements = achievements;
  app.lb = null;
  showResults();
  submitScore();
}
let lastAchievements: Achievement[] = [];

function unlock(key: string): void {
  const p = platform.progress;
  if (p.achievements[key]) return;
  p.achievements[key] = Date.now();
  platform.persist(); // mid-round unlocks survive a closed window
  audio.play("star");
  announce(t("an.achievement"));
}

/** The results card from the finished round (rebuilt on a language change). */
export function resultsView(): ResultsView | null {
  const s = round.state;
  if (!s || !s.terminal) return null;
  const won = s.terminal.won;
  const rows: [string, string][] = [
    [t("r.placed"), "+" + s.score.place], [t("r.goals"), "+" + s.score.goal], [t("r.bonus"), "+" + s.score.win],
    [t("r.stock"), "+" + s.score.stock], [t("r.par"), "+" + s.score.par], [t("r.removed"), "−" + s.score.removePenalty],
    [t("r.waves"), s.wave > 1 ? String(s.wave - 1) : "—"], [t("r.total"), String(s.score.total)],
  ];
  const stars = round.mode === "journey" && won ? platform.progress.journeyStars[s.cfg.id] ?? 1 : 0;
  const hasNext = round.mode === "journey" && won && round.levelIndex + 1 < Content.JOURNEY.length;
  return {
    won, title: won ? t("r.won") : t("results.over"),
    headline: won ? t("r.wonHead", { name: I18n.cfgName(s.cfg), n: s.moves })
      : t("r.lostHead", { reason: t("term." + s.terminal.reason, null, s.terminal.reason), n: s.score.total }),
    rows, stars, achievements: lastAchievements.map((a) => I18n.achievementView(a)),
    compare: won ? t("r.compare", { t: fmtClock(s.elapsedMs), p: s.cfg.par ? s.cfg.par.moves : "—" }) : "",
    hasNext, nextLabel: hasNext ? t("r.nextName", { name: I18n.cfgName(Content.JOURNEY[round.levelIndex + 1]) }) : t("btn.next"),
  };
}
function showResults(): void {
  app.results = resultsView();
  app.stack = ["results"];
  app.openedFrame = frame().frame;
  app.focusNext = true;
  const s = round.state!;
  announce(s.terminal!.won ? t("an.stageDone", { n: s.score.total }) : t("an.roundOver", { n: s.score.total }));
}

// ------------------------------------------------------------------ score boards
function rankedBoard(): string | null {
  const s = round.state;
  if (!s) return null;
  if (round.mode === "daily") return "daily:" + s.cfg.date;
  if (round.mode === "score") return "global";
  if (round.mode === "journey") return "journey:" + s.cfg.id;
  if (round.mode === "challenge") return "challenge:" + s.cfg.id;
  return null; // practice / learn: unranked
}
function submitScore(): void {
  const board = rankedBoard();
  if (!board || !round.session) return;
  const total = round.state!.score.total;
  if (platform.signedIn()) {
    app.lb = { pending: true };
    const lb = app.lb;
    void platform.postLeaderboard(total).then((r) => { if (app.lb === lb) app.lb = r; });
  }
  const env = Session.envelope(round.session);
  const entry: BoardEntry = {
    board, name: platform.displayName() ?? guestLabel(), score: env.score.total, durationMs: env.elapsedMs, invalid: env.invalid,
    sessionId, at: Date.now(), ruleset: env.contentId, seed: env.seed,
  };
  const uid = platform.userId();
  if (uid) entry.player = uid;
  const boards = Store.loadBoards();
  boards.entries.push(entry);
  Store.saveBoards(boards);
}

// ------------------------------------------------------------------ the round in progress (device)
const ROUND_KEY = "blockstead.round.v1";
interface Snapshot { cfg: Cfg; commands: Command[]; mode: string; levelIndex: number; at: number }
function saveRoundSnapshot(): void {
  if (!round.session || !round.state || round.state.terminal) return;
  try {
    localStorage.setItem(ROUND_KEY, JSON.stringify({ cfg: round.session.cfg, commands: round.session.log, mode: round.mode, levelIndex: round.levelIndex, at: Date.now() }));
  } catch { /* the round stays in memory */ }
}
export function clearRoundSnapshot(): void { try { localStorage.removeItem(ROUND_KEY); } catch { /* gone */ } }
function loadRoundSnapshot(): Snapshot | null {
  try {
    const raw = localStorage.getItem(ROUND_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as Snapshot;
    return snap && snap.cfg && Array.isArray(snap.commands) ? snap : null;
  } catch { return null; }
}
declare const localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
function resumeSnapshot(snap: Snapshot): boolean {
  const sess = Session.createSession(snap.cfg);
  for (const cmd of snap.commands) {
    if (Rules.validateCommandShape(cmd)) return false;
    const res = Rules.applyCommand(sess.state, cmd);
    if (!res.ok) return false;
    sess.state = res.state;
    sess.log.push(cmd);
  }
  beginRound(sess, snap.mode || "practice", snap.levelIndex ?? -1);
  round.introText = null;
  toast(t("toast.restored"));
  announce(t("an.restored", { moves: movesText(sess.state) }));
  return true;
}
/** Title › Play: the saved round, else the modes. */
export function play(): void {
  const snap = loadRoundSnapshot();
  if (snap && resumeSnapshot(snap)) return;
  showScreen("modes");
}

// ------------------------------------------------------------------ interaction
export function onCellPicked(x: number, y: number): void {
  if (round.phase !== "active" || !round.state) return;
  audio.play("select");
  if (settings.confirmMoves) {
    const key = x + "," + y;
    if (round.pendingCell !== key) {
      round.pendingCell = key;
      message(t("msg.confirm"));
      showGhost(x, y);
      return;
    }
    round.pendingCell = null;
  }
  commitCell(x, y);
}
/** A tap on the text board (the same as a plot tap; confirm-moves asks twice). */
export function onMirrorCell(x: number, y: number): void {
  if (round.phase !== "active") return;
  if (settings.confirmMoves) { onCellPicked(x, y); return; }
  commitCell(x, y);
}
function commitCell(x: number, y: number): void {
  if (round.removeMode) execute({ type: "remove", x, y });
  else if (round.selectedBlock) execute({ type: "place", x, y, block: round.selectedBlock });
  else message(t("msg.pickBlock"));
}
function showGhost(x: number, y: number): void {
  const s = round.state;
  if (!s) return;
  const st = s.grid[y]![x]!;
  if (round.removeMode) {
    const reason = Rules.checkRemove(s, x, y);
    render.ghost(x, y, Math.max(0, st.length - 1), reason === null);
    if (reason) message(invalidText(reason));
  } else if (round.selectedBlock) {
    const reason = Rules.checkPlace(s, x, y, round.selectedBlock);
    render.ghost(x, y, st.length, reason === null);
    if (reason) message(invalidText(reason));
  }
}
let hovered = "";
function onHover(cell: { x: number; y: number } | null): void {
  const key = cell ? cell.x + "," + cell.y : "";
  if (key === hovered) return;
  hovered = key;
  if (round.phase !== "active" || !round.state) return;
  if (!cell) { render.ghost(null); return; }
  showGhost(cell.x, cell.y);
}
function rebuildFocusTargets(): void {
  round.focusTargets = [...legalCellSet()].map((k) => { const [x, y] = k.split(",").map(Number) as [number, number]; return { x, y }; });
  round.focusIndex = round.focusTargets.length ? 0 : -1;
}
function moveFocus(d: number): void {
  if (!round.focusTargets.length) rebuildFocusTargets();
  if (!round.focusTargets.length) { message(t("msg.noTargets")); return; }
  round.focusIndex = (round.focusIndex + d + round.focusTargets.length) % round.focusTargets.length;
  const tg = round.focusTargets[round.focusIndex]!;
  showGhost(tg.x, tg.y);
  announce(t("an.target", { x: tg.x + 1, y: tg.y + 1 }));
}
function placeFocused(): void {
  const tg = round.focusIndex >= 0 ? round.focusTargets[round.focusIndex] : undefined;
  if (!tg) { moveFocus(0); return; }
  commitCell(tg.x, tg.y);
  rebuildFocusTargets();
}
export function selectBlock(b: Block): void {
  round.selectedBlock = b;
  round.removeMode = false;
  audio.play("select");
  rebuildFocusTargets();
  refreshScene();
  announce(t("an.selected", { b: I18n.blockLabel(b) }));
}
function cycleBlock(d: number): void {
  const blocks = round.state?.cfg.blocks ?? [];
  if (!blocks.length) return;
  const i = round.selectedBlock ? blocks.indexOf(round.selectedBlock) : -1;
  selectBlock(blocks[(i + d + blocks.length) % blocks.length]!);
}
export function toggleRemove(): void {
  const s = round.state;
  if (!s) return;
  if (s.cfg.mechanics.remove === false) { message(invalidText("remove-disabled")); audio.play("invalid"); return; }
  round.removeMode = !round.removeMode;
  audio.play(round.removeMode ? "select" : "deselect");
  rebuildFocusTargets();
  refreshScene();
  announce(round.removeMode ? t("an.removeOn") : t("an.removeOff"));
}
export function doUndo(): void {
  if (!round.session || round.phase !== "active") return;
  if (!Session.canUndo(round.session)) {
    message(round.state!.cfg.mechanics.undo === false ? t("msg.undoOff") : t("msg.noUndo"));
    audio.play("invalid");
    return;
  }
  Session.undo(round.session);
  round.state = round.session.state;
  audio.play("undo");
  checkLesson([{ type: "undo" }]);
  if (!round.state) return; // the undo lesson just completed and left the round
  rebuildFocusTargets();
  refreshScene();
  saveRoundSnapshot();
}
export function doHint(): void {
  const s = round.state;
  if (!s || round.phase !== "active") return;
  if (s.cfg.mechanics.hint === false) { message(t("msg.hintOff")); audio.play("invalid"); return; }
  const h = Rules.hint(s);
  audio.play("hint");
  if (!h) { message(t("msg.noHint")); return; }
  if (h.type === "gather") {
    const need = /^need-/.test(h.why ?? "") ? h.why!.slice(5) : null;
    message(t("hint.gather", { what: need ? I18n.blockLabel(need) : t("hint.supplies") }));
  } else if (h.block) {
    const text = t("hint.place", { b: I18n.blockLabel(h.block), x: (h.x ?? 0) + 1, y: (h.y ?? 0) + 1 });
    selectBlock(h.block);
    message(text);
    showGhost(h.x!, h.y!);
  }
}
export function gather(): void { execute({ type: "gather" }); }
export function skip(): void { render.skipAnimations(); message(t("msg.skipped")); }

// ------------------------------------------------------------------ pause / leave
export function togglePause(): void {
  if (round.phase === "active") pauseRound();
  else if (round.phase === "paused") resumeRound();
}
export function pauseRound(): void {
  if (round.phase !== "active") return;
  round.phase = "paused";
  audio.play("pause");
  audio.setPaused(true);
  saveRoundSnapshot();
  app.stack = ["pause"];
  app.openedFrame = frame().frame;
  app.focusNext = true;
  announce(t("scr.pause"));
}
export function resumeRound(): void {
  if (round.phase !== "paused") return;
  round.phase = "active";
  audio.setPaused(false);
  audio.play("resume");
  hideScreens();
}
/** Pause › Leave round (resigned, recorded) or a finished results card: back to the title. */
export function leaveRound(silent: boolean): void {
  if (round.session && round.state && !round.state.terminal && !silent) Session.execute(round.session, { type: "resign" }, 0);
  clearRoundSnapshot();
  round.phase = "title";
  round.session = null; round.state = null; round.lesson = null;
  app.message = null;
  render.ghost(null);
  render.highlightTargets([], null);
}
export function restartRound(): void {
  if (!round.session) return;
  const cfg = round.session.cfg, mode = round.mode, idx = round.levelIndex;
  funnel("retry");
  startRound(cfg, mode, idx);
}
export function nextStage(): void {
  if (round.mode === "journey" && round.levelIndex + 1 < Content.JOURNEY.length) {
    const next = round.levelIndex + 1;
    startRound(Content.JOURNEY[next]!, "journey", next);
  }
}

// ------------------------------------------------------------------ lessons
export function startLesson(id: string): void {
  const lesson = Content.tutorialLessons().find((l) => l.id === id);
  if (!lesson) return;
  startRound(lesson.cfg, "learn", -1);
  round.lesson = lesson;
  message("");
  funnel("tutorial-" + id);
}
export function lessonProgress(): string {
  const l = round.lesson;
  if (!l) return "";
  const n = round.lessonEvents[l.goal.event] ?? 0;
  return Math.min(n, l.goal.count) + "/" + l.goal.count;
}
function checkLesson(events: RulesEvent[]): void {
  const l = round.lesson;
  if (!l) return;
  for (const e of events) if (e.type === l.goal.event) round.lessonEvents[e.type] = (round.lessonEvents[e.type] ?? 0) + 1;
  const n = round.lessonEvents[l.goal.event] ?? 0;
  const won = !!round.state?.terminal?.won;
  if (n >= l.goal.count || (l.goal.event === "win" && won)) {
    platform.progress.tutorialDone[l.id] = true;
    platform.persist();
    funnel("tutorial-done-" + l.id);
    audio.play("lesson-complete");
    const title = I18n.lessonView(l).title;
    toast(t("toast.lesson", { t: title }));
    round.lesson = null;
    if (!round.state?.terminal) {
      leaveRound(true);
      app.stack = ["title", "learn"];
      app.openedFrame = frame().frame;
      app.focusNext = true;
      render.showShowcase();
    }
  }
}
export function quitLesson(): void {
  round.lesson = null;
  leaveRound(true);
  render.showShowcase();
  app.stack = ["title", "learn"];
  app.openedFrame = frame().frame;
  app.focusNext = true;
}

// ------------------------------------------------------------------ modes and setup
export function selectMode(id: string): void {
  if (id === "learn") { showScreen("learn"); return; }
  if (id === "journey") { showScreen("journey"); return; }
  if (id === "challenge") {
    const next = Content.CHALLENGES.find((c) => !platform.progress.challengeBest[c.id]) ?? Content.CHALLENGES[0]!;
    challengeSetup(next);
    return;
  }
  setupFor(id);
  showScreen("setup", currentScreen() === "setup");
}
/** The setup card's facts for a mode (re-run on a language change). */
export function setupFor(id: string): void {
  if (id === "daily") {
    const date = utcDate();
    const cfg = Content.dailyConfig(date);
    app.setup = {
      cfg, mode: "daily", ranked: true, options: null,
      facts: [t("f.dailySeed", { date }), t("f.expected"), cfg.moveLimit ? t("f.moveLimit", { n: cfg.moveLimit }) : t("f.noLimit"), t("f.undoHints")],
    };
  } else if (id === "practice") {
    const p = Content.PRACTICE.find((x) => x.id === app.practiceId) ?? Content.PRACTICE[0]!;
    app.setup = {
      cfg: p, mode: "practice", ranked: false,
      facts: [t("f.difficulty", { d: I18n.cfgName(p) }), t("f.restartUndo"), t("f.noRating")],
      options: Content.PRACTICE.map((x) => ({ label: I18n.cfgName(x), value: x.id, active: x.id === p.id })),
    };
  } else if (id === "score") {
    app.setup = {
      cfg: Content.SCORE_CHASE, mode: "score", ranked: true, options: null,
      facts: [t("f.endless"), t("f.noAssist"), t("f.best", { n: platform.progress.endlessBest })],
    };
  } else if (id === "challenge" && app.setup) {
    challengeSetup(app.setup.cfg, true);
  }
}
function challengeFacts(c: Cfg): string[] {
  const f: string[] = [];
  if (c.moveLimit) f.push(t("f.moveLimit", { n: c.moveLimit }));
  if (c.mechanics.remove === false) f.push(t("f.removeLocked"));
  if (c.mechanics.undo === false) f.push(t("f.noUndo"));
  if (c.mechanics.hint === false) f.push(t("f.noHints"));
  if (c.rocks) f.push(t("f.rocks", { n: c.rocks }));
  f.push(t("f.expected"));
  return f;
}
export function challengeSetup(c: Cfg, rerender = false): void {
  app.setup = {
    cfg: c, mode: "challenge", ranked: true, facts: challengeFacts(c),
    options: Content.CHALLENGES.map((x) => ({ label: I18n.cfgName(x) + (platform.progress.challengeBest[x.id] ? " ✓" : ""), value: x.id, active: x.id === c.id })),
  };
  if (!rerender) showScreen("setup", currentScreen() === "setup");
}
export function setupOption(value: string): void {
  const s = app.setup;
  if (!s) return;
  if (s.mode === "practice") { app.practiceId = value; setupFor("practice"); }
  else if (s.mode === "challenge") {
    const c = Content.CHALLENGES.find((x) => x.id === value);
    if (c) challengeSetup(c, true);
  }
}
export function startSetupRound(): void { if (app.setup) startRound(app.setup.cfg, app.setup.mode, -1); }
export function selectTheme(id: string): void {
  platform.setSetting("theme", id);
  platform.progress.cosmetics.theme = id;
  platform.persist();
  render.setPalette(themeById(round.state?.cfg.theme ?? id).palette, hv());
  toast(t("toast.theme", { name: I18n.themeName(themeById(id)) }));
}
export function eraseAll(): void {
  platform.resetAll();
  clearRoundSnapshot();
  showScreen("title");
  toast(t("toast.erased"));
}

// ------------------------------------------------------------------ input
const playing = (): boolean => round.phase === "active" && !app.stack.length;
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const a = e.action;
  if (a === "pause" || (a === "back" && round.phase !== "title" && round.phase !== "results")) {
    if (frame().frame === app.openedFrame) return;
    if (round.phase === "active" && !app.stack.length) { pauseRound(); return; }
    if (round.phase === "paused") {
      // An overlay over the paused round (settings, help) goes back to pause; pause itself resumes.
      if (currentScreen() === "pause" || !app.stack.length) resumeRound(); else back();
      return;
    }
  }
  if (a === "back") {
    if (frame().frame === app.openedFrame) return;
    if (app.stack.length > 1) back();
    else if (currentScreen() === "results") { leaveRound(true); showScreen("title"); }
    return;
  }
  if (!playing()) return;
  if (ui.focused()) ui.setFocus(null);
  const m = /^block([1-5])$/.exec(a);
  if (m) { const b = round.state!.cfg.blocks[Number(m[1]) - 1]; if (b) selectBlock(b); return; }
  switch (a) {
    case "prev": moveFocus(-1); break;
    case "next": moveFocus(1); break;
    case "place": placeFocused(); break;
    case "gather": gather(); break;
    case "remove": toggleRemove(); break;
    case "undo": doUndo(); break;
    case "hint": doHint(); break;
    case "camera": render.resetCamera(); break;
    case "topdown": render.topDownCamera(); break;
    case "skip": skip(); break;
    case "prev_block": cycleBlock(-1); break;
    case "next_block": cycleBlock(1); break;
  }
});

// Board taps and drags: a press and release within 8 px and 600 ms is a tap
// on the column under it; a longer drag orbits the camera. The mouse wheel
// zooms; the mouse hovering shows the ghost. Touch and the mouse can both
// report one tap: a pointer press right after a touch is skipped.
let down: { at: number; x: number; y: number; lx: number; ly: number; moved: number } | null = null;
let lastTouch = -1e9;
const boardActive = (): boolean => round.phase === "active" && !app.stack.length;
function boardDown(x: number, y: number): void {
  down = boardActive() && !ui.pointerOver() ? { at: now(), x, y, lx: x, ly: y, moved: 0 } : null;
}
function boardMove(x: number, y: number, mouse: boolean): void {
  if (down) {
    const dx = x - down.lx, dy = y - down.ly;
    down.moved += Math.abs(dx) + Math.abs(dy);
    down.lx = x; down.ly = y;
    const sc = frame().scale;
    if (down.moved > 8 * sc) render.orbit(dx / sc, dy / sc);
  } else if (mouse && boardActive() && !ui.pointerOver()) onHover(render.pick(x, y));
}
function boardUp(x: number, y: number): void {
  const d = down;
  down = null;
  if (!d || !boardActive()) return;
  if (now() - d.at > 0.6 || d.moved > 8 * frame().scale) return;
  const c = render.pick(x, y);
  if (c) onCellPicked(c.x, c.y);
  else onHover(null);
}
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  if (e.pressed) boardDown(e.x, e.y); else boardUp(e.x, e.y);
});
onPointerMove((x, y) => { if (now() - lastTouch >= 0.6) boardMove(x, y, true); });
onWheel((_dx, dy) => { if (boardActive() && !ui.pointerOver()) render.zoom(dy); });
onTouch((e) => {
  if (!e.primary) return;
  lastTouch = now();
  if (e.phase === "start") boardDown(e.x, e.y);
  else if (e.phase === "move") boardMove(e.x, e.y, false);
  else if (e.phase === "end") boardUp(e.x, e.y);
  else down = null;
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const key = `${f.quality}:${f.levelIndex}`;
  if (key === lookKey) return;
  lookKey = key;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyPrefs(): void {
  const p = preferences();
  render.setReducedMotion(p.reducedMotion);
  applyPalette(p.highContrast, settings.colorPalette === "high-visibility");
  render.setPalette(themeById(round.state?.cfg.theme ?? settings.theme).palette, hv());
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  applyLook();
  applyPrefs();
  loadArt();
  showScreen("title");
  funnel("boot");
});
onPreferencesChange(() => applyPrefs());
onLocaleChange(() => {
  if (app.results) app.results = resultsView();
  if (app.setup && currentScreen() === "setup") setupFor(app.setup.mode);
  if (round.introText && round.state && app.message?.text === round.introText) {
    round.introText = I18n.cfgIntro(round.state.cfg);
    app.message.text = round.introText;
  }
});
platform.onSettingsChange(() => applyPrefs());
platform.onProgressMerged(() => { if (app.results) app.results = resultsView(); });
onSessionEnded(() => { app.signedOut = true; toast(t("acct.signedOut")); });
onPlayerChange((p) => { if (p) app.signedOut = false; });
onSuspend(() => {
  // Backgrounding pauses the round; nothing is lost.
  if (round.phase === "active") pauseRound();
  platform.flush();
});
onResume(() => undefined);
onQuit(() => { saveRoundSnapshot(); platform.flush(); });

onFixedUpdate(() => {
  if (round.phase !== "active" || app.stack.length) return;
  round.elapsedMs += 1000 / 60;
  weatherTick(1000 / 60);
});
let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  const t0 = now();
  if (app.toast && t0 > app.toast.until) app.toast = null;
  if (app.message && app.message.until != null && t0 > app.message.until) app.message = null;
  if (app.caption && t0 > app.caption.until) app.caption = null;
});
onRender(() => {
  drawScreens();
  render.frame(frameDt);
});
