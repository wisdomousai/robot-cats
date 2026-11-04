// Runs a page for 30 s in Chromium with ?debug and reads window.__perf (one fps sample per
// second, see src/showcase/quality.ts). Prints p50 and p5 fps and the final tier; exits 1
// if p5 is below 30 while the page has already stepped down to tier 3.
//
//   node tools/fps.mjs [--page index.html | --dist] [--seconds 30]
//
// The default page is index.html once src/showcase/main.ts exists, stage.html before.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, launch, root, serveDir, serveVite } from './browser.mjs';

const args = argv();
const seconds = Number(args.seconds ?? 30);
const page = args.page ?? (existsSync(resolve(root, 'src/showcase/main.ts')) ? 'index.html' : 'stage.html');
const server = args.dist ? await serveDir(resolve(root, 'dist')) : await serveVite();
const path = args.dist ? 'cats.html' : page;
const browser = await launch();
try {
  const tab = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await tab.goto(`${server.url}/${path}?debug`);
  await tab.waitForFunction(() => window.__perf, null, { timeout: 20000 });
  await tab.waitForTimeout(seconds * 1000);
  const perf = await tab.evaluate(() => window.__perf);
  // The first two seconds include shader compiles and the fade-in.
  const samples = perf.samples.filter((s) => s.t > 2);
  if (!samples.length) throw new Error('no fps samples in window.__perf');
  const pct = (xs, p) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  };
  const tier = samples[samples.length - 1].tier;
  const atTier = samples.filter((s) => s.tier === tier).map((s) => s.fps);
  const p50 = pct(samples.map((s) => s.fps), 50);
  const p5 = pct(atTier, 5);
  console.log(`fps: ${path}, ${samples.length} s sampled on ${perf.gpu}`);
  console.log(`  p50 ${p50.toFixed(1)}, p5 ${p5.toFixed(1)} at final tier ${tier}; tier changes ${perf.tiers.map((c) => `${c.from}->${c.to} at ${c.t.toFixed(0)} s`).join(', ') || 'none'}`);
  if (tier === 3 && p5 < 30) {
    console.error('fps: p5 below 30 at tier 3');
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  server.close();
}
