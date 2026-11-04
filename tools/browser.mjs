// Shared bits for the Playwright tools: a Chromium that exists on this machine, and a page
// server on port 5183 (the vite dev server for source pages, a static server for dist).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = 5183;

/**
 * Playwright's own Chromium if it is installed, else the newest one in the Playwright
 * cache, else the system Chrome. GPU flags keep WebGL off the software rasteriser where
 * the driver allows it.
 */
export async function launch() {
  const args = ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--enable-unsafe-swiftshader'];
  try {
    return await chromium.launch({ args });
  } catch {
    const cache = join(homedir(), 'Library/Caches/ms-playwright');
    const builds = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
    for (const b of builds) {
      const exe = join(cache, b, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (existsSync(exe)) return chromium.launch({ args, executablePath: exe });
    }
    return chromium.launch({ args, channel: 'chrome' });
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };

/** Serves a directory as static files. Resolves to { url, close }. */
export function serveDir(dir) {
  const server = createServer((req, res) => {
    const path = join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!path.startsWith(dir) || !existsSync(path)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path));
  });
  return new Promise((ok) => server.listen(PORT, () => ok({ url: `http://localhost:${PORT}`, close: () => server.close() })));
}

/** Starts the vite dev server on PORT and waits until it answers. Resolves to { url, close }. */
export async function serveVite() {
  const proc = spawn(join(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
  const url = `http://localhost:${PORT}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).status) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { url, close: () => proc.kill() };
}

export function argv() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') || i + 1 >= process.argv.length ? true : process.argv[++i];
  }
  return args;
}
