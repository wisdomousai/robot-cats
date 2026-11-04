import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Every html page at the root that exists is an entry: the showcase (index.html) and the
// geometry gallery (gallery.html).
const pages = ['index.html', 'gallery.html'].filter((f) => existsSync(resolve(import.meta.dirname, f)));

export default defineConfig({
  server: { port: 5174, open: false },
  build: { target: 'es2022' },
  input: Object.fromEntries(pages.map((f) => [f.replace(/\.html$/, ''), resolve(import.meta.dirname, f)])),
});
