# Blockstead — running game design document

Present-tense description of the shipped game. Every statement below is true of the code in this repository unless it sits in the final "Design intent not yet implemented" list.

## 1. Overview

**Pitch.** Gather timber and stone from a sunny voxel valley, stack them into a small settlement, and meet every build goal before the plot seals or the moves run out.

| | |
|---|---|
| Genre | Solo construction puzzle / relaxed builder with ranked seeds |
| Players | 1; scores compared on device-local boards and, when signed in, the StarHermit `high-score` board |
| Session | 2–4 min per journey stage, 5–10 min for a daily or challenge, open-ended in score chase |
| Platforms | The StarHermit engine 1.16.2 (host API 1.18): natively in the StarHermit client and in desktop and mobile browsers through the engine's web runtime; keyboard, mouse, touch, gamepad |
| Rendering | `starhermit:scene` (three.js-like) with the runtime's ambient occlusion, bloom, grade and antialiasing per graphics level; the HUD and screens in `starhermit:ui` |
| Hosting | A StarHermit script game package (`starhermit.txt`: `engine.entry=native/main.ts`, `engine.version=1.16.2`, `engine.minor=16`, capabilities `platform,storage,clipboard`) plus the platform script `score-script.js` (`server=`); `index.html` is the engine's web loader written by `npm run package`; `server.js` is the local dev server |

### File map

| Path | Responsibility |
|---|---|
| `native/main.ts` | Entry module: the round (session commands, undo, hints, remove tool, confirm-moves, target cycling, lessons, weather, terminal → progression, stars, achievements, local boards and the high-score post, the saved round in progress), the screen stack, input routing, lifecycle |
| `native/screens.ts` | HUD (top bar, goals card, block tray, actions tray, guidance line, lesson banner, toast, captions, text board) and every screen in `starhermit:ui`; the four layouts; the free rectangle the valley is framed into |
| `native/render.ts` | The valley in `starhermit:scene`: tiles, blocks, seeded decor, WGSL sky dome, clouds, rain and motes, weather, target discs and ghost, orbit camera spring with `setViewOffset` framing, column-box picking, the look per graphics level |
| `native/quality.ts` | The browser build's four presets and budgets keyed by the runtime's quality tier and level |
| `native/audio.ts` | Clips on the runtime's mixer, rendered wind / birds / pad, captions |
| `native/platform.ts` | Engine save (progress) with cross-device merge and the browser build's cloud save migrated, the game's settings, player names, invite link, high-score posting through `score-script.js` |
| `native/classic.ts` | Loads the shared `js/*.js` as classic scripts (localStorage shim over device storage) and types them |
| `native/i18n.ts`, `native/style.ts`, `native/rounded.ts` | Locale from the interface language; the converted style sheet and palette tokens; RoundedBoxGeometry |
| `js/rng.js`, `js/rules.js`, `js/content.js`, `js/session.js`, `js/store.js` | The pure game (unchanged from the browser build, shared with the Node tests and `server.js`) |
| `js/i18n.js` | String tables in nine locales (`BLI18n`), account strings included |
| `js/migrate.js` | Engine save document, the browser build's cloud save and settings as the engine client takes them over |
| `assets/ui-style.json` | `tools/ui-style.css` converted by `starhermit css` (`npm run css`) |
| `assets/*.webp`, `sfx/` | Key art and results illustrations; 24 Opus clips and their manifests |
| `index.html`, `starhermit-files.json` | Web loader and file index (`npm run package`; never edited by hand) |
| `score-script.js` | StarHermit platform script: range-checks a finished round's total and posts it to `high-score` |
| `server.js`, `data/` | Local dev server and its JSON stores (not packaged) |
| `tests/` | `run-tests.js` (rules, content, replay, server validators), `migrate.test.js`, `i18n.test.js`, `native.mjs` with `native/*.play` |
| `tools/` | `package-web.mjs`, `css.mjs`, `ui-style.css`, `plan.mjs` (play-script steps from the hint solver), `browser-play.mjs` (headless Chrome play of the loader) |

## 2. Vision and design pillars

Blockstead is about the quiet satisfaction of a tidy stack. The valley is warm, the blocks are chunky, and every placement lands with a material thud. The pressure comes from resources and geometry, never from a clock.

1. **Every block is a decision, not a click.** Timber and stone are scarce, glass needs a footing, lamps and plants end a column for good. Rules in: stock caps, support rules, toppers, immovable rocks, a remove penalty. Rules out: free-form painting, infinite inventory, cosmetic-only blocks.
2. **Gathering costs turns.** Every gather is a move; move-limited rulesets make "go get more" a real trade-off, and par rewards restraint. Rules in: `moves` counting every command, par bonuses, move limits. Rules out: passive income, timers.
3. **Seeds are honest.** Rock layouts, gather yields and endless waves come from one seed; the same seed always gives the same valley, and the replay envelope lets a host replay your log before it believes your score. Rules in: FNV-hashed dailies, envelope verification, deterministic AV pitch variants. Rules out: hidden luck, client-trusted totals.
4. **The plot is the hero.** The camera frames the plot, the HUD stays at the edges, and every reachable column is marked before you commit. Rules in: green target discs, a ghost block with a red/green verdict, a text board that mirrors the 3D plot cell for cell. Rules out: menus over the plot during play, effects that hide legal targets.
5. **Finishable in a lunch break.** Stages are 4×4 to 6×6 with 1–4 goals; the whole journey is 40 stages with six mastery checkpoints. Rules out: grind, energy, unlock walls beyond stars.

## 3. Player experience

**Target player.** Someone who likes small, tactile building puzzles and wants a daily seed to compare with friends, on a phone or a laptop, without reading a manual.

**First 60 seconds.** The title shows key art, one dominant Play button and, one level down, Daily challenge (with a countdown), Journey (with progress) and Profile. Play opens the mode list; Journey opens stage 1 "First Foundation" (4×4, timber and stone in hand, goal "Place Timber 0/3"). Its intro message is pinned in the HUD: "Tap a block in the tray, then tap a plot tile to build. Gather when you run low." Green discs mark every legal column; hovering or focusing shows a translucent ghost block that turns red with an explanation when illegal. The first placement pops the block and thuds; the third completes the goal (chime), then the round ends won and the results overlay explains the score line by line. Learn mode offers six one-rule lessons (`content.js › tutorialLessons`) for players who want them; journey intros introduce each new mechanic at the stage where it first appears (glass at j06, lamp at j11, plant at j14, move limit at j16, lean gathers at j17, rocks at j21).

**Session shape.** Pick a stage or seed → build for a few minutes → results breakdown with stars → Next stage, Retry, or Menu. Backgrounding the window pauses. Leaving mid-round stores a snapshot, so the title's Play button becomes "Resume round" next time.

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

**Journey stars** (`native/main.ts › endRound`): 1 for the win, +1 for `moves ≤ par`, +1 for zero removals.

### Endless waves (`nextWaveGoals`)

On wave `w` (starting at 1): a count goal `2 + w` of a random placeable type; then either a height goal `min(2 + floor(w/2), maxH−1)` (70 %) or a columns goal `h=2, n=min(1+ceil(w/2), cells−2)`; from wave 3, a 50 % chance of a lamp goal `1 + floor(w/3)`. `score.waves` counts completed waves and is shown on results.

### Terminal states and tie-breaks

`terminal.reason ∈ {goals-met, move-limit, landlocked, resigned}`, `won` only for `goals-met`. Leaderboard order (`store.js › sortEntries` and `server.js`): higher score, fewer invalid commands, lower `durationMs`, then `sessionId` string order.

### RNG, hashing, replay

- Master seed per config; `RNG.derive(seed, STREAM_RULES)` drives rocks and gathers, a seed-mixed decor generator in `native/render.ts` drives trees and hills, `STREAM_AV` drives ±6 % pitch variants in `native/audio.ts`. Weather uses tag `0x51ed270b` in `native/main.ts`.
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

Actions are declared in `starhermit.txt` (`control.*`, `engine.gamepad.*`); players rebind keys and pads in the runtime's Options. Names are lowercase (the browser build's `topDown` is `topdown`; a binding a player saved for it is not carried over).

| Input | Action | Feedback |
|---|---|---|
| Tap/click a plot column (≤8 px movement, <600 ms) | Place the selected block, or remove (remove tool on) | `select` cue, block pop, material sound; invalid → guidance line reason, `invalid` cue, 30 ms vibration |
| Drag on the plot (>8 px, mouse or finger) | Orbit the camera (θ free, φ 0.55–1.35) | Camera spring follows; no pick fires |
| Mouse wheel | Zoom (½–2× the fitted distance) | — |
| Mouse hover | Ghost block on the hovered column, green or red | Reason for red |
| Tray swatch button / `1`–`5` / `[` `]` / pad shoulders | Select block type | Selected state, `select` cue, targets re-marked |
| `G` / Gather / pad West | Gather | `gather` cue, "Gathered 2 Timber, 1 Stone" |
| `R` / Remove / pad East | Toggle remove tool | `select`/`deselect`, targets become removable tops |
| `U` / Undo / pad North | Undo | `undo` cue; disabled when nothing to undo or the ruleset forbids |
| `H` / Hint / pad Select | Hint | `hint` cue, "Hint: place Timber on column 2, 3.", block auto-selected, ghost shown |
| `S` / Skip / pad Right trigger | Settle animations | "Animations skipped" |
| `C` / Fit / right stick press; `T` / Top / left stick press | Reset framing; top-down view | — |
| `←`/`↑`, `→`/`↓`, pad D-pad | Cycle the target cursor through legal tiles (row by row) | Ghost moves; announced "Target column x, y" |
| `Enter` / `Space` / pad South | Commit the cursor's tile | As tap |
| `P` / `Esc` / Pause / pad Start | Pause / resume (Esc over Settings or Help returns to the pause menu) | `pause` / `resume` cues |
| `Esc` outside a round | Back one screen (results: to the title) | — |

**Confirm moves** (settings): the first tap on a column shows the ghost and "Tap again to confirm"; the second tap on the same column commits.

**Input locking.** Commands are accepted only while the round is active and no screen is open; every overlay pauses the round. The round clock counts the runtime's fixed steps (60 a second) only while active.

**Text board.** "Always show text board" shows a grid of 44 px buttons above the tray, one per column ("Column x, y: Timber, Glass, legal target"; the face shows the top block and height, legal targets ringed green); it accepts the same taps.

## 7. Screens and UI flow

`main.ts` keeps a screen stack: `title` resets it; modes, setup, journey, learn, profile and scores push; pause, results, settings and help are overlays over the paused or finished round; an empty stack is play (HUD only).

| Screen | Contents |
|---|---|
| Title | Key art, name, tagline, Play / Resume round (a round saved on the device), Daily (countdown to the next UTC day), Journey (n/40), Profile, How to play, Settings, Scores, Invite a friend / Sign in with StarHermit, account line |
| Modes | Six card buttons (name, description, ranked meta) |
| Setup | Name, intro, facts, ranked note, difficulty / challenge picker, Start, Back |
| Journey | Stars total, 40-cell grid (number, name, ★☆☆, — when locked), mastery cells outlined gold |
| Learn | Six lesson cards, ✓ when done |
| Game (HUD) | Top bar: Pause, stage name, clock, ★ score, moves; goals card; block tray (colour swatch, name, stock) with Gather and Remove; actions tray (Undo, Hint, Skip, Fit, Top); guidance line; lesson banner with Exit lesson |
| Pause | Resume, Settings, Help, Restart round, Leave round |
| Results | Title, win or loss illustration (hidden under 640 px tall), headline, 8-row breakdown, stars, new achievements, time and par, leaderboard line when signed in, Next (journey) / Retry / Menu |
| Settings | Audio: captions; Graphics: colour palette; Controls & access: left-handed, haptics, text board, confirm moves; "Sound, graphics, language and controls…" opens the runtime's Options |
| Help | Nine rule cards with the current key bindings and the gamepad line |
| Profile | Name, connection note, 8 stats, achievements, theme picker (locked themes show their star cost), Erase local progress with an inline Erase everything / Cancel |
| Scores | Endless (global) / Today's daily tabs; device-local table with player names |

**Layouts (`screens.ts`, by the window's logical size).** Wide ≥1024 px: goals rail top-left (≤300 px), actions column top-right, tray bottom-centre. Compact 640–1023 px: goals top-right (≤260 px, scrolling at 40 %), actions column bottom-right below the goals, tray bottom-centre. Portrait phone <640 px: goals as a wrapped chip row under the top bar, the tray over the actions row at the bottom, buttons in even columns. Landscape phone (≤540 px tall, ≤959 px wide): goals rail left, actions column right, tray bottom-centre. Left-handed mirrors the actions column and the tray. Screens are centred panels that scroll when taller than the window. The valley is fitted into the rectangle the HUD leaves and centred there with the camera's view offset. The runtime's interface and text size options scale everything.

## 8. Art direction

**World.** A toy-scale voxel valley: a square soil plot on a green disc, low-poly cone pines, a round pond, six distant hills, a sun with soft shadows. The title screen shows a small finished homestead (6×6 showcase plot) slowly turning behind the menu. Blocks are 0.92-unit cubes; plants get a leaf cap, lamps an emissive body with a dark cap, rocks are slightly scaled and rotated per cell. Hero of the screen: the plot and its stacks, framed by an authored camera (`FRAMING` θ 0.65, φ 0.95, distance 11 + 0.6 × plot size).

**Palette.**

| Role | Value |
|---|---|
| Page background / text | `#0b1420` / `#eef2f6`; high contrast `#000` / `#fff` |
| Panels, HUD | `#101c2ae8`, HUD `rgba(10,18,28,.78)`; on High/Ultra `rgba(10,18,28,.62)` with 6 px backdrop blur |
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

**Typography.** The runtime's system UI face, 16 px base (the runtime's text size option scales it), headings 2.1 em (1.5 em under 640 px), title 4 em (2.4 em on phones).

**Motion.** Camera uses an exponential spring (`1 − e^(−7·dt)`), interruptible, with a 6-unit intro swoop; placement is a 0.25 s scale pop on the new block; rain is a particle field that fades in over the weather change. Weather advances every 40 s of play through a seeded 6-entry order of sun/sun/cloud/rain (sun always first); cloud dims the sun to 70 %, rain to 45 % and lifts the fog blend. The title showcase turns slowly. **Reduced motion** (the runtime's accessibility option): camera snaps, no pops, no swoop, scenery and rain still.

**Graphics.** ACES filmic tone mapping (exposure 1.05), a hemisphere fill and a sun with the engine's view-based soft shadow (light intensities three.js's ÷ π). The runtime's graphics level (Options › Graphics, Auto by default) picks the quality tier (`frame().quality`) and level; `native/quality.ts` maps them to the browser build's presets:

| Tier | Shadows | AO | Bloom / grade | AA | Reflections | Detail | Particles | Scenery motion |
|---|---|---|---|---|---|---|---|---|
| Low | off | off | off | MSAA | off | plain boxes, 5 trees, no sky dome | off | still |
| Balanced | 1024 | off | on | FXAA | RoomEnvironment | rounded textured blocks, 14 trees, flowers, pebbles, pond rim and ripples, sky dome, clouds | low (40 % rain) | animated |
| High | 2048 | on | on | SMAA | on | as Balanced | high, motes | animated |
| Ultra | 4096 | high | on | MSAA | on | as Balanced | high, motes | animated |

Budgets per tier as the browser build tuned them for 60 FPS: clearcoat (High, Ultra), bevel segments 1/2/2/4, texture 64/128/128/256 px, rain 600/1000/1600/3200 and motes 0/30/60/120 (scaled up to 2× by the level within the tier), clouds 3/5/7/10, bloom at ½/½/¾/full resolution. The runtime owns render scale, adaptive resolution, the frame-rate limit and its readout. Bloom (threshold 0.95) catches lamps and glints; the grade is the browser build's S-curve, saturation 1.1, cool shadows / warm highlights and a 0.2 vignette (none in high visibility). The frosted-glass HUD of High/Ultra is not ported (panels keep their backing).

**Visual assets.** Title key art (`assets/key-art.webp`, also `coverart.png`), win and loss illustrations (`assets/results-*.webp`), `icon.png`. All 3D geometry is procedural.

## 9. Audio direction

**Mix.** The runtime's buses: music (the pad), effects (one-shots, wind, birds), interface (the menu tick); Options › Audio owns the volumes, mute and the voice limit. The browser build's default levels (music 0.55, effects 0.9, ambience 0.5) are folded into each sound's gain. Clips load once the mixer runs (natively at once, in browsers after the first press). Pause silences the beds.

**Ambience and music.** Wind is 4 s of brown noise low-passed at 300 Hz (fair) and 700 Hz (rain), rendered into looping clips at 0.3 / 0.4 / 0.55 for sun / cloud / rain and crossfaded on a weather change; 2–4-note bird chirps (rendered clips, pitch-varied) every 3–10 s except in rain. Music is the generative pad rendered into four chord clips: C–Am–F–G triads an octave down, triangle root plus sines, 650 Hz low-pass, 2 s swell / 6.8 s release, a new chord every 5.6 s. Placement, gather and removal takes vary ±6 % in pitch from the seeded AV stream.

**Captions.** With "Captions for sounds" on, each event's caption ("timber placed", "goal complete", "rain begins"…) shows for 1.6 s above the tray.

### SFX event table (source of `sfx/manifest.txt`)

| Event id | File | Sound | Used when |
|---|---|---|---|
| `ui` | `ui.opus` | Dry plastic button tick | Any menu button (menus, pause, results, settings) |
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

Nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT (`js/i18n.js`). The locale follows the runtime's interface language (Options › Language, else the account's preferred language, else the device's), matched by `native/i18n.ts` (en-GB, es-ES, fr-CA by region); every screen re-reads its strings each frame, so a change applies at once. Content keeps English names as data and is named at display time (`cfgName`, `cfgIntro`, `lessonView`, `achievementView`, `themeName`). `tests/i18n.test.js` checks that every key the client uses exists in every locale with the same placeholders.

## 11. Accessibility

- Every control is a `starhermit:ui` widget: focus order, keyboard/gamepad navigation, focus ring, screen-reader names; announcements for round start, goals, targets, selection, achievements and results.
- The runtime's options: interface and text size, high contrast (black panels, white ink, cyan focus; high-visibility block colours, no textures, no vignette), reduced motion.
- The game's: captions for sounds, colour palette (high visibility), left-handed layout, haptics (vibration on actions, also subject to the runtime's vibration setting), the text board, confirm moves.
- Shapes reinforce colour: plants and lamps carry caps; the tray shows names and counts beside the swatches.
- All 44 px+ touch targets.

## 12. StarHermit integration

**Used**
- `starhermit:storage` `saves`: progress `{ v: 1, progress }` on the device and in the player's cloud slot; conflicts merged with `BSStore.mergeDocs` (better records, union of unlocks, this device's funnel counters).
- The browser build's cloud save (slot `game:blockstead`, the SDK's checksummed `{ sum, payload }`) shows as foreign: its progress is merged in, its game settings kept where the account has none, and it is replaced once (`saves.foreign()` + `replaceForeign`).
- `starhermit:storage` `settings`: the game's own options (`captions`, `theme`, `colorPalette`, `leftHanded`, `haptics`, `boardMirror`, `confirmMoves`); the browser build's per-player keys are imported where still meaningful and removed (volumes, graphics, reduced motion, contrast, large text and language are the runtime's now).
- Device storage: the local score boards (`blockstead.leaderboards.v1`) and the round in progress (`blockstead.round.v1`, resumed from the title's Play).
- `starhermit:platform`: player and display name, profile names for board rows, sign-in request, invite link (copied with the clipboard capability), session-ended notice, and the high-score post: a practice session whose socket sends `{ type: 'result', scores: { 'high-score': total } }` to `score-script.js`, then the player's rank from the board.

**Not used**
- No avatar, presence or friends features; journey and challenge boards are local only.

## 13. Technical architecture

The package is a script game: `native/main.ts` runs on the engine (natively and in browsers' web runtime), loads the shared classic scripts through `loadClassic`, and drives the round on fixed steps (60/s). Rules state is immutable per command (`Session.execute` → `Rules.applyCommand`), with the replay envelope and periodic hashes as before; `server.js` verifies envelopes with the same code. `render.ts` consumes snapshots and never mutates rules state. Daily seeds use the device's UTC date (the browser build's `/api/v1/time` offset is not available on the runtime).

## 14. Testing and acceptance criteria

`npm test` runs:
- `tests/run-tests.js`: legality, invalid reasons, scoring, terminals, serialization, deterministic replay, fuzz, content validation and greedy solvability, server envelope verification.
- `node --test tests/migrate.test.js tests/i18n.test.js`: foreign-save and settings migration, progress merge; strings in nine locales.
- `tests/native.mjs`: web index matches the files, `tsc` (strict, the runtime's d.ts), `starhermit check .` with zero warnings, then each `tests/native/*.play` as a signed-out `--render-check`: `journey-stage` (stage 1 built by keyboard to results, next stage, pause, leave), `learn-lessons` (lesson 1 by Gather, lesson 3 to results), `modes-setup` (daily, a picked challenge, score chase), `practice-tools` (gather, place, undo, remove, hint, camera keys, skip, pause › settings / help, restart, leave, profile, scores). Build steps come from `npm run plan -- <stage>`.

`npm run test:browser` (`tools/browser-play.mjs`) serves the packaged folder on loopback and plays the loader in headless Chrome at desktop, phone and phone-landscape viewports by keys and taps, failing on console errors or the runtime's error screen.

## 15. Asset inventory

| Asset | Purpose | Source |
|---|---|---|
| `assets/key-art.webp`, `assets/results-win.webp`, `assets/results-lose.webp` | Title and results illustrations | FLUX.2 klein |
| `coverart.png`, `cover.jpg`, `icon.png` | Platform cover and icon | key art crops; hand-authored icon |
| `sfx/*.opus` (24), `sfx/manifest.*` | Event cues, see §9 | MOSS-SoundEffect v2.0 |
| `assets/ui-style.json` | UI styles | converted from `tools/ui-style.css` |
| 3D models | none; all geometry procedural in `native/render.ts` | — |

## 16. Known limitations

- On the web runtime, package images in `starhermit:ui` beside a scene may not draw (an engine issue reported by the bearing-board port): the key art and results illustrations then leave a green backing or nothing; natively they draw.
- The tool buttons show text labels: the browser build's emoji icons are not in the runtime's fonts.
- A guest's browser-build progress in browser localStorage cannot migrate (only cloud saves do).
- Leaderboards: the StarHermit `high-score` board plus device-local boards; the Scores screen shows only the `global` and today's `daily` local boards.
- Landlock can only occur when removal is impossible; with the remove tool on, score chase effectively ends by resignation.
- The greedy hint in score chase can cycle — it is a suggestion, not a solver.
- The daily date is the device's UTC date.
- Camera orbit and zoom are pointer/touch only; keyboard and pad users get the reset and top-down framings.

## Design intent not yet implemented

- StarHermit avatar on the profile screen, presence and activity pairing.
- Friends-filtered leaderboards and a shareable seed link for dailies and challenges.
- Journey and challenge board tabs on the Scores screen.
- Keyboard camera orbit (e.g. `Q`/`E`, `+`/`−`).
