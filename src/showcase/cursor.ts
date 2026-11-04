/**
 * The tour's fake cursor: an arrow in the accent colour that walks between points and
 * presses. Every motion is a function of the page time passed to `update(t)`, never of
 * CSS transitions or the wall clock, so a tour that seeks shows the cursor where the
 * timeline says it is.
 */

export interface TourCursor {
  readonly el: HTMLElement;
  /** Where the arrow's tip is now, CSS px in the parent's box. */
  readonly position: [number, number];
  /** Jump to a point at once. */
  place(to: [number, number]): void;
  /** Glide to a point over `seconds`, starting at `at` (default: the last update time). */
  walkTo(to: [number, number], seconds: number, at?: number): void;
  /** A click: the arrow squashes and a ring spreads from the tip, over 0.35 s. */
  press(at?: number): void;
  show(at?: number): void;
  hide(at?: number): void;
  /** Lay the cursor out for page time `t`, in seconds. */
  update(t: number): void;
  dispose(): void;
}

const PRESS = 0.35;
const FADE = 0.2;

/** cubic-bezier(x1, y1, x2, y2) as a function of progress 0..1, like CSS timing functions. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (u: number) => number {
  // Polynomial coefficients of the curve with P0 = (0, 0) and P3 = (1, 1).
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const x = (s: number) => ((ax * s + bx) * s + cx) * s;
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  const y = (s: number) => ((ay * s + by) * s + cy) * s;
  return (u: number) => {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    // Newton first; fall back to bisection where the slope is too flat to trust.
    let s = u;
    for (let i = 0; i < 6; i++) {
      const e = x(s) - u;
      const d = dx(s);
      if (Math.abs(e) < 1e-6) return y(s);
      if (Math.abs(d) < 1e-6) break;
      s -= e / d;
    }
    let lo = 0;
    let hi = 1;
    s = u;
    for (let i = 0; i < 30; i++) {
      const e = x(s) - u;
      if (Math.abs(e) < 1e-6) break;
      if (e > 0) hi = s;
      else lo = s;
      s = (lo + hi) / 2;
    }
    return y(s);
  };
}

/** The tour's travel curve: quick start, long soft landing. */
export const travel = cubicBezier(0.16, 1, 0.3, 1);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function createCursor(parent: HTMLElement, opts: { accent?: string } = {}): TourCursor {
  const accent = opts.accent ?? '#ff5a1f';
  const el = document.createElement('div');
  el.className = 'tour-cursor';
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '0',
    height: '0',
    pointerEvents: 'none',
    zIndex: '20',
    opacity: '0',
    willChange: 'transform, opacity',
  } satisfies Partial<CSSStyleDeclaration>);

  // The ring sits centred on the tip; the arrow hangs from the tip at its top-left.
  const ring = document.createElement('div');
  Object.assign(ring.style, {
    position: 'absolute',
    left: '-20px',
    top: '-20px',
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    border: `2px solid ${accent}`,
    boxSizing: 'border-box',
    opacity: '0',
    transform: 'scale(0.2)',
  } satisfies Partial<CSSStyleDeclaration>);

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '30');
  svg.setAttribute('viewBox', '0 0 24 30');
  Object.assign(svg.style, {
    position: 'absolute',
    // The path's tip is at (2, 2) in the view box.
    left: '-2px',
    top: '-2px',
    overflow: 'visible',
    transformOrigin: '2px 2px',
    filter: 'drop-shadow(0 2px 3px rgba(0, 0, 0, 0.28)) drop-shadow(0 0 1px rgba(0, 0, 0, 0.2))',
  } satisfies Partial<CSSStyleDeclaration>);
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', 'M2 2 L2 23.5 L7.6 18.3 L11.4 26.8 L15.3 25.1 L11.6 16.8 L19 16.8 Z');
  path.setAttribute('fill', accent);
  path.setAttribute('stroke', '#ffffff');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);

  el.append(ring, svg);
  parent.appendChild(el);

  let now = 0;
  let from: [number, number] = [0, 0];
  let to: [number, number] = [0, 0];
  let walkStart = 0;
  let walkLength = 0;
  let pressAt = -Infinity;
  let shown = false;
  let fadeAt = -Infinity;
  let fadeFrom = 0;
  let opacity = 0;
  const pos: [number, number] = [0, 0];

  const where = (t: number): [number, number] => {
    const u = walkLength > 0 ? travel(clamp01((t - walkStart) / walkLength)) : 1;
    return [from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u];
  };
  const fadeOpacity = (t: number) => {
    const u = clamp01((t - fadeAt) / FADE);
    return fadeFrom + ((shown ? 1 : 0) - fadeFrom) * u;
  };

  const cursor: TourCursor = {
    el,
    get position(): [number, number] {
      return [pos[0], pos[1]];
    },
    place(p) {
      from = [p[0], p[1]];
      to = [p[0], p[1]];
      walkLength = 0;
      cursor.update(now);
    },
    walkTo(p, seconds, at = now) {
      // Start from wherever the current glide has the cursor at the start time, so a walk
      // given mid-glide bends smoothly instead of jumping.
      from = where(at);
      to = [p[0], p[1]];
      walkStart = at;
      walkLength = Math.max(0, seconds);
    },
    press(at = now) {
      pressAt = at;
    },
    show(at = now) {
      if (shown) return;
      fadeFrom = fadeOpacity(at);
      shown = true;
      fadeAt = at;
    },
    hide(at = now) {
      if (!shown) return;
      fadeFrom = fadeOpacity(at);
      shown = false;
      fadeAt = at;
    },
    update(t) {
      now = t;
      const [x, y] = where(t);
      pos[0] = x;
      pos[1] = y;
      opacity = fadeOpacity(t);
      el.style.opacity = opacity.toFixed(3);
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;

      // Press: a quick squash toward the tip and back, and a ring that grows and fades.
      const p = (t - pressAt) / PRESS;
      if (p >= 0 && p <= 1) {
        const squash = Math.sin(Math.PI * Math.min(1, p * 1.6));
        svg.style.transform = `scale(${(1 - 0.16 * squash).toFixed(3)}, ${(1 - 0.22 * squash).toFixed(3)})`;
        const grow = travel(p);
        ring.style.opacity = (0.7 * (1 - p)).toFixed(3);
        ring.style.transform = `scale(${(0.2 + 0.9 * grow).toFixed(3)})`;
      } else {
        svg.style.transform = '';
        ring.style.opacity = '0';
      }
    },
    dispose() {
      el.remove();
    },
  };
  return cursor;
}
