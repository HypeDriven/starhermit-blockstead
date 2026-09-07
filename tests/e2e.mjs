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
      res.writeHead(404).end('not found'); // includes /api/* → game takes its offline path
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
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    // The game probes the optional host API at boot; offline it 404s and the
    // game falls back to its documented local-guest path. Benign here.
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && new URL(url).pathname.startsWith('/api/')) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !new URL(r.url()).pathname.startsWith('/api/')) {
      errors.push(`http ${r.status()}: ${r.url()}`);
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
    args: ['--no-sandbox', '--enable-unsafe-swiftshader']
  });
  console.log(`serving ${ROOT} at ${baseURL}`);
  await runPass(browser, baseURL, 'desktop', { viewport: { width: 1280, height: 800 } });
  await runPass(browser, baseURL, 'mobile', {
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true
  });
  console.log('\nE2E PASS — blockstead playable end-to-end on desktop + mobile, no page errors');
} catch (e) {
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
