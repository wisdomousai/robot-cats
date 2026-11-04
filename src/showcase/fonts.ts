/**
 * The creatures playground's two faces: Newsreader for names and headings, Schibsted
 * Grotesk for everything else. Only the latin files are loaded, so the offline page stays
 * small. The console draws on a canvas, which does not wait for fonts, so the page awaits
 * `loadFonts` before it measures and lays out the console.
 */
import serif from '@fontsource-variable/newsreader/files/newsreader-latin-wght-normal.woff2';
import sans from '@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2';

const FACES = [
  new FontFace('Newsreader', `url(${serif}) format('woff2')`, { weight: '200 800' }),
  new FontFace('Schibsted Grotesk', `url(${sans}) format('woff2')`, { weight: '400 900' }),
];

export async function loadFonts(): Promise<void> {
  await Promise.all(
    FACES.map(async (f) => {
      // A font that fails to load leaves the fallbacks in the font stacks, which still work.
      try {
        document.fonts.add(await f.load());
      } catch {}
    }),
  );
}
