/**
 * Blockstead — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → settings (enable text board + reduced motion) → journey →
 *   stage 1 played to a win with hint-driven moves on the visible board
 *   mirror → results with score breakdown → next stage → pause/resume →
 *   settings from pause → leave → title.
 *
 * Runs twice: desktop 1280x800 and a fresh mobile 390x844 touch context.
 *
 * Self-contained: embeds a minimal static server on an ephemeral port.
 * The repo's server.js is the StarHermit authoritative server and is NOT
 * used here; the game is fully playable offline (host API absent → local
 * guest profile path), and this test exercises that offline path.
 *
 * Run: npm run test:e2e
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { stubStarHermit, launchToken } from './starhermit-e2e.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/blockstead-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.ts': 'text/typescript',
  '.txt': 'text/plain; charset=utf-8'
};

function startServer() {
  const server = http.createServer((req, res) => {
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch (e) {
      res.writeHead(400).end('bad request');
      return;
    }
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const screen = (page) => page.getAttribute('#app', 'data-screen');

async function runPass(browser, baseURL, vpName, contextOpts) {
  const context = await browser.newContext(contextOpts);
  context.setDefaultTimeout(12000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() !== 'error' && m.type() !== 'warning') || browserNoise.test(m.text())) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`);
  });
  // Standalone (no launch token): no same-origin /api or /ws request at all.
  page.on('request', (r) => {
    if (r.headers().authorization) return; // the signed-in Language step talks to the stubbed StarHermit API
    const u = new URL(r.url());
    if (u.origin === baseURL.replace(/\/$/, '') && /^\/(api|ws)(\/|$)/.test(u.pathname)) {
      errors.push(`own-server request while standalone: ${u.pathname}`);
    }
  });

  const step = async (name, fn) => {
    await fn();
    console.log(`ok - [${vpName}] ${name}`);
  };

  try {
    await step('load + title visible', async () => {
      await page.goto(baseURL, { waitUntil: 'load' });
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'title');
      if (await page.locator('#webgl-fallback:not(.hidden)').count()) {
        await page.click('#webgl-continue');
      }
      await page.locator('#btn-play:visible').waitFor();
      await page.screenshot({ path: SHOT('title', vpName) });
    });

    await step('settings: enable text board + reduced motion', async () => {
      await page.click('#btn-settings');
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'settings');
      const mirror = page.locator('#settings-form label', { hasText: 'Always show text board' }).locator('input');
      await mirror.check();
      const motion = page.locator('#settings-form label', { hasText: 'Reduced motion' }).locator('input');
      await motion.check();
      const applied = await page.evaluate(() => ({
        mirror: !!JSON.parse(JSON.parse(localStorage.getItem('blockstead.save.v1')).payload).settings.boardMirror,
        reduced: document.body.classList.contains('reduced-motion')
      }));
      if (!applied.mirror || !applied.reduced) throw new Error('settings not applied: ' + JSON.stringify(applied));
      await page.screenshot({ path: SHOT('settings', vpName) });
      await page.click('.screen[data-name="settings"] button[data-back]');
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'title');
    });

    await step('graphics: presets, override, persists across reload', async () => {
      const gfxPreset = () => page.evaluate(() => document.body.getAttribute('data-gfx-preset'));
      const savedGfx = () => page.evaluate(() =>
        JSON.parse(JSON.parse(localStorage.getItem('blockstead.save.v1')).payload).settings.gfx);
      await page.click('#btn-settings');
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'settings');
      await page.locator('#settings-graphics #gfx-preset').waitFor();
      // headless = software GPU, so Auto resolves to Low
      const autoLabel = await page.locator('#gfx-preset option[value="auto"]').textContent();
      if (!/low/i.test(autoLabel)) throw new Error('auto label does not show detected tier: ' + autoLabel);
      await page.selectOption('#gfx-preset', 'low');
      if ((await gfxPreset()) !== 'low') throw new Error('Low preset not applied');
      await page.selectOption('#gfx-preset', 'high');
      if ((await gfxPreset()) !== 'high') throw new Error('High preset not applied');
      await page.waitForFunction(() => /2048² shadows/.test(document.getElementById('gfx-summary').textContent));
      await page.selectOption('#gfx-bloom', 'off');
      await page.locator('#gfx-fps').check();
      await page.locator('#fps-meter').waitFor();
      let g = await savedGfx();
      if (g.preset !== 'high' || g.bloom !== 'off' || !g.show_fps) throw new Error('gfx not saved: ' + JSON.stringify(g));
      await page.screenshot({ path: SHOT('graphics', vpName) });
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'title');
      if ((await gfxPreset()) !== 'high') throw new Error('preset lost on reload');
      await page.click('#btn-settings');
      await page.locator('#gfx-preset').waitFor();
      if ((await page.inputValue('#gfx-preset')) !== 'high') throw new Error('preset select not restored');
      if ((await page.inputValue('#gfx-bloom')) !== 'off') throw new Error('override not restored');
      // choosing a preset clears overrides; back to Auto keeps the rest of the run fast
      await page.selectOption('#gfx-preset', 'auto');
      await page.locator('#gfx-fps').uncheck();
      g = await savedGfx();
      if (g.preset !== 'auto' || 'bloom' in g) throw new Error('preset did not clear overrides: ' + JSON.stringify(g));
      if ((await gfxPreset()) !== 'low') throw new Error('Auto did not resolve to Low on a software GPU');
      await page.click('.screen[data-name="settings"] button[data-back]');
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'title');
    });

    await step('journey grid: 40 stages, stage 1 unlocked', async () => {
      await page.click('#btn-journey');
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'journey');
      const cells = await page.locator('.level-cell').count();
      if (cells !== 40) throw new Error(`expected 40 stages, got ${cells}`);
      const unlocked = await page.locator('.level-cell:not(.locked)').count();
      if (unlocked !== 1) throw new Error(`expected 1 unlocked stage, got ${unlocked}`);
      await page.screenshot({ path: SHOT('journey', vpName) });
    });

    await step('stage 1 starts: HUD, goals, text board visible', async () => {
      await page.locator('.level-cell:not(.locked)').first().click();
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'game');
      await page.locator('#hud-top:not(.hidden)').waitFor();
      await page.locator('#board-mirror:not(.hidden)').waitFor();
      const goals = await page.locator('#goals-list li').count();
      if (goals < 1) throw new Error('no goals shown');
      const cells = await page.locator('#mirror-plot .mirror-cell').count();
      if (cells !== 16) throw new Error(`expected 16 mirror cells (4x4 plot), got ${cells}`);
      await page.screenshot({ path: SHOT('play', vpName) });
    });

    await step('play stage 1 to a win (hint button → visible board cells)', async () => {
      // Each loop: press the on-screen Hint button, read the hint it prints
      // to the HUD message line, then act on it through visible controls.
      let shotTaken = false;
      for (let i = 0; i < 120; i++) {
        if ((await screen(page)) === 'results') return;
        await page.click('#btn-hint');
        const msg = (await page.textContent('#hud-message')) || '';
        if (/gather/i.test(msg)) {
          await page.click('#btn-gather');
        } else {
          const m = msg.match(/column (\d+), (\d+)/i);
          if (!m) throw new Error('unparseable hint message: ' + JSON.stringify(msg));
          // Hint also selected the right block in the tray; click the cell.
          await page.click(`#mirror-plot .mirror-cell[aria-label^="Column ${m[1]}, ${m[2]}:"]`);
          if (!shotTaken) {
            shotTaken = true;
            await page.screenshot({ path: SHOT('midplay', vpName) });
          }
        }
        await page.waitForTimeout(120);
      }
      throw new Error('stage 1 did not reach results within 120 actions');
    });

    await step('results screen: breakdown + win headline', async () => {
      await page.locator('.screen[data-name="results"].active').waitFor();
      const rows = await page.locator('#results-table tbody tr').count();
      if (rows < 5) throw new Error(`expected score breakdown rows, got ${rows}`);
      const headline = (await page.textContent('#results-headline')) || '';
      console.log('  headline:', headline);
      if (!/every goal met/i.test(headline)) throw new Error('stage 1 was not won: ' + headline);
      const stars = (await page.textContent('#results-stars')) || '';
      if (!stars.includes('★')) throw new Error('no stars earned on a win');
      await page.screenshot({ path: SHOT('results', vpName) });
    });

    await step('progression persisted (journey star for j01)', async () => {
      const doc = await page.evaluate(() =>
        JSON.parse(JSON.parse(localStorage.getItem('blockstead.save.v1')).payload));
      if (!doc.progress.journeyStars.j01) throw new Error('journeyStars.j01 not persisted');
      if (!doc.progress.stats.rounds) throw new Error('stats.rounds not persisted');
      console.log('  journeyStars:', JSON.stringify(doc.progress.journeyStars),
        'rounds:', doc.progress.stats.rounds);
    });

    await step('next stage → pause → resume', async () => {
      await page.click('#btn-results-next');
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'game');
      await page.locator('#hud-top:not(.hidden)').waitFor();
      await page.keyboard.press('p');
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'pause');
      await page.screenshot({ path: SHOT('pause', vpName) });
      await page.click('#btn-resume');
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'game');
    });

    await step('settings open/close from pause, then leave to title', async () => {
      await page.click('#btn-pause');
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'pause');
      await page.click('#btn-pause-settings');
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'settings');
      await page.locator('#settings-form input').first().waitFor();
      await page.click('.screen[data-name="settings"] button[data-back]');
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'pause');
      await page.click('#btn-leave');
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'title');
      await page.locator('#btn-play:visible').waitFor();
      await page.screenshot({ path: SHOT('back-to-title', vpName) });
    });

    await step('Language: Automatic follows the StarHermit preferred language; Settings → Language re-renders a paused round live and saves ui.language; report a problem', async () => {
      const calls = await stubStarHermit(page, { preferredLanguage: 'fr-CA' });
      await page.goto('about:blank');
      await page.goto(`${baseURL}#game_token=${launchToken()}`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.lang === 'fr-CA' &&
        document.getElementById('app').getAttribute('data-screen') === 'title');
      if ((await page.textContent('#btn-journey [data-i18n]')) !== 'Parcours') throw new Error('title not in fr-CA');
      await page.click('#btn-journey');
      await page.locator('.level-cell:not(.locked)').first().click();
      await page.locator('#hud-top:not(.hidden)').waitFor();
      if ((await page.textContent('#hud-goals h2')) !== 'Objectifs') throw new Error('HUD not in fr-CA');
      await page.click('#btn-gather');
      await page.waitForTimeout(200);
      const hudState = () => page.evaluate(() => [
        document.getElementById('hud-moves').textContent, document.getElementById('goals-list').textContent,
        [...document.querySelectorAll('#palette-blocks .btn-sub')].map((b) => b.textContent).join('|')
      ].join(' / ').replace(/[^\d/|×]/g, ''));
      const before = await hudState();
      await page.click('#btn-pause');
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'pause');
      await page.click('#btn-pause-settings');
      const choice = page.locator('#settings-graphics [data-game-language="choice"]');
      await choice.waitFor({ state: 'attached' });
      await choice.scrollIntoViewIfNeeded();
      const autoLabel = await choice.locator('option').first().textContent();
      if (!/^Automatique — Français \(Canada\)$/.test(autoLabel)) throw new Error('Automatic label not resolved: ' + autoLabel);
      await choice.selectOption('it-IT');
      await page.waitForFunction(() => document.documentElement.lang === 'it-IT');
      await page.waitForFunction(() => /Salvato/.test(document.querySelector('[data-game-language="status"]').textContent));
      if (calls.settings['ui.language']?.choice !== 'it-IT') throw new Error('ui.language not saved: ' + JSON.stringify(calls.settings));
      if ((await page.textContent('#settings-h')) !== 'Impostazioni') throw new Error('settings heading not re-rendered');
      if ((await page.textContent('#settings-form label span')) !== 'Musica') throw new Error('settings rows not re-rendered');
      if ((await page.textContent('#settings-graphics .gfx-label')) !== 'Qualità') throw new Error('graphics panel not re-rendered');
      if ((await choice.inputValue()) !== 'it-IT') throw new Error('language control lost its value');
      await page.locator('[data-game-report="title"]').scrollIntoViewIfNeeded();
      await page.fill('[data-game-report="title"]', 'Test report');
      await page.click('[data-game-report="send"]');
      await page.waitForFunction(() => /Grazie/.test(document.querySelector('[data-game-report="status"]').textContent));
      if (!calls.reports?.[0] || calls.reports[0].kind !== 'bug') throw new Error('report not posted');
      await page.screenshot({ path: SHOT('language', vpName) });
      await page.click('.screen[data-name="settings"] button[data-back]');
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'pause');
      if ((await page.textContent('#pause-h')) !== 'In pausa') throw new Error('pause screen not re-rendered');
      if ((await page.textContent('#hud-goals h2')) !== 'Obiettivi') throw new Error('HUD not re-rendered');
      if (!/^Mosse/.test(await page.textContent('#hud-moves'))) throw new Error('moves line not re-rendered');
      if (!/^Legno/.test(await page.textContent('#palette-blocks .btn-sub'))) throw new Error('tray not re-rendered');
      const after = await hudState();
      if (before !== after) throw new Error(`round state changed across the language change: ${before} → ${after}`);
      await page.click('#btn-pause-settings');
      await choice.selectOption('auto');
      await page.waitForFunction(() => document.documentElement.lang === 'fr-CA');
      await page.click('.screen[data-name="settings"] button[data-back]');
      await page.click('#btn-leave');
      await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'title');
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.goto('about:blank');
    });
  } finally {
    await context.close();
  }

  if (errors.length) {
    throw new Error(`[${vpName}] page errors:\n` + errors.join('\n'));
  }
}

const { server, port } = await startServer();
const baseURL = `http://127.0.0.1:${port}/`;
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
    // Headless needs no display; a busy WSLg Wayland socket can otherwise stall the GPU process.
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'WAYLAND_DISPLAY' && k !== 'DISPLAY'))
  });
  console.log(`serving ${ROOT} at ${baseURL}`);
  await runPass(browser, baseURL, 'desktop', { viewport: { width: 1280, height: 800 }, locale: 'en-US' });
  await runPass(browser, baseURL, 'mobile', {
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US'
  });
  console.log('\nE2E PASS — blockstead playable end-to-end on desktop + mobile, no page errors');
} catch (e) {
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
