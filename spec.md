# Blockstead — running game design document

Present-tense description of the shipped game. Every statement below is true of the code in this repository unless it sits in the final "Design intent not yet implemented" list.

## 1. Overview

**Pitch.** Gather timber and stone from a sunny voxel valley, stack them into a small settlement, and meet every build goal before the plot seals or the moves run out.

| | |
|---|---|
| Genre | Solo construction puzzle / relaxed builder with ranked seeds |
| Players | 1; asynchronous score comparison on validated leaderboards |
| Session | 2–4 min per journey stage, 5–10 min for a daily or challenge, open-ended in score chase |
| Platforms | Desktop and mobile browsers (portrait and landscape); keyboard, mouse, touch, basic gamepad |
| Rendering | Three.js r-module (`vendor/three.module.min.js`) WebGL scene with a full semantic-HTML mirror; playable with WebGL unavailable |
| Hosting | Static files plus an optional authoritative Node script (`server.js`) declared in `starhermit.txt` |

### File map

| Path | Responsibility |
|---|---|
| `index.html` | Single page: HUD, board mirror, all DOM screens, script order (`rng → rules → content → store → session → audio → ui → main`) |
| `css/style.css` | Responsive shell: HUD rails/trays per breakpoint, screens, panels, key-art and results-art sizing, reduced-motion and high-contrast overrides |
| `js/rng.js` | mulberry32 PRNG, FNV-1a `hashString`, three derived streams (rules / decor / AV) |
| `js/rules.js` | Pure deterministic rules engine: `createGame`, `applyCommand`, legality checks, goals, scoring, hints, hashing, serialization |
| `js/content.js` | Versioned content (`CONTENT_VERSION = 1`): blocks, 5 themes, plot sizes, gather presets, 40 journey stages, 6 challenges, 3 practice presets, endless ruleset, daily generator, 6 lessons, 9 achievements |
| `js/session.js` | Command ids, undo stack, replay envelope, periodic state hashes, `verify()` used by the server |
| `js/store.js` | Checksummed local save document (`blockstead.save.v1`), local leaderboard cache, tie-break sort |
| `js/audio.js` | WebAudio buses, sample playback with synth fallback, captions, valley ambience, generative pad |
| `js/render.js` | Three.js scene: plot tiles, block meshes, seeded decor, weather, camera spring, picking, ghost/targets, quality tiers |
| `js/ui.js` | DOM shell: screen stack, HUD, palette, board mirror, results, settings form, help, profile, leaderboards, lessons, toasts, live region |
| `js/main.js` | Controller and state machine; the only module that issues commands into the session |
| `server.js` | Static server (refuses `data/`, `tests/`, `tools/`, `node_modules/`, dotfiles) plus `/api/v1/{time,daily,leaderboard,score,achievement}` |
| `data/` | Server-side JSON stores for leaderboards and achievements (never served) |
| `sfx/` | 24 Opus clips, `manifest.txt` (canonical binding), `manifest.json` (generator input), `manifest.md` (generated) |
| `assets/` | `key-art.webp` (title), `results-win.webp`, `results-lose.webp` |
| `coverart.png`, `icon.png`, `favicon.svg` | Platform cover (1200×675), icon, tab favicon |
| `tests/run-tests.js` | Node unit and content validators (`npm test`) |
| `tests/e2e.mjs` | Playwright playthrough on desktop and mobile viewports (`npm run test:e2e`) |
| `tests/browser-smoke.html`, `tests/shot-game.html` | Manual iframe harnesses (not shipped) |
| `starhermit.txt` | `name=Blockstead`, `launch=index.html`, `owner=…`, `server=server.js`, `cover=coverart.png` |

## 2. Vision and design pillars

Blockstead is about the quiet satisfaction of a tidy stack. The valley is warm, the blocks are chunky, and every placement lands with a material thud. The pressure comes from resources and geometry, never from a clock.

1. **Every block is a decision, not a click.** Timber and stone are scarce, glass needs a footing, lamps and plants end a column for good. Rules in: stock caps, support rules, toppers, immovable rocks, a remove penalty. Rules out: free-form painting, infinite inventory, cosmetic-only blocks.
2. **Gathering costs turns.** Every gather is a move; move-limited rulesets make "go get more" a real trade-off, and par rewards restraint. Rules in: `moves` counting every command, par bonuses, move limits. Rules out: passive income, timers.
3. **Seeds are honest.** Rock layouts, gather yields and endless waves come from one seed; the same seed always gives the same valley, and the server replays your log before it believes your score. Rules in: FNV-hashed dailies, envelope verification, deterministic AV pitch variants. Rules out: hidden luck, client-trusted totals.
4. **The plot is the hero.** The camera frames the plot, the HUD stays at the edges, and every reachable column is marked before you commit. Rules in: green target discs, a ghost block with a red/green verdict, a text board that mirrors the 3D plot cell for cell. Rules out: menus over the plot during play, effects that hide legal targets.
5. **Finishable in a lunch break.** Stages are 4×4 to 6×6 with 1–4 goals; the whole journey is 40 stages with six mastery checkpoints. Rules out: grind, energy, unlock walls beyond stars.

## 3. Player experience

**Target player.** Someone who likes small, tactile building puzzles and wants a daily seed to compare with friends, on a phone or a laptop, without reading a manual.

**First 60 seconds.** The title shows key art, one dominant Play button and, one level down, Daily challenge (with a countdown), Journey (with progress) and Profile. Play opens the mode list; Journey opens stage 1 "First Foundation" (4×4, timber and stone in hand, goal "Place Timber 0/3"). Its intro message is pinned in the HUD: "Tap a block in the tray, then tap a plot tile to build. Gather when you run low." Green discs mark every legal column; hovering or focusing shows a translucent ghost block that turns red with an explanation when illegal. The first placement pops the block and thuds; the third completes the goal (chime), then the round ends won and the results overlay explains the score line by line. Learn mode offers six one-rule lessons (`content.js › tutorialLessons`) for players who want them; journey intros introduce each new mechanic at the stage where it first appears (glass at j06, lamp at j11, plant at j14, move limit at j16, lean gathers at j17, rocks at j21).

**Session shape.** Pick a stage or seed → build for a few minutes → results breakdown with stars → Next stage, Retry, or Menu. Backgrounding the tab pauses. Leaving mid-round stores a snapshot, so the title's Play button becomes "Resume round" next time.

**Emotional beat.** The moment the last goal strikes through and the four-note win chime plays over a settlement you can still see behind the results panel.

## 4. Core loop and rules contract

All rules live in `js/rules.js`; nothing else mutates game state.

### Board and entities

- Plot: `cfg.plot = {cols, rows, maxH}`; sizes `s` 4×4×4, `m` 5×5×5, `l` 6×6×6 (`content.js › SIZES`). `state.grid[y][x]` is a bottom-to-top array of block ids.
- Block types (`content.js › BLOCKS`): `wood` (Timber), `stone`, `glass`, `plant`, `lamp`, plus terrain `rock`.
- Toppers `{lamp, plant}`: nothing stacks on them. Needs-support `{glass, lamp, plant}`: cannot sit on bare soil or on rock.
- Rocks (`createGame`): seeded from the rules stream; count `min(cfg.rocks, floor(cells/3))`, never on the centre cell(s), each 1–`min(2, maxH−2)` high, immovable, and they never count toward built height.
- Inventory `state.inv[type]`, capped at 99 (`INV_CAP`).

### Commands and legality

| Command | Legal when (`checkPlace` / `checkRemove` / `checkGather`) | Rejection ids (`INVALID`) |
|---|---|---|
| `gather` | round live and `cfg.gather` non-empty | `game-ended`, `unknown-command` |
| `place {x,y,block}` | in bounds; block in `cfg.blocks`; stock > 0; column below `maxH`; top is not a topper; support rule satisfied | `bad-cell`, `block-not-allowed`, `no-resource`, `column-full`, `topper-blocks-stacking`, `needs-support` |
| `remove {x,y}` | `mechanics.remove !== false`; in bounds; column non-empty; top is not rock | `remove-disabled`, `bad-cell`, `nothing-to-remove`, `rock-is-immovable` |
| `resign` | round live | — |

`legalActions(state)` enumerates the full surface; hints and tutorials use exactly it. `validateCommandShape` bounds payloads (≤512 chars, ids ≤64 chars, integer coordinates).

### Resolution order (`applyCommand → beginStep → do* → endStep`)

1. `beginStep`: clone state, `tick++`, `moves++`, `elapsedMs = floor(cmd.atMs/100)*100`.
2. Effect: gather rolls each `cfg.gather[type] = [lo,hi]` from the rules PRNG (`rngState` advances); place decrements stock, pushes the block, adds `PLACE_PT`; remove pops the top block and adds `REMOVE_PENALTY`.
3. `endStep`: evaluate goals (monotonic: a met goal stays met, +150 each); if all goals met → endless: `wave++`, new goals from `nextWaveGoals`; otherwise **win** (`goals-met`). Then, if not terminal and `moves >= moveLimit` → **lose** (`move-limit`). Then, if no legal place and no legal remove → **lose** (`landlocked`). Terminal states call `finalizeScore`.

### Goals (`goalProgress`)

`{kind:'count', type, n}` blocks of a type on the plot; `{kind:'height', n}` tallest built column (rocks excluded); `{kind:'columns', h, n}` number of columns with built height ≥ h. Content encodes them as `c:wood:3`, `h:2`, `k:2:2` (`parseGoal`).

### Scoring (`rules.js` constants)

`total = place + goal + win + stock + par − removePenalty`, floored at 0.

| Component | Value |
|---|---|
| place | wood 5, stone 7, glass 10, plant 9, lamp 14 per block (`PLACE_PT`) |
| goal | 150 per goal completed (`GOAL_PT`) |
| win | 250 flat on `goals-met` (`WIN_PT`) |
| stock | 3 per leftover resource at win (`STOCK_PT`) |
| par | 12 per move under `cfg.par.moves` at win (`PAR_PT`) |
| removePenalty | 2 per removed block (`REMOVE_PENALTY`) |

**Worked example (j01 "First Foundation", par 6).** Start with 3 timber, 2 stone. Place timber at (1,1) three times: place = 3×5 = 15; goal "Place Timber ×3" met → +150; all goals met → win +250; leftover stock 2 stone → +6; 3 moves vs par 6 → 3×12 = +36; no removals. Total **457**. The HUD shows `currentScore` (place + goal − penalty) live; win-only components appear at results.

**Journey stars** (`main.js › endRound`): 1 for the win, +1 for `moves ≤ par`, +1 for zero removals.

### Endless waves (`nextWaveGoals`)

On wave `w` (starting at 1): a count goal `2 + w` of a random placeable type; then either a height goal `min(2 + floor(w/2), maxH−1)` (70 %) or a columns goal `h=2, n=min(1+ceil(w/2), cells−2)`; from wave 3, a 50 % chance of a lamp goal `1 + floor(w/3)`. `score.waves` counts completed waves and is shown on results.

### Terminal states and tie-breaks

`terminal.reason ∈ {goals-met, move-limit, landlocked, resigned}`, `won` only for `goals-met`. Leaderboard order (`store.js › sortEntries` and `server.js`): higher score, fewer invalid commands, lower `durationMs`, then `sessionId` string order.

### RNG, hashing, replay

- Master seed per config; `RNG.derive(seed, STREAM_RULES)` drives rocks and gathers, `STREAM_DECOR` (in `render.js`) drives trees and hills, `STREAM_AV` drives ±6 % pitch variants in `audio.js`. Weather uses tag `0x51ed270b` in `main.js`.
- `hashState` = FNV-1a over a key-sorted JSON of the state minus `events`. `session.js` records a hash every 8 accepted commands and at terminal; `verify(cfg, envelope)` rebuilds from trusted content, replays, and checks initial hash, every periodic hash, terminal reason and score.
- Command ids are `c<seq>-<seed base36>` unless supplied; duplicate ids are acknowledged idempotently without changing state.

### Undo and hints

- Undo (`session.js › undo`) restores the pre-command snapshot and truncates the log (max 200 snapshots); allowed only when `cfg.mechanics.undo !== false` and the round is live. Undo is not a rules command and does not count as a move.
- `rules.js › hint` prefers a placement toward the first unmet goal (count → its block; height → tallest legal column with a stackable block; columns → shortest column below `h`), suggests gather when the needed stock is 0, otherwise any legal place. `mechanics.hint === false` disables the button.

## 5. Modes and progression

| Mode | Content | Ranked | Assists | Notes |
|---|---|---|---|---|
| Learn | 6 lessons t1–t6: gather, place ×2, height 2, glass support, lamp topper, undo | No | hint on; undo only in t6 | Lesson ends on its event count or on a stage win; banner shows `n/count` |
| Journey | 40 authored stages (`content.js › J`), sizes s→m→l, themes advance meadow → ember → frost → canyon → nightfall | Per stage (`journey:<id>`) | undo, hint, remove on | Stage i+1 unlocks when stage i has ≥1 star; mastery stages j10, j20, j25, j30, j35, j40 |
| Daily | One immutable config per UTC date (`dailyConfig`) | `daily:<date>` | undo, hint on | Seed = FNV(`blockstead-daily-v1-<date>`); rotation `day%7` picks 3–5 block types, plot m/l, goals, 0–3 rocks, a 40-move limit on rotation 6, par 22–34 |
| Practice | Casual (4×4, wood/stone), Apprentice (5×5, +glass, lamp, 2 rocks), Expert (6×6, all blocks, 5 rocks) | No | all on | Difficulty picker on the setup screen |
| Challenges | c1 Tight Schedule (20 moves, no undo), c2 No Demolition, c3 Rocky Plot (8 rocks), c4 Glassworks (no undo, 34 moves), c5 Dark Acre (no hints), c6 Master Constraint (no undo, no hints, 52 moves) | `challenge:<id>` | per config | Setup lists the facts before Start |
| Score chase | "Endless Skyline": 6×6, all blocks, 3 rocks, no undo/hint, waves until the plot seals | `global` | none | Best score and wave count stored in profile |

**Difficulty curve.** j01–j10 introduce placement, stacking, glass and two-column goals on 4×4 with generous gathers; j11–j20 add lamps, plants, the first move limit, lean gather presets and the 6×6 plot; j21–j25 add rocks; j26–j40 combine height 5–6, glass counts, lamp counts and tight limits (j40: height 6, 6 glass, 6 lamps, 4 columns of 3, 56-move limit, par 46).

**Unlocks.** Themes by total journey stars: Sunlit Meadow 0, Ember Dusk 12, Frostfell 30, Red Canyon 55, Nightfall 85 (`THEMES[].unlockStars`). Achievements (`ACHIEVEMENTS`): first-place, first-win, tower-5, blocks-500, journey-half (20 stages), journey-done (40), daily-7, score-2500, challenger (all six challenges).

**Today's daily as an example (2026-09-08).** Rotation 3: 6×6, all five blocks, goals Place Timber 6 / height 4 / 4 columns of 2, 3 rocks, no move limit, par 32, seed 2641576613.

## 6. Controls and interaction

| Input | Action | Feedback |
|---|---|---|
| Tap/click a plot tile (≤8 px movement, <600 ms) | Place selected block or remove (remove tool on) | `select` cue, block pop, material thud; invalid → HUD reason, `invalid` cue, 30 ms haptic |
| Drag on the canvas (>8 px) | Orbit camera (θ free, φ clamped 0.35–1.35 rad) | Camera spring follows; no pick fires |
| Mouse wheel | Zoom (distance 5–26) | — |
| Mouse hover | Ghost block on the hovered column, green or red | HUD reason for red |
| Tray button / keys `1`–`5` | Select block type | Button `aria-pressed`, `select` cue, targets re-marked |
| `G` / ⛏ Gather / gamepad X | Gather | `gather` cue, 15 ms haptic, "Gathered 2 Timber, 1 Stone" |
| `R` / 🧨 Remove | Toggle remove tool | `select`/`deselect`, targets become removable tops |
| `U` / ↩ Undo / gamepad Y | Undo | `undo` cue; disabled state when nothing to undo or ruleset forbids |
| `H` / 💡 Hint | Hint | `hint` cue, message "Hint: place Timber on column 2, 3.", block auto-selected, ghost shown |
| `S` / ⏩ Skip | Settle all animations instantly | "Animations skipped" |
| `C` / 📷 View | Reset camera to authored framing | — |
| `←`/`↑`, `→`/`↓`, gamepad D-pad | Cycle keyboard focus through legal targets | Ghost moves; live region "Target column x, y" |
| `Enter` / `Space` / gamepad A | Commit focused target | As tap |
| `P` / `Esc` / ⏸ / gamepad Start | Pause / resume | `pause` and `resume` cues |
| `Esc` outside a round | Back one screen | — |
| Any DOM-screen button | Navigate | `ui` tick |

**Confirm moves** (settings): the first tap on a column shows the ghost and "Tap again to confirm"; the second tap on the same column commits.

**Input locking.** Commands are accepted only while `round.phase === 'active'`; the DOM screens are hidden during play and every overlay (pause, results, settings, help) sets a different phase or screen, so no command can leak through a menu. There is no animation lock: state is applied instantly and the 0.25 s scale pop is cosmetic.

**Board mirror.** A grid of 44 px buttons (`ui.js › boardMirror`) labelled "Column x, y: wood, glass, legal target" duplicates the plot; it is always shown when WebGL is unavailable or when "Always show text board" is on, and it accepts the same taps.

## 7. Screens and UI flow

`main.js` phases: `boot → title → (modes | journey | learn | profile | leaderboard | settings | help) → setup → active ↔ paused → results → title`. `ui.js` keeps a screen stack; `title` resets it, overlays (`pause`, `results`, `settings`, `help`) stack on top of the current screen, and `game` is a HUD-only pseudo-screen that hides `#screens`.

| Screen | Contents |
|---|---|
| Title | Key art, name, tagline, Play/Resume round, Daily (countdown to next UTC day), Journey (n/40), Profile, How to play, Settings, Scores |
| Modes | Six cards with description and ranked/unranked meta |
| Setup | Name, intro, fact list (limits, locked tools, rocks, expected time), ranked note, option buttons (practice difficulty / challenge pick), Start |
| Journey | Stars total, 40-cell grid (number, name, ★☆☆, 🔒), mastery cells outlined gold |
| Learn | Six lesson cards, ✓ when done |
| Game (HUD) | Top bar: pause, mode name, clock, ★ score, moves (`n` or `n/limit`); goals rail; palette tray with stock counts; actions tray (Undo, Hint, Skip, View); message line; lesson banner |
| Pause | Resume, Settings, Help, Restart round, Leave round |
| Results | Title ("Settlement complete!" / "Round over"), win or loss illustration, headline, 8-row breakdown, stars, new achievements, time and par, Next (journey only) / Retry / Menu |
| Settings | Audio (4 sliders, mute, captions), Graphics (tier, reduced motion, high contrast, palette), Controls & access (larger text, left-handed, haptics, text board, confirm moves) |
| Help | Nine rule cards with key bindings |
| Profile | Guest name, connection note, 8 stats, achievement list, theme picker, Erase local progress |
| Scores | Tabs Endless (global) / Today's daily; validated table when hosted, local table offline |

**Layouts (`css/style.css`).** ≥1024 px: goals rail top-left (≤300 px), actions column top-right, palette bottom-centre. 640–1023 px: goals top-right (≤260 px, scrolls at 40 vh), actions bottom-right column. ≤639 px portrait: compact top bar, goals as a wrapped chip row under it (≤22 vh), palette above the actions tray at the bottom, 56 px icon buttons. Landscape ≤540 px tall: goals right rail, palette bottom-left, actions bottom-right, 48 px buttons. All fixed elements use `env(safe-area-inset-*)`. Left-handed mirrors the trays. Panels cap at `min(96vw, 680px)` (`wide` 900 px) and scroll inside `min(88vh, 780px)`. Key art caps at 34 vh (22 vh under 560 px tall); results art caps at 18 vh (12 vh on phones) and is hidden under 640 px tall so the Next/Retry/Menu row is never pushed off-screen.

**Must never be cut off:** the Play button, the palette and actions trays, the goals chip row, the results action row, and the board mirror when enabled.

## 8. Art direction

**World.** A toy-scale voxel valley: a square soil plot on a green disc, low-poly cone pines, a round pond, six distant hills, a sun with soft shadows. Blocks are 0.92-unit cubes; plants get a leaf cap, lamps an emissive body with a dark cap, rocks are slightly scaled and rotated per cell. Hero of the screen: the plot and its stacks, framed by an authored camera (`FRAMING` θ 0.65, φ 0.95, distance 11 + 0.6 × plot size).

**Palette.**

| Role | Value |
|---|---|
| Page background / text | `#0b1420` / `#eef2f6`; high contrast `#000` / `#fff` |
| Panels, HUD | `#101c2ae8`, HUD `rgba(10,18,28,.62)` with 6 px blur |
| Primary button | `#3b82f6`; danger `#b91c1c`; focus ring and stars `#ffd27a` |
| Blocks (standard) | timber `#b07a45`, stone `#8d9299`, glass `#9fd8e8` @ 72 % opacity, plant `#6fbf5a` + leaf, lamp `#ffd27a` emissive 0.85, rock `#6b6560` |
| Blocks (high visibility) | timber `#b7791f`, stone `#9aa0a8`, glass `#4cc9f0`, plant `#2f9e44`, lamp `#ffd60a` |
| Targets | legal disc `#7cfc9a`; hover ring `#fff2a8`; illegal ring `#ff6a5e`; ghost `#9fff9f` / `#ff8a7a` |
| Theme: Sunlit Meadow | sky `#87bfe8`, horizon `#d8ecdc`, ground `#77a95c`, soil `#8a6a48`, sun `#fff2cc` ×1.25, fog `#bcd8e8`, water `#5f9fc8`, leaf `#4f8f3f` |
| Theme: Ember Dusk | sky `#e8a06a`, ground `#8a7a4a`, soil `#7a5638`, sun `#ffc27a` ×1.0, water `#7a88a8`, leaf `#6a7a35` |
| Theme: Frostfell | sky `#a8c8e0`, ground `#c8d4da`, soil `#8a96a0`, sun `#eaf4ff` ×0.9, water `#7ab8d8`, leaf `#5a7a6a` |
| Theme: Red Canyon | sky `#e8b088`, ground `#b87a4f`, soil `#96543a`, sun `#ffd8a0` ×1.15, leaf `#8a8a3a` |
| Theme: Nightfall | sky `#232c48`, ground `#3a4a42`, soil `#3a3230`, sun `#9fb8ff` ×0.45, water `#2a3a58`, leaf `#2f4a38` |

Colour is never the only cue: each block has an icon (🪵 🪨 🧊 🌿 🏮 ⛰), a label, a stock count, and a distinct shape (leaf cap, lamp cap, rock scale).

**Typography.** System UI stack, 16 px base (20 px with "Larger text"), headings `clamp(1.5rem, 4.5vw, 2.1rem)`, title `clamp(2.4rem, 8vw, 4rem)`, tabular numerals on the clock.

**Motion.** Camera uses an exponential spring (`1 − e^(−7·dt)`), interruptible, with a 6-unit intro swoop; placement/removal is a 0.25 s scale pop; rain is a 600/1600-point particle field that fades in over the weather change. Weather (`main.js › startWeather`) advances every 40 s through a seeded 6-entry order of sun/sun/cloud/rain (sun always first); cloud dims the sun to 70 %, rain to 45 % and lifts the fog blend. **Reduced motion** (setting or class `reduced-motion`): camera snaps, no pops, no CSS transitions, intro swoop skipped. Quality tiers cap device pixel ratio at 1 / 1.5 / 2, drop shadows and rain on `low`, and halve tree count.

**Visual assets the design calls for.** Title key art (a lit settlement on the plot, shipped as `assets/key-art.webp` and reused as `coverart.png`), a warm win illustration and a rainy loss illustration for the results overlay (`assets/results-win.webp`, `assets/results-lose.webp`), the favicon/icon. No imported 3D models: the shape language is deliberately primitive voxels built in `render.js`, so a sculpted hero prop would break it.

## 9. Audio direction

**Mix.** Four gain buses (`music` 0.55, `effects` 0.9, `ambience` 0.5, `voice` 0.8 defaults) under a master; mute zeroes every bus; sliders ramp over 50 ms. The context starts on the first pointer/key gesture, suspends on pause (350 ms after the pause cue) and tab hide, resumes on return. Every event has a WebAudio synth fallback that plays while its Opus sample loads or if the fetch fails, so the game is never silent because of a missing file.

**Ambience and music.** Wind is looped brown noise through a 300 Hz low-pass (700 Hz in rain) at 0.3 / 0.4 / 0.55 for sun / cloud / rain; sparse 2–4-note bird chirps every 3–10 s except in rain. Music is a generative pad: C–Am–F–G triads an octave down, triangle root plus sines, 650 Hz low-pass, 2 s swell / 6.8 s release, a new chord every 5.6 s.

**Captions.** With "Captions for sounds" on, each event's caption ("timber placed", "goal complete", "rain begins"…) shows for 1.6 s in `#caption`.

### SFX event table (source of `sfx/manifest.txt`)

| Event id | File | Sound | Used when |
|---|---|---|---|
| `ui` | `ui.opus` | Dry plastic button tick | Any DOM-screen button (menus, pause, results, settings) |
| `select` | `select.opus` | Soft wooden block tap | Block chosen, remove tool on, plot cell tapped |
| `deselect` | `deselect.opus` | Lower muted wooden tap | Remove tool off |
| `gather` | `gather.opus` | Pickaxe on stone, two hits | Gather accepted |
| `place-wood` | `place-wood.opus` | Plank thud | Timber placed |
| `place-stone` | `place-stone.opus` | Heavy stone thump | Stone placed |
| `place-glass` | `place-glass.opus` | Bright glass clink | Glass placed |
| `place-plant` | `place-plant.opus` | Leafy rustle, soil pat | Plant placed |
| `place-lamp` | `place-lamp.opus` | Lantern clink with warm buzz | Lamp placed |
| `remove` | `remove.opus` | Chunky crumble | Block removed |
| `invalid` | `invalid.opus` | Flat low buzzer | Rejected command (with HUD reason) |
| `goal` | `goal.opus` | Two-note ascending bell | A goal reaches its target |
| `wave` | `wave.opus` | Three marimba notes | New endless wave |
| `win` | `win.opus` | Four-note bell fanfare | Round won |
| `lose` | `lose.opus` | Slow descending tone | Move limit, landlocked, resign |
| `undo` | `undo.opus` | Tape rewind swish | Undo |
| `hint` | `hint.opus` | Glissando shimmer | Hint |
| `star` | `star.opus` | Glockenspiel ping | Achievement unlocked |
| `weather-rain` | `weather-rain.opus` | Rain starting on leaves | Weather turns to rain |
| `weather-cloud` | `weather-cloud.opus` | Gust over a meadow | Weather turns to cloud |
| `round-start` | `round-start.opus` | Breeze swell, chirp, wooden tap | Round begins or is restored |
| `lesson-complete` | `lesson-complete.opus` | Three-note xylophone flourish | Learn lesson finished |
| `pause` | `pause.opus` | Muffled felt thump | Pause |
| `resume` | `resume.opus` | Rising two-note chime | Resume |

All clips: MOSS-SoundEffect v2.0, 48 kHz mono Opus 96 kbps, loudness-normalised to −20 LUFS, 1–3 s.

## 10. Localization

The shipped build is **English only** (`<html lang="en">`); the target set for this game is en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT. User-facing strings live in four places: static markup in `index.html`, HUD/menu strings in `js/main.js` (goal labels, invalid-reason texts, mode cards, help cards, settings schema, results rows), screen labels and table headers in `js/ui.js`, and content names/intros/lesson texts in `js/content.js`. There is no string table and no language selection; the layout already tolerates ~30 % expansion (buttons wrap, panels scroll, HUD moves text ellipsises at 9 ch on phones). See "Design intent not yet implemented".

## 11. Accessibility

- **Keyboard-only path:** every screen is buttons and form controls; `showScreen` focuses the primary button or heading of each screen; in play, arrows cycle legal targets, Enter/Space commits, letters map every tool, Esc/P pause. No hover-only action exists (hover only previews).
- **Focus:** 3 px `#ffd27a` ring (`#00e5ff` in high contrast), `:focus-visible` everywhere.
- **Screen reader:** `#sr-live` (polite) announces screen changes, selections, targets, gathers, goals, achievements, round start/end; HUD buttons carry `aria-label` with the key; palette buttons expose stock; the board mirror is a grid of labelled buttons; the canvas is `aria-hidden`.
- **Captions** for all sound events (setting); **haptics** toggle; **reduced motion**; **high contrast** (black panels, white borders); **high-visibility block palette**; **larger text** (20 px); **left-handed** tray mirroring; **confirm moves** two-tap assistance; **text board always on**.
- **Targets:** ≥44 px buttons everywhere; 56 px HUD icons on phones, 48 px in landscape; mirror cells 44 px.
- **WebGL unavailable:** an alertdialog explains, "Continue with text board" switches the mirror on permanently.

## 12. StarHermit integration

Conventions follow https://wiki.starhermit.com/ (manifest at the distribution root, `launch`, optional `server`, same-origin `/api/v1`).

**Used**

- `starhermit.txt`: `name`, `launch=index.html`, `owner`, `server=server.js`, `cover=coverart.png`.
- Server script `server.js`: `GET /api/v1/time` (client computes a round-trip-adjusted offset for the daily countdown and date), `GET /api/v1/daily`, `GET /api/v1/leaderboard?board=` (top 50, tie order as §4), `POST /api/v1/score` (envelope replayed with `Session.verify` against trusted content only; duplicate envelopes idempotent; 5000-entry cap), `POST /api/v1/achievement` (idempotent per player key). Per-IP token bucket (30 tokens, +1 per 2 s, score costs 5), 64 KB body limit, structured `{error}` responses that the client shows as toasts.
- Boards: `global` (score chase), `daily:<date>`, `journey:<id>`, `challenge:<id>`; practice and learn are unranked.
- Offline behaviour: when `/api/v1/time` fails the client marks itself unhosted, keeps a local leaderboard cache (`blockstead.leaderboards.v1`) and labels boards "casual".
- Launch token (`main.js#initPlatform`): read from the URL fragment `#game_token=<jwt>` (optional `&session_id=`, stripped after the read; query `?token=`/`?launch_token=` kept for local dev), decoded for `sub` + `game_scope` (never hard-coded), sent as `Authorization: Bearer` on every `/api` call, re-minted every 45 min via `POST /api/v1/games/{slug}/launch-token` (60 s retry). The profile nickname from `GET /api/v1/users/{sub}/profile` (never `/api/v1/me`, never usernames; `Player <id8>` fallback) replaces the `Guest-xxxx` label on the profile screen and on score/achievement submissions (which also carry the account id; `server.js` stores it on board entries so rows resolve to nicknames, own row marked "You"). Board fetches carry the Bearer header; when the own-server routes 404 on-platform the client falls back to the local board with no console errors.

**Not used**

- Avatars, presence heartbeats, activity start/end, per-game cloud settings or cloud saves, friends filtering, realtime rooms, matchmaking, chat, voice, entitlements. Achievements are delivered to the server keyed by the account id (or guest name offline) and also kept locally in the save document.

## 13. Technical architecture

- **Module boundaries.** `rules.js` and `content.js` are pure UMD modules shared with Node; `session.js` wraps them with ids, undo and envelopes; `main.js` is the only caller of `Session.execute`; `render.js` and `ui.js` consume immutable state snapshots and call back through `onPick`/hooks.
- **Determinism and replay.** Same content version + seed + ordered commands → identical `hashState` sequence; verified by `tests/run-tests.js` (40 random trials) and by the server on every ranked submission. Cosmetic streams (decor, AV, weather) never touch rules state.
- **Persistence.** `blockstead.save.v1` — `{sum, payload}` where `sum` is FNV-1a of the payload; corrupt or future-version documents fall back to a fresh save; an in-memory fallback keeps the session alive when `localStorage` throws. `blockstead.round.v1` — `{cfg, commands, mode, levelIndex}` snapshot after every accepted command, pause and undo; resumed by replaying the log and cleared on any terminal or leave. `blockstead.leaderboards.v1` — local entries.
- **Lifecycle.** `visibilitychange` pauses an active round, stops the render loop and suspends audio; resume restores the loop and the clock baseline so paused time never counts (`elapsedMs` comes from command timestamps quantised to 100 ms).
- **Rendering budget.** Plots are ≤36 columns × 6 blocks, so meshes are rebuilt per state change from shared geometries/materials; rain 0/600/1600 points by tier; shadow map 1024²; DPR caps 1/1.5/2; `low` tier disables shadows and rain. The loop clamps `dt` to 50 ms and stops entirely while hidden.
- **Resilience.** WebGL creation failure or context loss shows the fallback dialog and forces the board mirror; every sample fetch failure keeps the synth path; every image has `onerror="this.hidden=true"`; the API is optional.
- **Funnel counters** (`progress.stats.funnel`) count boot, mode starts, lesson steps, round ends, retries and setting changes locally only; nothing is sent.
- **How the e2e drives the real UI.** `tests/e2e.mjs` embeds its own static server on an ephemeral port (so `/api/*` 404s and the offline path is exercised), launches headless Chrome, and for each of a 1280×800 desktop context and a 390×844 touch context: waits for `data-screen="title"`, opens Settings and checks "Always show text board" and "Reduced motion" through the real form, opens Journey and asserts 40 cells with exactly one unlocked, starts stage 1, then loops: click the on-screen Hint button, read the HUD message, and either click Gather or click the mirror cell named in the hint, until the results overlay appears; it then asserts the breakdown rows, the "every goal met" headline, stars, persisted `journeyStars.j01` and `stats.rounds`, presses Next, pauses with `P`, resumes, opens Settings from the pause overlay, and leaves to the title. Any page error, console error (other than known GPU driver noise and `/api/*` 404s) or non-API HTTP ≥400 fails the run.

## 14. Testing and acceptance criteria

`npm test` (`tests/run-tests.js`, 1538 assertions) verifies: every legality check and rejection id; each scoring component and the total; move-limit, resign, landlock and monotonic tick; serialize/deserialize hash equality and version rejection; 40 seeded sessions of random legal play that replay-verify, reject a tampered score, and undo cleanly; 300 fuzzed malformed commands without throws or NaN; every journey stage, challenge, practice preset and one week of dailies is versioned, has reachable goals, has legal actions at start, and is solved by the greedy hint solver within budget (within its move limit where one exists); the endless ruleset progresses; every lesson has legal actions and a completion event; achievement keys are unique lowercase; save checksum and migration; server trusted-content lookup rejects bad ids.

`npm run test:e2e` verifies the playthrough described in §13 on desktop and mobile with zero page errors.

**QA bar (checkable).**

- A new player reaches stage 1 in two clicks from the title (Journey → stage 1) and sees a pinned instruction plus green target discs before touching anything.
- Every feature reachable by button: all six modes, all 40 stages (progressively), all six lessons, settings, help, profile, themes, scores, pause, restart, leave, undo, hint, skip, camera reset.
- Zero console errors or warnings at 1280×800 and 390×844, portrait and landscape, with and without WebGL.
- Nothing cut off: HUD trays, goals, results rows and action row, title buttons at both viewports; long HUD text ellipsises rather than overflows.
- Every input has visible and audible acknowledgment; every rejection shows its reason.
- Ranked scores reach the server only with a verifiable envelope; an edited total is rejected with `score-mismatch`.

## 15. Asset inventory

| Asset | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1200×672, 42 KB) | Title screen hero image | FLUX.2 klein, seed 6701, 30 steps | generated in this pass, wired (`index.html .key-art`) |
| `assets/results-win.webp` (640×400, 12 KB) | Results overlay on a win | FLUX.2 klein, seed 6702, 30 steps | generated in this pass, wired (`main.js › showResults`) |
| `assets/results-lose.webp` (640×400, 10 KB) | Results overlay on a loss | FLUX.2 klein, seed 6703, 30 steps | generated in this pass, wired |
| `coverart.png` (1200×675, 213 KB, 256-colour) | Platform cover | Key art rescaled and cropped (replaces the generic placeholder) | generated in this pass |
| `icon.png` (256×256), `favicon.svg` | Platform icon, tab icon | Hand-authored SVG voxel on sky blue | shipped |
| `sfx/*.opus` — 19 original clips (`ui` … `weather-rain`) | Event cues, see §9 | MOSS-SoundEffect v2.0, 100 steps | shipped |
| `sfx/weather-cloud.opus`, `round-start.opus`, `lesson-complete.opus`, `pause.opus`, `resume.opus` | New event cues, see §9 | MOSS-SoundEffect v2.0, 100 steps | generated in this pass, wired in `audio.js`/`main.js` |
| `sfx/manifest.txt` | Canonical clip ↔ event binding | authored | shipped |
| `vendor/three.module.min.js` | Renderer | Three.js (MIT) | shipped |
| 3D models | — | none; all geometry is procedural in `render.js` | not called for |
| Character animation | — | no humanoid in the game | not applicable |

## 16. Known limitations

- No localization: all strings are English literals (§10).
- Without a launch token the player identity is a per-load random guest name attributed to scores and achievements; the local save is not cloud-synced.
- Leaderboards are global only; no friends filter. The Scores screen exposes only the `global` and today's `daily` boards (journey and challenge boards are submitted but not browsable in the UI).
- Landlock can only occur when removal is impossible (remove tool disabled, or every column top is rock); with the remove tool on, a full plot always has a legal remove, so score chase effectively ends by resignation rather than sealing.
- The greedy hint in score chase can cycle (place, then the next wave's goals need removal) — it is a suggestion, not a solver.
- Camera orbit and zoom are pointer-only; keyboard users get the reset framing.
- Gamepad bindings are fixed (A confirm, B cancel remove, X gather, Y undo, Start pause, D-pad left/right).
- The `voice` bus exists but no voice content ships.
- Results illustration is hidden on viewports under 640 px tall to keep the action row on screen.
- Pausing via tab hide suspends audio immediately, cutting the pause cue short.

## Design intent not yet implemented

- String table with the nine target locales, chosen from `navigator.language` with a settings override.
- StarHermit avatar on the profile screen, presence heartbeats and activity start/end pairing, per-game cloud settings and cloud-saved progress (launch-token identity with board nickname resolution is done; scores/achievements key off the account id when hosted).
- Friends-filtered leaderboards and a shareable seed link for dailies and challenges.
- Journey and challenge board tabs on the Scores screen.
- Keyboard camera orbit (e.g. `Q`/`E`, `+`/`−`).
