// Builds the showcase as one offline HTML file: bundles the entry with esbuild, inlines the
// JavaScript, any CSS it imports and any woff2 fonts into an HTML template, and writes
// dist/cats.html. Fails above 1 MB, the page's size budget.
//
//   node build.mjs [--entry src/showcase/main.ts] [--template index.html] [--out dist/cats.html]
//
// Without --template, the root HTML page whose module script loads the entry is used,
// falling back to index.html.
import { build } from 'esbuild';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = dirname(fileURLToPath(import.meta.url));
const LIMIT = 1_000_000;

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i];
}
const entry = resolve(root, args.entry ?? 'src/showcase/main.ts');
const out = resolve(root, args.out ?? 'dist/cats.html');
if (!existsSync(entry)) {
  console.error(`build: ${relative(root, entry)} does not exist. Pass --entry to build another page.`);
  process.exit(1);
}

/** The root page that loads the entry as a module script, or index.html. */
function findTemplate() {
  const want = '/' + relative(root, entry).split('\\').join('/');
  for (const f of readdirSync(root).filter((f) => f.endsWith('.html'))) {
    if (readFileSync(resolve(root, f), 'utf8').includes(`src="${want}"`)) return resolve(root, f);
  }
  return resolve(root, 'index.html');
}
const templatePath = args.template ? resolve(root, args.template) : findTemplate();

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  platform: 'browser',
  write: false,
  outdir: resolve(root, 'dist/.build'),
  legalComments: 'none',
  charset: 'utf8',
  metafile: true,
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
  define: {
    'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true',
    'import.meta.env.MODE': '"production"',
  },
  logLevel: 'warning',
});
const js = result.outputFiles.filter((f) => f.path.endsWith('.js')).map((f) => f.text).join('\n');
const css = result.outputFiles.filter((f) => f.path.endsWith('.css')).map((f) => f.text).join('\n');

const MIME = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.css': 'text/css' };
const local = (ref) => !/^(https?:|data:|\/\/|#)/i.test(ref);
const fileOf = (ref) => (ref.startsWith('/') ? resolve(root, '.' + ref) : resolve(dirname(templatePath), ref));
const dataUrl = (ref) => `data:${MIME[extname(ref)] ?? 'application/octet-stream'};base64,${readFileSync(fileOf(ref)).toString('base64')}`;
/** Fonts referenced from CSS with url(...) become data URLs. */
const inlineFonts = (text) =>
  text.replace(/url\(\s*(['"]?)([^'")]+\.woff2?)\1\s*\)/g, (m, q, ref) => (local(ref) ? `url("${dataUrl(ref)}")` : m));

let html = readFileSync(templatePath, 'utf8');
// The dev server's entry script goes; the bundle replaces it.
html = html.replace(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>\s*/gi, (m, src) => (local(src) ? '' : m));
// Local stylesheets are inlined; font preloads are dropped, since the fonts are inlined too.
html = html.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi, (m, href) =>
  local(href) ? `<style>${inlineFonts(readFileSync(fileOf(href), 'utf8'))}</style>` : m,
);
html = html.replace(/<link\b[^>]*rel=["']preload["'][^>]*href=["']([^"']+\.woff2?)["'][^>]*>\s*/gi, (m, href) => (local(href) ? '' : m));
html = html.replace(/<style>([\s\S]*?)<\/style>/gi, (m, body) => `<style>${inlineFonts(body)}</style>`);

// Anything the page would still fetch from elsewhere breaks the offline promise.
const external = html.match(/(?:src|href)=["'](?:https?:)?\/\/[^"']+|url\(\s*['"]?(?:https?:)?\/\/[^)]+\)|@import\s/gi);
if (external) {
  console.error('build: the template still loads external resources:\n  ' + external.join('\n  '));
  process.exit(1);
}

// "</script" inside the bundle would end the inline script early.
const safeJs = js.replace(/<\/script/gi, '<\\/script');
if (css) html = html.replace(/<\/head>/i, () => `<style>${inlineFonts(css)}</style>\n</head>`);
html = html.replace(/<\/body>/i, () => `<script type="module">${safeJs}</script>\n</body>`);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);

const bytes = Buffer.byteLength(html);
const gz = gzipSync(html).length;
const kb = (n) => (n / 1000).toFixed(1) + ' kB';
const inputs = Object.entries(result.metafile.outputs)
  .flatMap(([, o]) => Object.entries(o.inputs))
  .reduce((acc, [path, { bytesInOutput }]) => {
    const key = path.includes('node_modules/three/') ? 'three' : path.startsWith('src/') ? path.split('/').slice(0, 2).join('/') : path;
    acc[key] = (acc[key] ?? 0) + bytesInOutput;
    return acc;
  }, {});
const top = Object.entries(inputs)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([k, v]) => `${k} ${kb(v)}`)
  .join(', ');
console.log(`build: ${relative(root, out)} ${kb(bytes)} (${bytes.toLocaleString('en')} bytes, ${kb(gz)} gzipped), template ${relative(root, templatePath)}`);
console.log(`  largest inputs: ${top}`);
if (bytes > LIMIT) {
  console.error(`build: ${kb(bytes)} is over the ${kb(LIMIT)} budget`);
  process.exit(1);
}
