// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (lessons, Journey stars and bests, challenge / daily bests, the
//   endless best, lifetime stats, achievements, theme) is the game's save
//   (starhermit:storage `saves`, the document { v: 1, progress }): on the
//   device and in the player's cloud slot, two devices' progress merged on a
//   conflict (BSStore.mergeDocs through BSMigrate). The slot the browser
//   build wrote (the JS SDK's save.json: the checksummed { sum, payload }
//   document) shows as foreign and is merged in and replaced once;
// - the game's own settings (captions, theme, colour palette, left-handed
//   trays, haptics, the text board, confirm moves) are `settings`
//   (game.<key>, synced with the account); the browser build's settings
//   keys, and its cloud document's settings, are migrated and the keys
//   removed;
// - the device-local score boards stay on the device (`storage`
//   blockstead.leaderboards.v1 through js/store.js, as the browser build
//   kept them in localStorage), as does the round in progress
//   (blockstead.round.v1, main.ts);
// - a finished ranked round's total goes to the high-score board through
//   score-script.js: a practice session whose socket carries
//   { type: 'result', scores }, as the JS SDK's submitScores did.
import type { JsonValue } from "starhermit:engine";
import { connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, profile, sessions } from "starhermit:platform";
import { saves, settings as store } from "starhermit:storage";
import { Migrate, Store, type Progress, type Settings } from "./classic.ts";

// --- progress -------------------------------------------------------------------------
export let progress: Progress = Store.fresh().progress;
const listeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { listeners.add(fn); }
function merged(): void { for (const fn of listeners) fn(); }

let lastSavedAt = 0;
/** Saves the progress (device at once; the account debounced). */
export function persist(): void {
  try { saves.save(Migrate.saveDoc(progress) as unknown as JsonValue, { schema: 1 }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}
/** Takes progress in (merged with what this device has); whether it changed. */
function adopt(p: Progress | null): boolean {
  if (!p) return false;
  const before = JSON.stringify(progress);
  const next = Migrate.mergeProgress(p, progress);
  if (JSON.stringify(next) === before) return false;
  progress = next;
  return true;
}
/** Profile → Reset all progress: a fresh document (and the game's settings back to their defaults). */
export function resetAll(): void {
  progress = Store.fresh().progress;
  persist();
  for (const k of Migrate.GAME_SETTING_KEYS) setSetting(k, Store.DEFAULT_SETTINGS[k]);
}

/** Reads the device's save and the game's settings (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  const p = Migrate.progressFromSave(cur?.data);
  if (p) progress = p;
  else if (!cur) persist();
  if (saves.state() === "foreign") migrateForeign();
  initSettings();
  refreshInvite();
}

saves.onConflict((local, remote) => ({
  merged: Migrate.saveDoc(Migrate.mergeProgress(Migrate.progressFromSave(remote.data), Migrate.progressFromSave(local?.data))) as unknown as JsonValue,
}));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(Migrate.progressFromSave(cur.data))) { persist(); merged(); }
  }
});

/** The browser build's cloud save: its progress merged with this device's and
 * saved over it once; its game settings kept where the account has none. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const doc = Migrate.docFromBrowserSave(old.text);
  const changed = adopt(doc ? doc.progress : null);
  if (doc) {
    for (const k of Migrate.GAME_SETTING_KEYS) {
      const v = Migrate.migrateSetting(k, doc.settings[k]);
      if (v !== undefined && store.get(k) === undefined) setSetting(k, v);
    }
  }
  try { saves.save(Migrate.saveDoc(progress) as unknown as JsonValue, { schema: 1, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
  if (changed) merged();
}

/** For the title's account line: offline (a guest) | saving | synced | error. */
export function syncState(): "offline" | "saving" | "synced" | "error" {
  if (!player()) return "offline";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "uploading" || st === "foreign" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's settings -----------------------------------------------------------------
export const settings: Settings = { ...Store.DEFAULT_SETTINGS };
const settingsListeners = new Set<() => void>();
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
function settingsChanged(): void { for (const fn of settingsListeners) fn(); }
function readSetting(key: string): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = Migrate.migrateSetting(key, v);
  if (ok !== undefined) settings[key] = ok;
}
function initSettings(): void {
  for (const k of Migrate.GAME_SETTING_KEYS) readSetting(k);
  store.onChange((key) => {
    if (!Migrate.GAME_SETTING_KEYS.includes(key)) return;
    readSetting(key);
    settingsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  settingsChanged();
}
/** Changes one of the game's settings (device and account). */
export function setSetting(key: string, value: unknown): void {
  settings[key] = value;
  try { store.set(key, value as JsonValue); } catch (e) { console.warn(`setting ${key}: ${String(e)}`); }
  settingsChanged();
}
// The browser build's per-player settings: kept where the game still has the
// setting (unless this game set it since), then removed from the account.
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  let changed = false;
  for (const key of keys) {
    if (!Migrate.BROWSER_SETTING_KEYS.includes(key)) continue;
    const v = Migrate.migrateSetting(key, store.legacy(key));
    if (v !== undefined && store.get(key) === undefined) {
      try { store.set(key, v as JsonValue); settings[key] = v; changed = true; } catch { /* keep the device's */ }
    }
    store.removeLegacy(key);
  }
  if (changed) settingsChanged();
}

// --- the player -----------------------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function userId(): string | null { return player()?.userId ?? null; }
export function displayName(): string | null { return player()?.displayName ?? null; }
const names = new Map<string, string>();
/** A board row's player name: the profile's (cached) when signed in, else "Player <id8>". */
export function nameFor(id: string): string {
  const fallback = "Player " + id.slice(0, 8);
  if (!player()) return fallback;
  if (id === player()!.userId) return player()!.displayName;
  if (!names.has(id)) {
    names.set(id, "");
    profile(id).then((p) => { names.set(id, p.displayName); }, () => { /* the fallback stays */ });
  }
  return names.get(id) || fallback;
}
let invite: string | null = null;
function refreshInvite(): void {
  invite = null;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
onPlayerChange(() => refreshInvite());

// --- the StarHermit high-score board -------------------------------------------------------------
async function highScoreBoard(): Promise<{ id: string } | null> {
  const list = await leaderboards.list();
  return list.find((b) => b.key === "high-score") ?? null;
}
/** Signed in only: post a finished run's total through score-script.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(total: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": total } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const board = await highScoreBoard();
    if (!board) return { posted: true, rank: null };
    const r = await leaderboards.entries(board.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
