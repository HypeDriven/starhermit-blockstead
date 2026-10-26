// The browser build's DOM shell (index.html + js/ui.js + css/style.css) as
// starhermit:ui, built every frame: the round's HUD (the top status bar with
// Pause, the stage name, clock, score and moves; the goals card; the block
// tray with Gather and Remove; the actions tray with Undo, Hint, Skip, Fit
// and Top; the guidance line, the lesson banner, the toast, the caption line
// and the optional text board) and every screen (title over the turning
// showcase valley, modes, setup, Journey, Learn, pause, results, settings,
// help, profile, scores). The browser's media queries are layouts picked by
// the window's logical size: wide (≥ 1024 px: goals rail top-left, actions
// column top-right, tray bottom-centre), compact (640–1023 px: goals
// top-right, actions bottom-right), portrait phone (< 640 px: goals as a
// wrapped chip row under the top bar, the tray over the actions row at the
// bottom) and landscape phone (≤ 540 px tall: goals rail left, actions
// column right); left-handed mirrors the trays. The valley is framed into
// what the HUD leaves (render.setFreeRect). The emoji icons on the tool
// buttons (⛏ 🧨 ↩ 💡 ⏩ 📷 🔳 ⏸) are not in the runtime's fonts: the buttons
// show their text labels, and the block tray a drawn colour swatch per block.
import { clipboard, frame, openMenu } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { requestSignIn } from "starhermit:platform";
import { TextureLoader, type Texture } from "starhermit:scene";
import { Content, I18n, Rules, Session, Store, type Block, type State } from "./classic.ts";
import { t, tx } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  app, back, currentScreen, doHint, doUndo, eraseAll, fmtClock, gather, goalsView, guestLabel, hasSnapshot,
  keyName, leaveRound, legalCells, lessonProgress, movesText, nextStage, onMirrorCell, pauseRound, play, quitLesson,
  restartRound, resumeRound, round, selectBlock, selectMode, selectTheme, settings, setupOption, showScreen, skip,
  startLesson, startRound, startSetupRound, toggleRemove, utcDate, type ScreenName,
} from "./main.ts";

// ------------------------------------------------------------------ layout
type Mode = "wide" | "compact" | "phone" | "land";
interface Layout { lw: number; lh: number; sc: number; mode: Mode; ox: number; oy: number }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const mode: Mode = lw > lh && lh <= 540 && lw <= 959 ? "land" : lw < 640 ? "phone" : lw >= 1024 ? "wide" : "compact";
  return { lw, lh, sc, mode, ox: sa.left, oy: sa.top };
}
const lastHeight = new Map<string, number>();
const lastWidth = new Map<string, number>();

function textWidth(text: string, style: string | readonly string[], kind?: "button"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / ui.preferences().scale;
}
const buttonWidth = (text: string, style: readonly string[]): number => textWidth(text, style, "button") + 2;

interface Btn { id: string; text: string; style?: string[]; disabled?: boolean; selected?: boolean; act: () => void }
const PLAIN = ["btn"];
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected != null) opts.selected = b.selected;
  const s: ui.Style = width != null ? { width } : {};
  if (width != null && buttonWidth(b.text, style) > width) {
    const inner = width - 34;
    const bold = style.includes("btn-primary");
    opts.content = () => { ui.paragraph(b.text, inner, bold ? { weight: "700" } : {}); };
  }
  if (ui.style(...style, s).id(b.id).button(b.text, opts)) b.act();
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, align: "start" | "center" = "start", gap = 10): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, buttonWidth(b.text, b.style ?? PLAIN));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, buttonWidth(b.text, b.style ?? PLAIN) > width ? width : null);
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align: align === "center" ? "center" : "start", width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls?: string, id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = cls ? [cls] : [];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / ui.preferences().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(text: string, cls = "h2", w?: number): void {
  const styles = cls === "h2" && layoutNow().lw < 640 ? [cls, "h2-compact"] : [cls];
  if (w != null && textWidth(text, styles) > w) ui.style(...styles).paragraph(text, w);
  else ui.style(...styles).heading(text);
}

/** A full-window screen: a panel (or the title card) centred, scrolling from
 * the top when taller than the window; overlays dim what is under them. */
function screen(key: string, L: Layout, build: (inner: number) => void, opts: { width?: number; overlay?: boolean; card?: string; spacing?: number; align?: "start" | "center" } = {}): void {
  const pad = L.mode === "phone" || L.lh < 600 ? 14 : 22;
  const width = Math.min(L.lw - 24, opts.width ?? 680);
  const inner = width - 2 * pad - 2;
  const avail = L.lh - 24;
  const h = lastHeight.get(key) ?? 0;
  ui.place(`scr-${key}`, "top-start", () => {
    const body = (): void => {
      const r = ui.column(`${key}-panel`, () => {
        ui.column(`${key}-body`, () => build(inner), { width: inner, spacing: opts.spacing ?? 12, align: opts.align ?? "start" });
      }, { style: opts.card ?? "panel", width, padding: pad, align: "center" });
      lastHeight.set(key, r.height / L.sc);
    };
    if (h > avail) ui.scrollArea(`${key}-scroll`, { width: Math.min(L.lw - 8, width + 16), height: avail }, body);
    else ui.column(`${key}-center`, body, { height: avail, justify: "center", align: "center" });
  }, { style: opts.overlay ? "overlay" : "screen", width: L.lw, height: L.lh, align: "center" });
}
const backBtn = (id: string): Btn => ({ id, text: t("btn.back"), style: ["btn", "btn-ghost"], act: back });

// ------------------------------------------------------------------ art
let keyArt: Texture | null = null, winArt: Texture | null = null, loseArt: Texture | null = null;
export function loadArt(): void {
  const loader = new TextureLoader();
  // Missing art never breaks a screen: it is left out.
  loader.loadAsync("assets/key-art.webp").then((tex) => { keyArt = tex; }, () => undefined);
  loader.loadAsync("assets/results-win.webp").then((tex) => { winArt = tex; }, () => undefined);
  loader.loadAsync("assets/results-lose.webp").then((tex) => { loseArt = tex; }, () => undefined);
}
/** An illustration on a meadow-green backing (the web runtime may not draw
 * package images in ui beside a scene: the backing keeps the space calm). */
function art(tex: Texture | null, key: string, cls: string, width: number, height: number): void {
  if (!tex || tex.width <= 0) return;
  const aspect = tex.width / Math.max(1, tex.height);
  const w = Math.min(width, height * aspect), h = w / aspect;
  ui.stack(`${key}-art`, () => { ui.style(cls).image("", tex, { width: w, height: h }); }, { style: "art-bg", width: w, height: h });
}

// ------------------------------------------------------------------ the frame
function firstLabel(name: ScreenName): string | null {
  switch (name) {
    case "title": return hasSnapshot() ? t("btn.resumeRound") : t("btn.play");
    case "modes": return t("mode.learn");
    case "setup": return t("btn.start");
    case "journey": return t("jcell.aria", { n: 1, name: I18n.cfgName(Content.JOURNEY[0]) }) + t("jcell.stars", { s: platform.progress.journeyStars[Content.JOURNEY[0]!.id] ?? 0 });
    case "learn": return I18n.lessonView(Content.tutorialLessons()[0]!).title;
    case "pause": return t("btn.resume");
    case "results": return null;
    case "settings": case "help": return t("btn.done");
    case "profile": case "leaderboard": return t("btn.back");
  }
}

export function drawScreens(): void {
  const L = layoutNow();
  const top = currentScreen();
  if (app.focusNext && top && frame().frame - app.openedFrame >= 2) {
    const first = firstLabel(top);
    if (first) ui.setFocus(first);
    app.focusNext = false;
  }
  const s = round.state;
  if (s && (round.phase === "active" || round.phase === "paused") && !top) hud(L, s);
  else render.setFreeRect({ l: 0, t: 0, r: 1, b: 1 }, frame().width, frame().height);
  if (top) {
    switch (top) {
      case "title": titleScreen(L); break;
      case "modes": modesScreen(L); break;
      case "setup": setupScreen(L); break;
      case "journey": journeyScreen(L); break;
      case "learn": learnScreen(L); break;
      case "pause": pauseScreen(L); break;
      case "results": resultsScreen(L); break;
      case "settings": settingsScreen(L); break;
      case "help": helpScreen(L); break;
      case "profile": profileScreen(L); break;
      case "leaderboard": leaderboardScreen(L); break;
    }
  }
  if (app.toast) {
    // Over a screen the toast docks at the top; in play it floats above the trays.
    const over = !!top || !s;
    const w = Math.min(L.lw * 0.92, 560);
    const y = over ? 8 : Math.max(0, bottomH - toastH - 12);
    ui.place("toast", { anchor: "top-start", x: (L.lw - w) / 2, y }, () => {
      const r = ui.column("toast-box", () => {
        if (textWidth(app.toast!.text, "toast") <= w) ui.style("toast").label(app.toast!.text);
        else ui.style("toast").paragraph(app.toast!.text, w - 32);
      }, { align: "center" });
      toastH = r.height / L.sc;
    }, { width: w, align: "center" });
  }
}
let toastH = 40;
/** The top of the bottom trays (logical, safe-area relative), last frame. */
let bottomH = 600;

// ------------------------------------------------------------------ HUD
function swatchClass(b: Block, hv: boolean): string { return (hv ? "sw-hv-" : "sw-") + b; }
const hvNow = (): boolean => ui.preferences().highContrast || settings.colorPalette === "high-visibility";

function hud(L: Layout, st: State): void {
  const cfg = st.cfg;
  const phone = L.mode === "phone", land = L.mode === "land";
  const lefty = !!settings.leftHanded;
  // --- top status bar
  const barW = phone ? L.lw - 8 : land ? L.lw - 16 : Math.min(L.lw * 0.96, 1000);
  const pauseW = buttonWidth(t("h.pause"), ["btn", "btn-small"]);
  const name = I18n.cfgName(cfg), timer = fmtClock(round.elapsedMs), score = "★ " + Rules.currentScore(st), moves = movesText(st);
  const leftW = pauseW + 10 + textWidth(name, "hud-mode") + 10 + textWidth(timer, "hud-timer");
  const rightW = textWidth(score, "hud-stat") + 12 + textWidth(moves, "hud-stat");
  const innerW = barW - 24;
  const oneRow = leftW + rightW + 14 <= innerW;
  const statsRow = (): void => {
    ui.row("hud-stats", () => {
      ui.style("hud-stat").id("hud-score").label(score);
      ui.style("hud-stat").id("hud-moves").label(moves);
    }, { spacing: 12, align: "center" });
  };
  const nameRow = (): void => {
    ui.row("hud-left", () => {
      if (ui.style("btn", "btn-small").id("btn-pause").button(t("h.pause"), { tooltip: t("aria.pause") })) { pauseRound(); ui.setFocus(null); }
      para(name, Math.max(60, innerW - pauseW - textWidth(timer, "hud-timer") - 30 - (oneRow ? rightW + 14 : 0)), "hud-mode", "hud-mode-name");
      ui.style("hud-timer").id("hud-timer").label(timer);
    }, { spacing: 10, align: "center" });
  };
  const topR = ui.place("hud-top", { anchor: "top-start", x: (L.lw - barW) / 2, y: phone || land ? 4 : 8 }, () => {
    if (oneRow) ui.row("hud-top-row", () => { nameRow(); ui.spacer(); statsRow(); }, { width: innerW, spacing: 14, align: "center" });
    else ui.column("hud-top-col", () => { nameRow(); statsRow(); }, { width: innerW, spacing: 6 });
  }, { style: "hud", width: barW });
  const topH = (phone || land ? 4 : 8) + topR.height / L.sc;

  // --- goals
  const goals = goalsView(st);
  const goalText = (g: (typeof goals)[number]): string => (g.done ? "✓ " : "○ ") + g.label + " — " + g.have + "/" + g.need;
  let goalsRect = { x: 0, y: topH, w: 0, h: 0 };
  if (phone) {
    const w = L.lw - 16;
    const y = topH + 6;
    const r = ui.place("hud-goals", { anchor: "top-start", x: 8, y }, () => {
      const rows: string[][] = [[]];
      let used = 0;
      for (const g of goals) {
        const tw = Math.min(w - 20, textWidth(goalText(g), "goal-item") + 2);
        if (rows[rows.length - 1]!.length && used + 4 + tw > w - 20) { rows.push([]); used = 0; }
        used += (rows[rows.length - 1]!.length ? 4 : 0) + tw;
        rows[rows.length - 1]!.push(goalText(g));
      }
      let k = 0;
      ui.column("goals-rows", () => rows.forEach((row, ri) => ui.row(`goals-r${ri}`, () => {
        for (const text of row) { const g = goals[k]!; para(text, w - 20, g.done ? "goal-done" : "goal-item", `goal-${k++}`); }
      }, { spacing: 4 })), { spacing: 4, width: w - 20 });
    }, { style: "hud", width: w });
    goalsRect = { x: 8, y, w, h: r.height / L.sc };
  } else {
    const w = L.mode === "wide" ? Math.min(L.lw * 0.24, 300) : L.mode === "compact" ? Math.min(L.lw * 0.34, 260) : Math.min(L.lw * 0.26, 200);
    const onRight = L.mode === "compact";
    const x = onRight ? L.lw - 10 - w : land ? 8 : 14;
    const y = topH + (land ? 6 : 12);
    const maxH = L.mode === "compact" ? L.lh * 0.4 : L.lh - y - 90;
    const inner = lastHeight.get("goals") ?? 0;
    const r = ui.place("hud-goals", { anchor: "top-start", x, y }, () => {
      const body = (): void => {
        const rr = ui.column("goals-body", () => {
          ui.style("hud-h").label(t("goals.title"));
          goals.forEach((g, i) => para(goalText(g), w - 24 - 18, g.done ? "goal-done" : "goal-item", `goal-${i}`));
        }, { spacing: 6, width: w - 24 });
        lastHeight.set("goals", rr.height / L.sc);
      };
      if (inner > maxH - 16) ui.scrollArea("goals-scroll", { width: w - 12, height: maxH - 16 }, body);
      else body();
    }, { style: "hud", width: w });
    goalsRect = { x, y, w, h: r.height / L.sc };
  }

  // --- trays
  const removeAllowed = cfg.mechanics.remove !== false;
  const canUndo = !!round.session && Session.canUndo(round.session);
  const canHint = cfg.mechanics.hint !== false && !st.terminal;
  const hv = hvNow();
  const tool = (id: string, text: string, act: () => void, opts: { disabled?: boolean; selected?: boolean; width?: number } = {}): void => {
    const o: ui.ButtonOptions = { disabled: !!opts.disabled };
    if (opts.selected != null) o.selected = opts.selected;
    const s: ui.Style = opts.width != null ? { width: opts.width } : {};
    if (ui.style("btn", "btn-tool", s).id(id).button(text, o)) { act(); ui.setFocus(null); }
  };
  const blockBtn = (b: Block, width?: number): void => {
    const label = I18n.blockLabel(b) + " ×" + (st.inv[b] ?? 0);
    const s: ui.Style = width != null ? { width } : {};
    const clicked = ui.style("btn", "btn-tool", s).id(`palette-${b}`).button(t("palette.aria", { label: I18n.blockLabel(b), n: st.inv[b] ?? 0 }), {
      selected: round.selectedBlock === b && !round.removeMode,
      content: () => {
        ui.column(`palette-${b}-face`, () => {
          ui.column(`palette-${b}-sw`, () => undefined, { style: swatchClass(b, hv), width: 18, height: 18 });
          ui.style("stock").label(label);
        }, { align: "center", spacing: 3 });
      },
    });
    if (clicked) { selectBlock(b); ui.setFocus(null); }
  };
  const blockW = (b: Block): number => Math.max(52, textWidth(I18n.blockLabel(b) + " ×" + (st.inv[b] ?? 0), "stock") + 22);
  const toolW = (text: string): number => buttonWidth(text, ["btn", "btn-tool"]);
  const paletteItems: { w: number; draw: (w?: number) => void }[] = [
    ...cfg.blocks.map((b) => ({ w: blockW(b), draw: (w?: number) => blockBtn(b, w) })),
    { w: toolW(t("btn.gather")), draw: (w?: number) => tool("btn-gather", t("btn.gather"), gather, w != null ? { width: w } : {}) },
    { w: toolW(t("btn.remove")), draw: (w?: number) => tool("btn-remove", t("btn.remove"), toggleRemove, { disabled: !removeAllowed, selected: round.removeMode, ...(w != null ? { width: w } : {}) }) },
  ];
  const actionItems: { w: number; draw: (w?: number) => void }[] = [
    { w: toolW(t("btn.undo")), draw: (w) => tool("btn-undo", t("btn.undo"), doUndo, { disabled: !canUndo, ...(w != null ? { width: w } : {}) }) },
    { w: toolW(t("btn.hint")), draw: (w) => tool("btn-hint", t("btn.hint"), doHint, { disabled: !canHint, ...(w != null ? { width: w } : {}) }) },
    { w: toolW(t("btn.skip")), draw: (w) => tool("btn-skip", t("btn.skip"), skip, w != null ? { width: w } : {}) },
    { w: toolW(t("btn.fit")), draw: (w) => tool("btn-camera", t("btn.fit"), () => render.resetCamera(), w != null ? { width: w } : {}) },
    { w: toolW(t("btn.top")), draw: (w) => tool("btn-topdown", t("btn.top"), () => render.topDownCamera(), w != null ? { width: w } : {}) },
  ];
  /** A tray of items in rows wrapping at `max` (all one width on phones). */
  const trayRows = (items: typeof paletteItems, max: number, even: boolean): { rows: (typeof paletteItems)[]; w: number | undefined } => {
    if (even) {
      const per = Math.max(1, Math.min(items.length, Math.floor((max + 6) / (Math.max(...items.map((i) => i.w)) + 6)) || 1));
      const cols = Math.min(items.length, Math.max(per, Math.ceil(items.length / 2)));
      const w = Math.floor((max - 6 * (cols - 1)) / cols);
      const rows: (typeof paletteItems)[] = [];
      for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
      return { rows, w };
    }
    const rows: (typeof paletteItems)[] = [[]];
    let used = 0;
    for (const it of items) {
      if (rows[rows.length - 1]!.length && used + 8 + it.w > max) { rows.push([]); used = 0; }
      used += (rows[rows.length - 1]!.length ? 8 : 0) + it.w;
      rows[rows.length - 1]!.push(it);
    }
    return { rows, w: undefined };
  };
  const placeTray = (key: string, items: typeof paletteItems, x: number, y: number, max: number, even: boolean, column = false): { x: number; y: number; w: number; h: number } => {
    const { rows, w } = column ? { rows: items.map((i) => [i]), w: Math.max(...items.map((i) => i.w)) } : trayRows(items, max, even);
    const r = ui.place(key, { anchor: "top-start", x, y }, () => {
      ui.column(`${key}-col`, () => rows.forEach((row, ri) => ui.row(`${key}-r${ri}`, () => { for (const it of row) it.draw(w); }, { spacing: even ? 6 : 8 })), { spacing: even ? 6 : 8, align: "center" });
    }, { style: "tray" });
    const rw = r.width / L.sc, rh = r.height / L.sc;
    lastWidth.set(key, rw); lastHeight.set(key, rh);
    return { x, y, w: rw, h: rh };
  };
  let palR: { x: number; y: number; w: number; h: number }, actR: { x: number; y: number; w: number; h: number };
  const gap = phone || land ? 6 : 10;
  if (phone) {
    const max = L.lw - 16 - 16;
    const ah = lastHeight.get("hud-actions") ?? 70, ph = lastHeight.get("hud-palette") ?? 140;
    actR = placeTray("hud-actions", actionItems, 8, L.lh - ah - 6, max, true);
    palR = placeTray("hud-palette", paletteItems, 8, L.lh - ah - 6 - gap - ph, max, true);
  } else {
    const pw = lastWidth.get("hud-palette") ?? 400, ph = lastHeight.get("hud-palette") ?? 80;
    const aw = lastWidth.get("hud-actions") ?? 90, ah = lastHeight.get("hud-actions") ?? 300;
    const actX = lefty ? (land ? 8 : 14) : L.lw - (land ? 8 : 14) - aw;
    let actY: number;
    // compact: the bottom-right column, never over the goals card above it
    if (L.mode === "compact") actY = Math.max(goalsRect.y + goalsRect.h + 8, L.lh - 96 - ah);
    else actY = land ? topH + 6 : topH + 12;
    actR = placeTray("hud-actions", actionItems, actX, Math.max(topH + 6, actY), 0, false, true);
    const maxPal = land ? L.lw - 200 : Math.min(L.lw - 2 * (aw + 24), 900);
    const palX = lefty && !land ? L.lw - 10 - pw : (L.lw - pw) / 2;
    palR = placeTray("hud-palette", paletteItems, Math.max(4, palX), L.lh - ph - (land ? 6 : 14), Math.max(200, maxPal), false);
  }
  bottomH = Math.min(palR.y, phone ? actR.y : palR.y);

  // --- lesson banner and the guidance line
  let below = phone ? goalsRect.y + goalsRect.h : topH;
  if (round.lesson) {
    const lv = I18n.lessonView(round.lesson);
    let w = Math.min(L.lw * 0.94, 700), x = (L.lw - w) / 2;
    let y = below + 8;
    if (land) { x = goalsRect.x + goalsRect.w + 8; w = Math.max(160, actR.x - 8 - x); y = topH + 6; }
    else if (L.mode === "wide" || L.mode === "compact") {
      // below the goals card when it shares the banner's column
      const overlaps = goalsRect.x < x + w && goalsRect.x + goalsRect.w > x;
      if (overlaps) { x = L.mode === "wide" ? goalsRect.x + goalsRect.w + 12 : 10; w = Math.min(700, (L.mode === "wide" ? actR.x - 12 : goalsRect.x - 10) - x); }
    }
    const r = ui.place("lesson-banner", { anchor: "top-start", x, y }, () => {
      ui.column("lesson-body", () => {
        para(lv.title + " — " + lessonProgress(), w - 34, "lesson-title", "lesson-title");
        para(lv.text, w - 34, "lesson-text", "lesson-text");
        button({ id: "lesson-quit", text: t("btn.exitLesson"), style: ["btn", "btn-ghost", "btn-small"], act: quitLesson });
      }, { spacing: 6, width: w - 34 });
    }, { style: "lesson-banner", width: w });
    below = y + r.height / L.sc;
  }
  if (app.message) {
    let w = phone || land ? Math.min(L.lw - 16, land ? 360 : 720) : Math.min(L.lw * 0.94, 720);
    const mh = lastHeight.get("hud-message") ?? 40;
    let x = (L.lw - w) / 2, y = below + 8;
    if (phone) y = palR.y - mh - 8;
    else if (land) { x = goalsRect.x + goalsRect.w + 8; y = palR.y - mh - 8; }
    else if (L.mode === "wide" && goalsRect.x < x + w && goalsRect.x + goalsRect.w > x) x = Math.max(x, goalsRect.x + goalsRect.w + 12);
    else if (L.mode === "compact" && x + w > goalsRect.x - 8) { w = Math.min(w, goalsRect.x - 16); x = Math.max(8, (goalsRect.x - w) / 2); }
    const r = ui.place("hud-message", { anchor: "top-start", x, y }, () => {
      para(app.message!.text, w - 24, "message", "hud-message-text", true);
    }, { width: w, align: "center" });
    lastHeight.set("hud-message", r.height / L.sc);
  }
  if (app.caption) {
    const w = Math.min(L.lw * 0.9, 420);
    ui.place("caption", { anchor: "top-start", x: (L.lw - w) / 2, y: Math.max(topH, bottomH - 40 - (app.toast ? toastH + 8 : 0) - (app.message && (phone || land) ? (lastHeight.get("hud-message") ?? 40) + 8 : 0)) }, () => {
      para(app.caption!.text, w - 24, "caption-line", "caption-text", true);
    }, { width: w, align: "center" });
  }
  if (settings.boardMirror) boardMirror(L, st);

  // --- the valley in what is left
  let l = 0, r = L.lw, tY = phone ? goalsRect.y + goalsRect.h : topH, b = bottomH;
  if (!phone) {
    if (L.mode !== "compact") { if (lefty) r = Math.min(r, L.lw - goalsRect.w - 20); else l = Math.max(l, goalsRect.x + goalsRect.w); }
    else r = Math.min(r, goalsRect.x);
    if (L.mode !== "compact") { if (actR.x > L.lw / 2) r = Math.min(r, actR.x); else l = Math.max(l, actR.x + actR.w); }
    else if (actR.x > L.lw / 2) r = Math.min(r, actR.x);
  }
  if (r - l < L.lw * 0.45) { l = 0; r = L.lw; }
  if (b - tY < L.lh * 0.35) { tY = Math.min(tY, L.lh * 0.3); b = Math.max(b, L.lh * 0.7); }
  const f = frame();
  const fx = (lx: number): number => (L.ox + lx * L.sc) / f.width;
  const fy = (ly: number): number => (L.oy + ly * L.sc) / f.height;
  render.setFreeRect({ l: fx(l), r: fx(r), t: fy(tY), b: fy(b) }, f.width, f.height);
}

/** The text board: a button per column (its top block and height), legal targets ringed. */
function boardMirror(L: Layout, st: State): void {
  const legal = legalCells();
  const cols = st.cfg.plot.cols;
  const cell = Math.max(44, Math.min(56, (L.lw - 40) / cols - 4));
  const w = cols * (cell + 4) + 12;
  const h = lastHeight.get("mirror") ?? 300;
  const r = ui.place("mirror", { anchor: "top-start", x: (L.lw - w) / 2, y: Math.max(4, bottomH - h - 8) }, () => {
    ui.grid("mirror-plot", () => {
      for (let y = 0; y < st.cfg.plot.rows; y++) for (let x = 0; x < cols; x++) {
        const stack = st.grid[y]![x]!;
        const top = stack.length ? stack[stack.length - 1]! : null;
        const key = x + "," + y;
        const name = t("mirror.cell", { x: x + 1, y: y + 1, contents: stack.length ? stack.map((b) => I18n.blockLabel(b)).join(", ") : t("mirror.empty") }) + (legal.has(key) ? t("mirror.legal") : "");
        const face = top ? I18n.blockLabel(top).slice(0, 3) + (stack.length > 1 ? " " + stack.length : "") : "·";
        if (ui.style(legal.has(key) ? "mirror-legal" : "mirror-cell", { width: cell }).id(`mirror-${x}-${y}`).button(name, {
          content: () => { ui.label(face); },
        })) onMirrorCell(x, y);
      }
    }, { columns: cols, gap: 4 });
  }, { style: "mirror" });
  lastHeight.set("mirror", r.height / L.sc);
}

// ------------------------------------------------------------------ screens
function accountLine(): string {
  if (app.signedOut) return t("acct.signedOut");
  const name = platform.displayName();
  if (!name) return t("acct.offline");
  const s = platform.syncState();
  return t("acct.playingAs", { name }) + " · " + (s === "error" ? t("acct.syncOff") : s === "saving" ? t("acct.saving") : t("acct.synced"));
}
function dailyLine(): string {
  const nowMs = Date.now();
  const next = Math.ceil(nowMs / 86400000) * 86400000;
  const left = Math.max(0, next - nowMs);
  const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
  const done = platform.progress.dailiesDone[utcDate()];
  return (done ? t("daily.done", { n: done }) : "") + t("daily.newIn", { h, m });
}

function titleScreen(L: Layout): void {
  const short = L.lh < 600;
  screen("title", L, (w) => {
    if (L.mode !== "land") art(keyArt, "key", "key-art", Math.min(w, 560), L.lh * (short ? 0.18 : 0.3));
    ui.style("logo", L.mode === "phone" || L.mode === "land" ? "logo-compact" : null).heading("Blockstead");
    para(t("tagline"), w, "tagline", "tagline", true);
    button({ id: "btn-play", text: hasSnapshot() ? t("btn.resumeRound") : t("btn.play"), style: ["btn", "btn-primary", "btn-big"], act: play }, Math.min(w, 420));
    const mini = (id: string, label: string, sub: string, act: () => void): Btn & { sub: string } => ({ id, text: label, sub, act });
    const second = [
      mini("btn-daily", t("btn.daily"), dailyLine(), () => selectMode("daily")),
      mini("btn-journey", t("btn.journey"), Object.keys(platform.progress.journeyStars).length + "/" + Content.JOURNEY.length, () => showScreen("journey")),
      mini("btn-profile", t("btn.profile"), "", () => showScreen("profile")),
    ];
    // The daily and Journey buttons carry a small second line (countdown, stages done).
    const rows: (typeof second)[] = [[]];
    let used = 0;
    const bw = (b: (typeof second)[number]): number => Math.max(buttonWidth(b.text, PLAIN), b.sub ? textWidth(b.sub, "mini") + 34 : 0);
    for (const b of second) {
      if (rows[rows.length - 1]!.length && used + 10 + bw(b) > w) { rows.push([]); used = 0; }
      used += (rows[rows.length - 1]!.length ? 10 : 0) + bw(b);
      rows[rows.length - 1]!.push(b);
    }
    ui.column("title-secondary", () => rows.forEach((row, ri) => ui.row(`title-secondary-${ri}`, () => {
      for (const b of row) {
        const opts: ui.ButtonOptions = b.sub ? { content: () => { ui.label(b.text); ui.style("mini").label(b.sub); } } : {};
        if (ui.style("btn").id(b.id).button(b.text, opts)) b.act();
      }
    }, { spacing: 10, align: "center" })), { spacing: 10, align: "center", width: w });
    flow("title-tertiary", [
      { id: "btn-help", text: t("btn.howto"), style: ["btn", "btn-ghost"], act: () => showScreen("help") },
      { id: "btn-settings", text: t("btn.settings"), style: ["btn", "btn-ghost"], act: () => showScreen("settings") },
      { id: "btn-leaderboard", text: t("btn.scores"), style: ["btn", "btn-ghost"], act: () => showScreen("leaderboard") },
    ], w, "center");
    const account: Btn[] = [];
    const link = platform.inviteLink();
    if (link) {
      account.push({
        id: "btn-invite", text: t("acct.invite"), style: ["btn", "btn-ghost"],
        act: () => { try { clipboard.writeText(link); toast2(t("acct.inviteCopied")); } catch { toast2(`${t("acct.inviteFailed")} ${link}`); } },
      });
    }
    if (!platform.signedIn()) account.push({ id: "btn-sign-in", text: t("acct.signIn"), style: ["btn", "btn-ghost"], act: () => { void requestSignIn().catch(() => undefined); } });
    if (account.length) flow("title-account", account, w, "center");
    para(accountLine(), w, "mini", "account-line", true);
  }, { width: 640, card: "title-card", spacing: short ? 8 : 12, align: "center" });
}
function toast2(text: string): void { app.toast = { text, until: frame().time + 2.4 }; ui.announce(text); }

/** A card button: a title, a description and an optional meta line. */
function card(id: string, title: string, desc: string, meta: string, w: number, act: () => void): void {
  const inner = w - 34;
  const clicked = ui.style("card", { width: w }).id(id).button(title, {
    content: () => {
      ui.column(`${id}-face`, () => {
        para(title, inner, "card-title");
        if (desc) ui.style("card-desc").paragraph(desc, inner);
        if (meta) para(meta, inner, "card-desc");
      }, { spacing: 4, width: inner });
    },
  });
  if (clicked) act();
}

function modesScreen(L: Layout): void {
  const stages = Object.keys(platform.progress.journeyStars).length;
  screen("modes", L, (w) => {
    heading(t("modes.title"), "h2", w);
    for (const id of ["learn", "journey", "daily", "practice", "challenge", "score"]) {
      card(`mode-${id}`, t("mode." + id), t("mode." + id + ".d"), t("mode." + id + ".m", { n: stages }), w, () => selectMode(id));
    }
    button(backBtn("btn-modes-back"));
  });
}

function setupScreen(L: Layout): void {
  const s = app.setup;
  if (!s) { back(); return; }
  screen("setup", L, (w) => {
    heading(t("setup.title"), "h2", w);
    heading(I18n.cfgName(s.cfg), "h3", w);
    para(I18n.cfgIntro(s.cfg), w, "text", "setup-intro");
    ui.column("setup-facts", () => { s.facts.forEach((f, i) => para("• " + f, w - 8, "fact", `fact-${i}`)); }, { spacing: 4, width: w });
    para(s.ranked ? t("setup.ranked") : t("setup.unranked"), w, "mini", "setup-ranked");
    if (s.options) {
      flow("setup-options", s.options.map((o) => ({
        id: `opt-${o.value}`, text: o.label, selected: o.active, act: () => setupOption(o.value),
      })), w);
    }
    flow("setup-row", [
      { id: "btn-start-round", text: t("btn.start"), style: ["btn", "btn-primary"], act: startSetupRound },
      backBtn("btn-setup-back"),
    ], w);
  });
}

function journeyScreen(L: Layout): void {
  const p = platform.progress;
  const levels = Content.JOURNEY;
  screen("journey", L, (w) => {
    heading(t("journey.title"), "h2", w);
    para(t("journey.stars", { n: levels.reduce((n, l) => n + (p.journeyStars[l.id] ?? 0), 0), max: levels.length * 3 }), w, "mini", "journey-stars");
    const cols = Math.max(2, Math.floor((w + 10) / (150 + 10)));
    const cell = (w - 10 * (cols - 1)) / cols;
    ui.grid("journey-grid", () => {
      levels.forEach((l, i) => {
        const stars = p.journeyStars[l.id] ?? 0;
        const unlocked = i === 0 || (p.journeyStars[levels[i - 1]!.id] ?? 0) > 0;
        const name = I18n.cfgName(l);
        const label = t("jcell.aria", { n: i + 1, name }) + (unlocked ? t("jcell.stars", { s: stars }) : t("jcell.locked"));
        const clicked = ui.style("level-cell", l.mastery ? "level-mastery" : null, { width: cell }).id(`stage-${i + 1}`).button(label, {
          disabled: !unlocked,
          content: () => {
            ui.column(`stage-${i + 1}-face`, () => {
              ui.style("level-num").label(String(i + 1));
              para(name, cell - 26, "level-name");
              ui.style("level-stars").label(unlocked ? "★".repeat(stars) + "☆".repeat(3 - stars) : "—");
            }, { spacing: 3, width: cell - 26 });
          },
        });
        if (clicked) startRound(l, "journey", i);
      });
    }, { columns: cols, gap: 10, width: w });
    button(backBtn("btn-journey-back"));
  }, { width: 900 });
}

function learnScreen(L: Layout): void {
  screen("learn", L, (w) => {
    heading(t("learn.title"), "h2", w);
    for (const l of Content.tutorialLessons()) {
      const v = I18n.lessonView(l);
      const done = !!platform.progress.tutorialDone[l.id];
      card(`lesson-${l.id}`, (done ? "✓ " : "") + v.title, v.text, done ? t("les.replay") : t("les.start"), w, () => startLesson(l.id));
    }
    button(backBtn("btn-learn-back"));
  });
}

function pauseScreen(L: Layout): void {
  if (!round.state) { showScreen("title"); return; }
  screen("pause", L, (w) => {
    heading(t("pause.title"), "h2", w);
    button({ id: "btn-resume", text: t("btn.resume"), style: ["btn", "btn-primary", "btn-big"], act: resumeRound }, Math.min(w, 420));
    ui.column("pause-stack", () => {
      button({ id: "btn-pause-settings", text: t("btn.settings"), act: () => showScreen("settings") }, w);
      button({ id: "btn-pause-help", text: t("btn.help"), act: () => showScreen("help") }, w);
      button({ id: "btn-restart", text: t("btn.restart"), act: restartRound }, w);
      button({ id: "btn-leave", text: t("btn.leave"), style: ["btn", "btn-danger"], act: () => { leaveRound(false); showScreen("title"); } }, w);
    }, { spacing: 10, width: w });
  }, { overlay: true, align: "center" });
}

function resultsScreen(L: Layout): void {
  const r = app.results;
  if (!r) { showScreen("title"); return; }
  screen("results", L, (w) => {
    heading(r.title, "h2", w);
    if (L.lh >= 640) art(r.won ? winArt : loseArt, "results", "result-art", Math.min(w, 420), Math.min(L.lh * 0.18, 260));
    para(r.headline, w, "headline", "results-headline");
    ui.grid("results-table", () => {
      for (const [k, v] of r.rows) {
        const total = k === t("r.total");
        ui.style(total ? "res-total" : "res-td").label(k);
        ui.style(total ? "res-total" : "res-pts").label(v);
      }
    }, { columns: [{ fr: 1 }, { width: "auto", align: "end" }], gap: 0, width: w, rowStyle: "res-row" });
    if (r.stars) ui.style("stars").id("results-stars").label("★".repeat(r.stars) + "☆".repeat(3 - r.stars));
    r.achievements.forEach((a, i) => para("★ " + a.name + " — " + a.desc, w, "text", `results-ach-${i}`));
    para(r.compare, w, "mini", "results-compare");
    const lb = app.lb;
    if (lb) para(lb.pending ? t("lb.posting") : !lb.posted ? t("lb.notPosted") : lb.rank ? t("lb.rank", { rank: lb.rank }) : t("lb.posted"), w, "mini", "results-lb");
    const row: Btn[] = [];
    if (r.hasNext) row.push({ id: "btn-results-next", text: r.nextLabel, style: ["btn", "btn-primary"], act: nextStage });
    row.push({ id: "btn-results-retry", text: t("btn.retry"), style: r.hasNext ? ["btn"] : ["btn", "btn-primary"], act: restartRound });
    row.push({ id: "btn-results-menu", text: t("btn.menu"), style: ["btn", "btn-ghost"], act: () => { leaveRound(true); showScreen("title"); } });
    flow("results-row", row, w);
  }, { overlay: true });
}

function settingsScreen(L: Layout): void {
  screen("settings", L, (w) => {
    heading(t("settings.title"), "h2", w);
    const inner = w - 30;
    const check = (key: string, label: string): void => {
      ui.row(`row-${key}`, () => {
        const cur = !!settings[key];
        const next = ui.id(`set-${key}`).checkbox(label, cur);
        if (next !== cur) platform.setSetting(key, next);
      }, { style: "setting-row", width: inner, align: "center" });
    };
    const select = (key: string, label: string, options: [string, string][]): void => {
      ui.row(`row-${key}`, () => {
        para(label, inner * 0.5, "setting-label");
        ui.spacer();
        const idx = Math.max(0, options.findIndex(([v]) => v === settings[key]));
        const next = ui.id(`set-${key}`).select(label, idx, options.map(([, l]) => l));
        if (next !== idx) platform.setSetting(key, options[next]![0]);
      }, { style: "setting-row", width: inner, align: "center", spacing: 8 });
    };
    const fieldset = (key: string, legend: string, build: () => void): void => {
      ui.column(`fs-${key}`, () => { ui.style("legend").label(legend); build(); }, { style: "fieldset", width: w, spacing: 4 });
    };
    fieldset("audio", t("set.audio"), () => check("captions", t("set.captions")));
    fieldset("graphics", t("set.graphics"), () => select("colorPalette", t("set.colorPalette"), [["standard", t("pal.standard")], ["high-visibility", t("pal.high-visibility")]]));
    fieldset("controls", t("set.controls"), () => {
      check("leftHanded", t("set.leftHanded"));
      check("haptics", t("set.haptics"));
      check("boardMirror", t("set.boardMirror"));
      check("confirmMoves", t("set.confirmMoves"));
    });
    // Sound, graphics, language, controls and accessibility are the runtime's Options.
    button({ id: "btn-options", text: t("set.options"), act: () => openMenu() }, Math.min(w, buttonWidth(t("set.options"), PLAIN)));
    button({ id: "btn-settings-done", text: t("btn.done"), style: ["btn", "btn-primary"], act: back });
  }, { width: 900, overlay: true });
}

function helpScreen(L: Layout): void {
  const cards: [string, string, string][] = [
    ["goal", "", ""],
    ["gather", t("h.gather.k", { k: keyName("gather") }).replace("⛏", t("btn.gather")), ""],
    ["place", t("h.place.k", { a: keyName("block1"), b: keyName("block5"), p: keyName("place") }), ""],
    ["support", "", ""],
    ["toppers", "", ""],
    ["remove", t("h.remove.k", { r: keyName("remove"), u: keyName("undo") }), ""],
    ["hints", keyName("hint"), ""],
    ["camera", t("h.camera.k", { c: keyName("camera"), t: keyName("topdown") }), ""],
    ["pause", t("h.pause.k", { p: keyName("pause"), b: keyName("back") }), t("help.pad")],
  ];
  screen("help", L, (w) => {
    heading(t("help.title"), "h2", w);
    for (const [id, keys, extra] of cards) {
      ui.column(`help-${id}`, () => {
        para(t("h." + id), w - 30, "help-h");
        ui.style("help-p").paragraph(tx("h." + id + ".b"), w - 30);
        if (keys) para(keys, w - 30, "mini");
        if (extra) para(extra, w - 30, "mini");
      }, { style: "help-card", width: w, spacing: 4 });
    }
    button({ id: "btn-help-done", text: t("btn.done"), style: ["btn", "btn-primary"], act: back });
  }, { width: 900, overlay: true });
}

function profileScreen(L: Layout): void {
  const p = platform.progress;
  const stars = Object.values(p.journeyStars).reduce((a, b) => a + b, 0);
  const name = platform.displayName() ?? guestLabel();
  screen("profile", L, (w) => {
    heading(t("profile.title"), "h2", w);
    heading(name, "h3", w);
    para(platform.signedIn() ? t("prof.signedIn", { name }) : t("prof.guest"), w, "mini", "profile-sub");
    const stats = [
      t("st.rounds", { n: p.stats.rounds }), t("st.wins", { n: p.stats.wins }), t("st.placed", { n: p.stats.placed }),
      t("st.height", { n: p.stats.bestHeight }), t("st.stars", { n: stars }), t("st.endless", { n: p.endlessBest }),
      t("st.dailies", { n: Object.keys(p.dailiesDone).length }), t("st.time", { t: fmtClock(p.stats.playMs) }),
    ];
    ui.column("profile-stats", () => stats.forEach((s, i) => para("• " + s, w, "text", `stat-${i}`)), { spacing: 3, width: w });
    heading(t("prof.ach"), "h3", w);
    ui.column("profile-ach", () => {
      for (const a of Content.ACHIEVEMENTS) {
        const v = I18n.achievementView(a), got = !!p.achievements[a.key];
        para((got ? "★ " : "☆ ") + v.name + " — " + v.desc, w, got ? "ach" : "ach-locked", `ach-${a.key}`);
      }
    }, { spacing: 5, width: w });
    heading(t("prof.themes"), "h3", w);
    flow("profile-themes", Content.THEMES.map((th) => {
      const unlocked = stars >= th.unlockStars;
      return {
        id: `theme-${th.id}`, text: I18n.themeName(th) + (unlocked ? "" : ` (${th.unlockStars}★)`), disabled: !unlocked,
        selected: settings.theme === th.id, act: () => selectTheme(th.id),
      };
    }), w);
    if (app.confirmErase) {
      para(t("prof.confirm"), w, "text", "profile-confirm");
      flow("profile-confirm-row", [
        { id: "btn-erase-yes", text: t("prof.yes"), style: ["btn", "btn-danger"], act: eraseAll },
        { id: "btn-erase-no", text: t("prof.no"), act: () => { app.confirmErase = false; } },
      ], w);
    } else {
      button({ id: "btn-erase", text: t("prof.erase"), style: ["btn", "btn-danger"], act: () => { app.confirmErase = true; ui.setFocus(t("prof.no")); } });
    }
    button(backBtn("btn-profile-back"));
  }, { width: 900 });
}

function leaderboardScreen(L: Layout): void {
  const date = utcDate();
  const boards = [{ id: "global", label: t("lb.global") }, { id: "daily:" + date, label: t("lb.today") }];
  if (!boards.some((b) => b.id === app.lbActive)) app.lbActive = "global";
  const entries = Store.sortEntries(Store.loadBoards().entries.filter((e) => e.board === app.lbActive));
  screen("leaderboard", L, (w) => {
    heading(t("lb.title"), "h2", w);
    flow("lb-tabs", boards.map((b) => ({ id: `lb-${b.id}`, text: b.label, selected: b.id === app.lbActive, act: () => { app.lbActive = b.id; } })), w);
    para(t("lb.note"), w, "mini", "lb-note");
    if (!entries.length) { para(t("lb.empty"), w, "text", "lb-empty"); }
    else {
      const me = platform.userId();
      ui.grid("lb-table", () => {
        for (const h of ["#", t("lb.player"), t("lb.score"), t("lb.time"), t("lb.when")]) ui.style("lb-th").label(h);
        entries.slice(0, 50).forEach((e, i) => {
          const nm = e.player ? (e.player === me ? t("lb.you", { name: platform.nameFor(e.player) }) : platform.nameFor(e.player)) : (e.name ?? "—");
          ui.style("lb-td").label(String(i + 1));
          ui.style("lb-td").label(nm);
          ui.style("lb-td").label(String(e.score));
          ui.style("lb-td").label(e.durationMs ? fmtClock(e.durationMs) : "—");
          ui.style("lb-td").label(e.at ? new Date(e.at).toISOString().slice(0, 10) : "—");
        });
      }, { columns: ["auto", { fr: 1 }, "auto", "auto", "auto"], gap: 0, width: w, rowStyle: "lb-row" });
    }
    button(backBtn("btn-lb-back"));
  }, { width: 900 });
}
