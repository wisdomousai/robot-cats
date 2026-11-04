import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';
import type { Expression, FaceLike, RngLike } from '../types';

/**
 * A cat's face: glowing shapes on a black screen, drawn on a canvas that the screen shows
 * as its emissive map. Ported from the creatures package's face.ts, keeping the cat's
 * parts (a nose and ω mouth, upright slit pupils that dilate) and all 14 expressions; the
 * dial, lashes, doodles and overlays are gone.
 *
 * Deterministic: blinks are scheduled from the RngLike passed to update, and animated
 * faces (drifting z's, spinning spirals, twinkling stars) run on the `time` passed in.
 *
 * Only redraws when something visible changes.
 */

/** Where things sit on a screen, as fractions of its width and height (y down, as drawn). */
export interface FaceLayout {
  width: number;
  height: number;
  /** Eye centres: the cat's right eye first (the viewer's left). */
  eyes: [number, number][];
  /** Eye radii and line weight, as fractions of the width (ry of the height). */
  rx: number;
  ry: number;
  line: number;
  /** Mouth centre, or null for a face without one. */
  mouth: [number, number] | null;
  /** A cat's nose and ω mouth and slit pupils; without it, a plain smile and round pupils. */
  kind?: 'cat';
  /** Pupil radius as a fraction of the eye's smaller radius (0.5 unless set); sizes the glint. */
  pupil?: number;
}

/** Pixel's screen, as CAT_FACE in creatures/src/cat.ts and 'cat' in blender/faces.py. */
export const CAT_FACE: FaceLayout = {
  width: 512,
  height: 320,
  eyes: [
    [0.31, 0.44],
    [0.69, 0.44],
  ],
  rx: 0.085,
  ry: 0.23,
  line: 0.03,
  mouth: [0.5, 0.74],
  kind: 'cat',
};

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/** What the texture holds: a canvas, or a size-only stand-in where there is no canvas (node). */
export type FaceCanvas = HTMLCanvasElement | OffscreenCanvas | { width: number; height: number };

/** Expressions that blink on their own. */
const BLINKS: readonly Expression[] = ['neutral', 'focused', 'sad', 'cross'];
/** Seconds a blink takes, shut to open. */
const BLINK_TIME = 0.16;

export class Face implements FaceLike {
  /**
   * The screen's emissive map. flipY is true (three.js's default, unlike the GLTF original,
   * whose UVs start at the top left): the geometry maps the glass with planar UVs, u growing
   * with +x (the cat's left, the viewer's right) and v with +y, (0, 0) at the bottom left,
   * so the canvas reads upright on a screen facing +z.
   */
  readonly texture: CanvasTexture<FaceCanvas>;
  expression: Expression = 'neutral';
  /** Where the eyes look, -1..1 each way (x to the viewer's right, y down). */
  look = { x: 0, y: 0 };
  /** 0 open, 1 shut. update() writes it while autoBlink is on. */
  blink = 0;
  /** Off, update() leaves blink to the caller (a slow blink held by an act). */
  autoBlink = true;
  /**
   * The pupils: 0 a narrow slit, 1 wide and round (excited, hunting, in the dark).
   * Startled, they go wide whatever this says.
   */
  dilate = 0;
  /** 0 closed, 1 wide: the mouth while talking (meowing). */
  talk = 0;
  /** A symbol on the screen between the eyes: question mark (puzzled) or a lightbulb (an idea). */
  mark: 'none' | 'question' | 'bulb' = 'none';
  /** How many blinks have started, and when the last one did (seconds, world time). */
  blinks = 0;
  lastBlink = -1;

  readonly layout: FaceLayout;
  private ctx: Ctx;
  private glow: string;
  private drawn = '';
  private nextBlink = 2;

  constructor(glow = '#f4f4f1', layout: FaceLayout = CAT_FACE) {
    this.layout = layout;
    this.glow = glow;
    const { canvas, ctx } = makeCanvas(layout.width, layout.height);
    this.ctx = ctx;
    this.texture = new CanvasTexture<FaceCanvas>(canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.flipY = true;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
  }

  reset() {
    this.expression = 'neutral';
    this.look.x = 0;
    this.look.y = 0;
    this.blink = 0;
    this.autoBlink = true;
    this.dilate = 0;
    this.talk = 0;
    this.mark = 'none';
    this.blinks = 0;
    this.lastBlink = -1;
    this.nextBlink = 2;
    this.drawn = '';
  }

  setGlow(glow: string) {
    this.glow = glow;
    this.drawn = '';
  }

  /** Blinks on its own and redraws if needed; call every step with the world time in seconds. */
  update(time: number, rng: RngLike) {
    const blinks = BLINKS.includes(this.expression);
    if (blinks && time > this.nextBlink) {
      this.lastBlink = time;
      this.blinks++;
      // Mostly single blinks, now and then a double.
      this.nextBlink = time + (rng.chance(0.2) ? 0.35 : rng.range(2, 6));
    }
    if (this.autoBlink) {
      const b = time - this.lastBlink;
      this.blink = blinks && b < BLINK_TIME ? Math.sin((b / BLINK_TIME) * Math.PI) : 0;
    }
    // Animated faces redraw on a clock: drifting z's, spinning spirals.
    const z =
      ({ asleep: Math.floor(time * 6), dizzy: Math.floor(time * 15), starry: Math.floor(time * 5) } as Record<
        string,
        number
      >)[this.expression] ?? 0;
    const key = [
      this.expression,
      this.glow,
      Math.round(this.look.x * 20),
      Math.round(this.look.y * 20),
      Math.round(this.blink * 4),
      Math.round(this.talk * 4),
      this.mark,
      this.mark === 'none' ? 0 : Math.floor(time * 8),
      Math.round(this.dilate * 8),
      z,
    ].join();
    if (key !== this.drawn) {
      this.drawn = key;
      this.draw(time);
      this.texture.needsUpdate = true;
    }
  }

  private draw(time: number) {
    const c = this.ctx;
    const L = this.layout;
    const cat = L.kind === 'cat';
    const W = L.width;
    const H = L.height;
    const RX = L.rx * W;
    const RY = L.ry * H;
    const LINE = L.line * W;
    const EYES = L.eyes.map(([x, y]) => [x * W, y * H] as [number, number]);
    const MOUTH: [number, number] = L.mouth ? [L.mouth[0] * W, L.mouth[1] * H] : [0, 0];
    const hasMouth = !!L.mouth;
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);
    c.fillStyle = c.strokeStyle = this.glow;
    c.lineCap = c.lineJoin = 'round';
    const dx = this.look.x * RX * 0.67;
    const dy = this.look.y * RY * 0.3;
    const eyes = EYES.map(([x, y]) => [x + dx, y + dy] as [number, number]);
    const mouth: [number, number] = [MOUTH[0] + dx * 0.5, MOUTH[1] + dy * 0.4];

    const ellipse = ([x, y]: [number, number], rx: number, ry: number) => {
      c.beginPath();
      c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      c.fill();
    };
    const arc = ([x, y]: [number, number], rx: number, ry: number, a0: number, a1: number, w: number) => {
      c.lineWidth = w;
      c.beginPath();
      c.ellipse(x, y, rx, ry, 0, a0 * Math.PI, a1 * Math.PI);
      c.stroke();
    };
    const nose = () => ellipse([mouth[0], mouth[1] - 0.06 * H], 0.025 * W, 0.03 * H);
    const catMouth = () => {
      // A small nose, and ω under it.
      nose();
      for (const s of [-1, 1]) arc([mouth[0] + s * 0.03 * W, mouth[1]], 0.03 * W, 0.05 * H, 0.1, 0.9, LINE * 0.8);
    };
    const smile = (big = false) =>
      !hasMouth
        ? undefined
        : this.talk > 0.05
          ? ellipse([mouth[0], mouth[1] + 0.01 * H], 0.04 * W, 0.015 * H + this.talk * 0.06 * H)
          : cat
            ? catMouth()
            : big
              ? arc([mouth[0], mouth[1] - 0.02 * H], 0.075 * W, 0.1 * H, 0.12, 0.88, LINE * 1.1)
              : arc(mouth, 0.055 * W, 0.07 * H, 0.15, 0.85, LINE * 0.85);
    const frown = () => {
      if (!hasMouth) return;
      if (cat) nose();
      arc([mouth[0], mouth[1] + 0.09 * H], 0.05 * W, 0.06 * H, 1.15, 1.85, LINE * 0.85);
    };
    const happyEye = ([x, y]: [number, number]) => arc([x, y + RY * 0.3], RX * 0.95, RY * 0.55, 1.1, 1.9, LINE);
    const closedEye = ([x, y]: [number, number]) => arc([x, y - RY * 0.15], RX * 0.95, RY * 0.35, 0.1, 0.9, LINE);
    // A dark pupil in a glowing eye, a glint on it, looking the way the eyes look. It is
    // clipped to the eye as drawn (blinking, sleepy, under a brow), so lids cut it too.
    const pupil = ([x, y]: [number, number], rx: number, ry: number, shown = ry, size = 1, drop = 0) => {
      const r = Math.min(rx, ry) * (L.pupil ?? 0.5) * size;
      // A cat's is an upright ellipse nearly the height of the eye, from a slit to
      // nearly round; otherwise it is round.
      const wide = this.expression === 'surprised' ? 1 : this.dilate;
      const [prx, pry] = cat ? [rx * (0.2 + 0.5 * wide) * size, ry * (0.8 - 0.1 * wide)] : [r, r];
      // A tall pupil moves less sideways, or the eye's curve would cut it.
      const px = x + this.look.x * (rx - prx) * (cat ? 0.25 : 0.55);
      const py = y + (drop + this.look.y * 0.55 * (1 - drop)) * (ry - pry);
      c.save();
      c.beginPath();
      c.ellipse(x, y, rx, shown, 0, 0, Math.PI * 2);
      c.clip();
      c.fillStyle = '#000';
      ellipse([px, py], prx, pry);
      c.fillStyle = this.glow;
      ellipse([px - r * 0.3, py - r * 0.45], r * 0.24, r * 0.24);
      c.restore();
    };
    const openEye = (e: [number, number], ry = RY) => {
      if (this.blink > 0.7) return closedEye(e);
      const shown = Math.max(ry * (1 - this.blink), RY * 0.1);
      ellipse(e, RX, shown);
      pupil(e, RX, ry, shown);
    };
    const heart = ([x, y]: [number, number], s: number) => {
      c.beginPath();
      c.moveTo(x, y + s * 0.95);
      c.bezierCurveTo(x - s * 1.5, y - s * 0.1, x - s * 0.8, y - s * 1.2, x, y - s * 0.45);
      c.bezierCurveTo(x + s * 0.8, y - s * 1.2, x + s * 1.5, y - s * 0.1, x, y + s * 0.95);
      c.fill();
    };
    // An eye cut by a straight brow; `slope` is how far it drops toward the face's middle.
    const browed = ([x, y]: [number, number], i: number, top: number, slope: number, draw: () => void) => {
      const inner = i === 0 ? 1 : -1;
      const brow = (px: number) => y - RY * top + inner * (px - x) * ((slope * RY) / RX);
      c.save();
      c.beginPath();
      c.moveTo(x - RX * 1.2, brow(x - RX * 1.2));
      c.lineTo(x + RX * 1.2, brow(x + RX * 1.2));
      c.lineTo(x + RX * 1.2, y + RY * 2);
      c.lineTo(x - RX * 1.2, y + RY * 2);
      c.clip();
      draw();
      c.restore();
    };

    switch (this.expression) {
      case 'neutral':
        eyes.forEach((e) => openEye(e));
        smile();
        break;
      case 'focused':
        eyes.forEach((e) => openEye([e[0], e[1] + RY * 0.15], RY * 0.6));
        if (hasMouth) arc([mouth[0], mouth[1] + 0.02 * H], 0.03 * W, 0.03 * H, 0.15, 0.85, LINE * 0.8);
        break;
      case 'sad':
        eyes.forEach((e) => openEye([e[0], e[1] + RY * 0.2], RY * 0.8));
        if (hasMouth) arc([mouth[0], mouth[1] + 0.09 * H], 0.05 * W, 0.06 * H, 1.15, 1.85, LINE * 0.85);
        break;
      case 'cross':
        // Eyes cut by a brow that slopes down toward the middle of the face.
        eyes.forEach((e, i) => browed(e, i, 0.3, 0.55, () => openEye(e)));
        frown();
        break;
      case 'happy':
        eyes.forEach(happyEye);
        smile(true);
        break;
      case 'surprised':
        // Wide eyes; a cat's pupils go wide and round.
        eyes.forEach((e) => {
          ellipse(e, RX * 1.13, RY * 0.63);
          pupil(e, RX * 1.13, RY * 0.63, RY * 0.63, cat ? 1 : 0.6);
        });
        if (hasMouth) arc([mouth[0], mouth[1] + 0.04 * H], 0.028 * W, 0.042 * H, 0, 2, LINE * 0.8);
        break;
      case 'love':
        eyes.forEach((e) => heart(e, RX * 0.93));
        smile(true);
        break;
      case 'wink':
        openEye(eyes[0]);
        happyEye(eyes[1]);
        smile(true);
        break;
      case 'sleepy':
        eyes.forEach(([x, y]) => {
          c.save();
          c.beginPath();
          c.rect(0, y + RY * 0.1, W, H);
          c.clip();
          ellipse([x, y], RX, RY * 0.75);
          // Heavy lids: the pupils sit low.
          pupil([x, y], RX, RY * 0.75, RY * 0.75, 1, 0.55);
          c.restore();
        });
        if (hasMouth) {
          c.lineWidth = LINE * 0.8;
          c.beginPath();
          c.moveTo(mouth[0] - 0.03 * W, mouth[1] + 0.03 * H);
          c.lineTo(mouth[0] + 0.03 * W, mouth[1] + 0.03 * H);
          c.stroke();
        }
        break;
      case 'asleep': {
        eyes.forEach(closedEye);
        // Little z's float up the screen's top right corner.
        c.font = `700 ${RY * 0.45}px ui-monospace, monospace`;
        const top = EYES[EYES.length - 1];
        for (let i = 0; i < 3; i++) {
          const k = (time * 0.35 + i / 3) % 1;
          c.globalAlpha = Math.sin(k * Math.PI);
          c.fillText('z', top[0] + RX * 1.6 + k * RX * 0.8, top[1] - RY * 0.6 - k * RY * 1.3);
        }
        c.globalAlpha = 1;
        break;
      }
      case 'starry': {
        // Sparkly star eyes that twinkle, over a big open smile.
        const star = ([x, y]: [number, number], r: number) => {
          c.beginPath();
          for (let i = 0; i < 10; i++) {
            const a = -Math.PI / 2 + (i * Math.PI) / 5;
            const k = i % 2 ? 0.45 : 1;
            c.lineTo(x + Math.cos(a) * r * k, y + Math.sin(a) * r * k * 1.05);
          }
          c.closePath();
          c.fill();
        };
        const twinkle = 1 + 0.09 * Math.sin(time * 9);
        eyes.forEach((e, i) => star(e, RY * 0.78 * (i ? 2 - twinkle : twinkle)));
        if (hasMouth) arc([mouth[0], mouth[1] - 0.03 * H], 0.08 * W, 0.1 * H, 0.08, 0.92, LINE * 1.1);
        break;
      }
      case 'sheepish': {
        // Eyes cast down and aside under heavy lids, a wobbly little mouth, a sweat drop.
        eyes.forEach(([x, y]) => {
          c.save();
          c.beginPath();
          c.rect(0, y - RY * 0.15, W, H);
          c.clip();
          ellipse([x, y + RY * 0.1], RX, RY * 0.8);
          pupil([x, y + RY * 0.1], RX, RY * 0.8, RY * 0.8, 1, 0.5);
          c.restore();
        });
        if (hasMouth) {
          c.lineWidth = LINE * 0.8;
          c.beginPath();
          for (let i = 0; i <= 20; i++) {
            const k = i / 20;
            c.lineTo(mouth[0] - 0.05 * W + k * 0.1 * W, mouth[1] + 0.04 * H + Math.sin(k * 2.5 * Math.PI) * 0.014 * H);
          }
          c.stroke();
        }
        const dx0 = EYES[EYES.length - 1][0] + RX * 1.7;
        const dy0 = EYES[EYES.length - 1][1] - RY * 0.9;
        c.beginPath();
        c.moveTo(dx0, dy0 - RY * 0.38);
        c.quadraticCurveTo(dx0 + RX * 0.55, dy0 + RY * 0.1, dx0, dy0 + RY * 0.22);
        c.quadraticCurveTo(dx0 - RX * 0.55, dy0 + RY * 0.1, dx0, dy0 - RY * 0.38);
        c.fill();
        break;
      }
      case 'determined':
        // Level brows cutting the eyes flat, and a firm short mouth.
        eyes.forEach((e, i) => browed(e, i, 0.35, 0.22, () => openEye([e[0], e[1] + RY * 0.05], RY * 0.95)));
        if (hasMouth) {
          c.lineWidth = LINE * 0.95;
          c.beginPath();
          c.moveTo(mouth[0] - 0.045 * W, mouth[1] + 0.005 * H);
          c.lineTo(mouth[0] + 0.045 * W, mouth[1] - 0.005 * H);
          c.stroke();
        }
        break;
      case 'dizzy':
        eyes.forEach(([x, y]) => {
          c.lineWidth = LINE * 0.7;
          c.beginPath();
          for (let i = 0; i <= 80; i++) {
            const t = (i / 80) * 3.5 * Math.PI + Math.floor(time * 15) * 0.4;
            const k = i / 80;
            c.lineTo(x + RX * k * Math.cos(t), y + RX * 0.92 * k * Math.sin(t));
          }
          c.stroke();
        });
        if (hasMouth) {
          c.lineWidth = LINE * 0.7;
          c.beginPath();
          for (let i = 0; i <= 40; i++) {
            const k = i / 40;
            c.lineTo(mouth[0] - 0.06 * W + k * 0.12 * W, mouth[1] + 0.03 * H + Math.sin(k * 3 * Math.PI) * 0.02 * H);
          }
          c.stroke();
        }
        break;
    }
    if (this.mark !== 'none') this.drawMark(time, W, H, LINE);
  }

  /** A question mark or a lightbulb in the gap between the eyes. */
  private drawMark(time: number, W: number, H: number, line: number) {
    const c = this.ctx;
    c.fillStyle = c.strokeStyle = this.glow;
    if (this.mark === 'question') {
      c.font = `700 ${H * 0.5}px ui-monospace, monospace`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('?', W / 2, H * 0.42 + Math.sin(time * 6) * H * 0.03);
      c.textAlign = 'start';
      c.textBaseline = 'alphabetic';
      return;
    }
    const [x, y, r] = [W / 2, H * 0.34, H * 0.12];
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
    c.fillRect(x - r * 0.5, y + r * 0.95, r, r * 0.5);
    c.lineWidth = line * 0.6;
    c.lineCap = 'round';
    const lit = Math.floor(time * 8) % 2;
    for (let i = 0; i < 7; i++) {
      const a = Math.PI * (1.12 + (i / 6) * 0.76);
      const [r0, r1] = [r * 1.35, r * (i % 2 === lit ? 1.85 : 1.65)];
      c.beginPath();
      c.moveTo(x + r0 * Math.cos(a), y + r0 * Math.sin(a));
      c.lineTo(x + r1 * Math.cos(a), y + r1 * Math.sin(a));
      c.stroke();
    }
  }

  dispose() {
    this.texture.dispose();
  }
}

/**
 * A canvas from the page, else an OffscreenCanvas (workers), else a size-only stand-in
 * with a context that ignores every call, so the face's state (blinks, redraw keys) still
 * runs under node.
 */
function makeCanvas(width: number, height: number): { canvas: FaceCanvas; ctx: Ctx } {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) return { canvas, ctx };
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (ctx) return { canvas, ctx };
  }
  return { canvas: { width, height }, ctx: nullContext() };
}

/** A 2D context that accepts any property and turns every method call into nothing. */
function nullContext(): Ctx {
  const props: Record<string | symbol, unknown> = {};
  const noop = () => undefined;
  return new Proxy(props, {
    get: (o, k) => (k in o ? o[k] : noop),
    set: (o, k, value) => {
      o[k] = value;
      return true;
    },
  }) as unknown as Ctx;
}
