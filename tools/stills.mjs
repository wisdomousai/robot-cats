// One screenshot per tour beat. Opens the showcase with ?debug, takes the beats from
// window.__film.script, seeks into each beat and writes shots/NN-name.png at 1600x900.
//
//   node tools/stills.mjs [--dist] [--out shots] [--only knock,whiskers] [--at 0.6] [--offset s]
//
// Serves the source through the vite dev server, or dist/cats.html with --dist. Each shot
// is taken `--at` of the way through its beat's hold (0.6 by default), so the callout and
// the demo have had time to play; `--offset s` takes it s seconds after the beat fires
// instead. `--only` keeps the beats whose names contain one of the comma-separated words.
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, launch, root, serveDir, serveVite } from './browser.mjs';

const args = argv();
const frac = Number(args.at ?? 0.6);
const offset = args.offset === undefined ? null : Number(args.offset);
const only = typeof args.only === 'string' ? args.only.split(',') : null;
const useDist = Boolean(args.dist);
if (useDist && !existsSync(resolve(root, 'dist/cats.html'))) throw new Error('dist/cats.html is missing. Run npm run build first.');
const server = useDist ? await serveDir(resolve(root, 'dist')) : await serveVite();
const path = useDist ? 'cats.html' : 'index.html';
const out = resolve(root, typeof args.out === 'string' ? args.out : 'shots');
mkdirSync(out, { recursive: true });

const browser = await launch();
try {
  const tab = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  tab.on('pageerror', (e) => console.error('page error:', e.message));
  await tab.goto(`${server.url}/${path}?debug`);
  try {
    await tab.waitForFunction(() => window.__film && Array.isArray(window.__film.script), null, { timeout: 60000 });
  } catch {
    throw new Error(`window.__film is missing on ${path}?debug. The page must call exposeFilm(player) from src/showcase/film.ts.`);
  }
  // The canvas fades in once the shaders are warm; shots before that are blank.
  await tab.waitForFunction(() => getComputedStyle(document.getElementById('stage')).opacity === '1', null, { timeout: 60000 });
  const beats = await tab.evaluate(() => window.__film.script.map((b) => ({ name: b.name, at: b.time, hold: b.hold })));
  await tab.evaluate(() => window.__film.stop());
  for (const [i, beat] of beats.entries()) {
    if (only && !only.some((w) => beat.name.includes(w))) continue;
    const t = beat.at + (offset ?? beat.hold * frac);
    await tab.evaluate((t) => window.__film.renderAt(t), t);
    const file = `${String(i + 1).padStart(2, '0')}-${beat.name.replace(/[^\w-]+/g, '-')}.png`;
    await tab.screenshot({ path: resolve(out, file) });
    console.log(`stills: ${file} at ${t.toFixed(1)} s`);
  }
} finally {
  await browser.close();
  server.close();
}
