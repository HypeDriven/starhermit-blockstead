// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics
// (and turns on "Always show text board" so blocks can be placed through its visible cell buttons),
// starts Journey stage 1 and keeps building from the Hint button's advice, continuing to the next
// stage after each win — blocks drop in, the village grows, weather and ambient motion run.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

const screen = (page) => page.getAttribute('#app', 'data-screen');

export async function setPreset(page, preset) {
  await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'title');
  if (await page.locator('#webgl-fallback:not(.hidden)').count()) await page.click('#webgl-continue');
  await page.click('#btn-settings');
  await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'settings');
  await page.locator('#settings-form label', { hasText: 'Always show text board' }).locator('input').check();
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.getAttribute('data-gfx-preset') === p || document.body.dataset.gfxPreset === p, preset, { timeout: 5000 }).catch(() => {});
  await page.click('.screen[data-name="settings"] button[data-back]');
  await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'title');
}

export async function start(page) {
  await page.click('#btn-journey');
  await page.locator('.level-cell:not(.locked)').first().click();
  await page.waitForFunction(() => document.getElementById('app').getAttribute('data-screen') === 'game');
  let stopped = false;
  page.once('close', () => { stopped = true; });
  (async () => {
    while (!stopped) {
      try {
        const s = await screen(page);
        if (s === 'results') {
          if (await page.locator('#btn-results-next:visible').count()) await page.click('#btn-results-next');
          else await page.click('#btn-results-retry');
        } else if (s === 'game') {
          await page.click('#btn-hint');
          const msg = (await page.textContent('#hud-message')) || '';
          const m = msg.match(/column (\d+), (\d+)/i);
          if (/gather/i.test(msg)) await page.click('#btn-gather');
          else if (m) await page.click(`#mirror-plot .mirror-cell[aria-label^="Column ${m[1]}, ${m[2]}:"]`);
        }
      } catch { /* screen changing */ }
      await new Promise((r) => setTimeout(r, 300));
    }
  })();
  await page.waitForTimeout(500);
}
