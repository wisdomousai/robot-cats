/**
 * Live input for the showcase: the console's buttons, drag orbit with a little fling,
 * wheel zoom, keys 1 to 6 for the views, and the hand-over between the visitor and the
 * auto tour. Any input from the visitor stops the tour; after IDLE_SECONDS of quiet the
 * tour picks up again at its next beat.
 *
 * `createControls` is the one place a button press turns into stage effects (view,
 * isolate, x-ray, explode, selection) and world input. The visitor's clicks and the
 * tour's presses both go through it, so they cannot drift apart.
 */
import { Box3, Vector3, type Mesh } from 'three';
import { SUBSYSTEMS, type BreedId, type CatModel, type Input, type SystemId, type V3 } from '../cats/index';
import { actionOf, createUi, type Console, type ConsoleUi } from './console';
import type { TourCursor } from './cursor';
import type { Player } from './film';
import { VIEW_IDS, type Stage } from './stage';

/** Seconds without input before the tour resumes. */
export const IDLE_SECONDS = 25;

// ---------- Controls ----------

export interface Controls {
  /** The page state the console draws (view, effects, coats, tour, caption, anchor, tags). */
  readonly ui: ConsoleUi;
  readonly selected: BreedId;
  readonly subsystem: SystemId | null;
  /** The model of a cat, by default the selected one. */
  model(id?: BreedId): CatModel | undefined;
  /**
   * Apply a button. With no value, toggles toggle and the slider jumps to its far end;
   * with a value, toggles are set (1 on, 0 off) and the slider moves there at once.
   */
  press(id: string, value?: number): void;
  /** Merge world input for the next step. */
  feed(input: Input): void;
  /** The input gathered since the last call, for one world step. */
  drain(): Input;
  /** Current value of a slider or toggle: explode 0..1, xray and sys:* 0 or 1. */
  value(id: string): number;
  /** Re-apply view, isolate, x-ray and explode to the stage at once (after a seek or reset). */
  sync(): void;
  /** Back to the start state: tabby selected, three-quarter view, no effects, own coats. */
  reset(): void;
  /** Projects the callout anchor and the name tags into console px; call each frame. */
  overlay(con: Console): void;
}

export interface ControlsOptions {
  stage: Stage;
  models: CatModel[];
  /** Paints a cat in another breed's coat. Without it the coat buttons change only the console. */
  recoat?: (model: CatModel, coat: BreedId) => void;
  selected?: BreedId;
}

interface PartInfo {
  parts?: string[];
  system?: string;
}

/** The isolate set for a subsystem: its part prefixes plus its system id, or [] for the whole cat. */
export function isolateSet(id: SystemId | null): string[] | null {
  if (!id) return null;
  const s = SUBSYSTEMS.find((r) => r.id === id);
  if (!s) return null;
  return s.parts.length ? [...s.parts, s.id] : [];
}

/** Meshes of a model whose parts match an isolate set, the same rule the stage uses. */
function meshesIn(model: CatModel, prefixes: string[]): Mesh[] {
  const out: Mesh[] = [];
  const sources = model.meshes.length ? model.meshes : [model.root];
  for (const source of sources) {
    source.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      if (prefixes.length === 0) {
        out.push(mesh);
        return;
      }
      const info = (mesh.userData.parts ? mesh.userData : source.userData) as PartInfo;
      if (prefixes.some((p) => info.system === p || (info.parts ?? []).some((n) => n.startsWith(p)))) out.push(mesh);
    });
  }
  return out;
}

export function createControls(opts: ControlsOptions): Controls {
  const { stage } = opts;
  const ui = createUi();
  const models = new Map<BreedId, CatModel>(opts.models.map((m) => [m.breed.id, m]));
  const home: BreedId = opts.selected ?? 'tabby';
  let selected: BreedId = home;
  let subsystem: SystemId | null = null;
  let pending: Input = {};

  const model = (id: BreedId = selected) => models.get(id);

  const applyLook = () => {
    for (const [id, m] of models) {
      const on = id === selected;
      stage.isolate(m, on ? isolateSet(subsystem) : null);
      stage.xray(m, on && ui.xray);
    }
    stage.focus(subsystem ? (SUBSYSTEMS.find((r) => r.id === subsystem)?.props ?? []) : null);
  };

  const select = (b: BreedId) => {
    pending.select = b;
    if (b === selected) return;
    const old = model();
    if (old && ui.explode > 0) stage.explode(old, 0, 0.5);
    selected = b;
    const m = model();
    stage.select(m ?? null);
    applyLook();
    if (m && ui.explode > 0) stage.explode(m, ui.explode, 0.8);
  };

  // Anchor meshes are looked up once per (cat, subsystem).
  let anchorKey = '';
  let anchorMeshes: Mesh[] = [];
  const box = new Box3();
  const part = new Box3();
  const centre = new Vector3();
  const nearest = new Vector3();
  const head = new Vector3();

  const controls: Controls = {
    ui,
    get selected() {
      return selected;
    },
    get subsystem() {
      return subsystem;
    },
    model,
    press(id, value) {
      ui.flash = { id, at: ui.time };
      const a = actionOf(id);
      if (!a) return;
      switch (a.kind) {
        case 'subsystem': {
          const on = value === undefined ? subsystem !== a.id : value > 0.5;
          if (!on && subsystem !== a.id) return;
          subsystem = on ? a.id : null;
          pending.subsystem = subsystem;
          applyLook();
          break;
        }
        case 'behaviour':
          pending.trigger = a.name;
          break;
        case 'cat':
          select(a.breed);
          break;
        case 'coat': {
          ui.coats[selected] = a.breed;
          const m = model();
          if (m) opts.recoat?.(m, a.breed);
          break;
        }
        case 'view':
          ui.view = a.view;
          stage.setView(a.view);
          stage.resetOrbit();
          break;
        case 'xray':
          ui.xray = value === undefined ? !ui.xray : value > 0.5;
          applyLook();
          break;
        case 'explode': {
          const v = value === undefined ? (ui.explode > 0.5 ? 0 : 1) : Math.min(1, Math.max(0, value));
          ui.explode = v;
          const m = model();
          if (m) stage.explode(m, v, value === undefined ? 0.6 : 0);
          break;
        }
        case 'tour':
          // The tour button belongs to live.ts, which owns the player.
          break;
      }
    },
    feed(input) {
      Object.assign(pending, input);
    },
    drain() {
      const out = pending;
      pending = {};
      return out;
    },
    value(id) {
      if (id === 'explode') return ui.explode;
      if (id === 'xray') return ui.xray ? 1 : 0;
      if (id.startsWith('sys:')) return subsystem === id.slice(4) ? 1 : 0;
      return 0;
    },
    sync() {
      stage.setView(ui.view, { snap: true });
      stage.select(model() ?? null);
      applyLook();
      for (const [id, m] of models) stage.explode(m, id === selected ? ui.explode : 0, 0);
    },
    reset() {
      for (const [id, m] of models) if (ui.coats[id] !== id) opts.recoat?.(m, id);
      const fresh = createUi();
      Object.assign(ui, { view: fresh.view, xray: false, explode: 0, coats: fresh.coats, caption: null, flash: null, anchor: null });
      selected = home;
      subsystem = null;
      pending = {};
      stage.resetOrbit();
      controls.sync();
    },
    overlay(con) {
      const rect = stage.renderer.domElement.getBoundingClientRect();
      const toConsole = (p: V3): [number, number] | null => {
        const [x, y] = stage.project(p);
        return Number.isFinite(x) ? con.toConsole(x + rect.left, y + rect.top) : null;
      };
      ui.anchor = null;
      const m = model();
      const set = isolateSet(subsystem);
      if (m && set) {
        const key = `${selected}:${subsystem}`;
        if (key !== anchorKey) {
          anchorKey = key;
          anchorMeshes = meshesIn(m, set);
        }
        box.makeEmpty();
        for (const mesh of anchorMeshes) {
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          part.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
          box.union(part);
        }
        if (!box.isEmpty()) {
          // The middle of a pair of parts (two ears, two front legs) is empty space, so the
          // leader goes to the part whose centre is nearest that middle.
          box.getCenter(centre);
          let best = Infinity;
          for (const mesh of anchorMeshes) {
            part.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
            part.getCenter(head);
            const d = head.distanceToSquared(centre);
            if (d < best) {
              best = d;
              nearest.copy(head);
            }
          }
          ui.anchor = toConsole([nearest.x, nearest.y, nearest.z]);
        }
      } else anchorKey = '';
      ui.tags = [];
      for (const [id, mm] of models) {
        // A cat the stage has hidden (a close view) has no tag either.
        if (!mm.root.visible) continue;
        const bone = mm.bones.get('head') ?? mm.root;
        bone.getWorldPosition(head);
        const at = toConsole([head.x, head.y + 0.2, head.z]);
        if (at) ui.tags.push({ id, at });
      }
    },
  };
  return controls;
}

// ---------- Live input ----------

export interface LiveOptions {
  stage: Stage;
  console: Console;
  controls: Controls;
  player: Player;
  /** The tour's cursor: while the tour runs, its tip is the cursor on the floor. */
  cursor?: TourCursor;
  /** Seconds of quiet before the tour resumes. */
  idle?: number;
  /** The element that takes pointer events; by default the stage canvas. */
  element?: HTMLElement;
}

export interface Live {
  /** True while the visitor has control (the tour is stopped). */
  readonly user: boolean;
  /** Seconds since the visitor's last input. */
  readonly idle: number;
  /** The visitor's pointer, or the tour cursor while the tour runs, on the floor. */
  floor(): V3 | null;
  /** Stop the tour and restart the idle timer, as any visitor input does. */
  takeover(): void;
  /** A visitor pressed a button: the tour key starts or stops the tour, any other takes over. */
  press(id: string, value?: number): void;
  /** Call once per frame with page time: fling, idle timer, tour state for the console. */
  update(t: number, dt: number): void;
  dispose(): void;
}

/** Orbit degrees per CSS px of drag, and how fast a fling dies away. */
const ORBIT_X = 0.3;
const ORBIT_Y = 0.2;
const FLING_TAU = 0.32;

export function createLive(opts: LiveOptions): Live {
  const { stage, controls, player } = opts;
  const con = opts.console;
  const idleFor = opts.idle ?? IDLE_SECONDS;
  const el = opts.element ?? stage.renderer.domElement;
  const ui = controls.ui;

  let now = 0;
  let lastInput = -Infinity;
  let pointer: { x: number; y: number } | null = null;
  let drag: { id: number; x: number; y: number; at: number; vx: number; vy: number } | null = null;
  let sliding: number | null = null;
  const fling = { az: 0, el: 0 };

  const takeover = () => {
    lastInput = now;
    if (player.running) player.stop(now);
  };

  const press = (id: string, value?: number) => {
    if (id === 'tour') {
      lastInput = now;
      if (player.running) player.stop(now);
      else {
        stage.resetOrbit();
        player.resume(now);
      }
    } else takeover();
    controls.press(id, value);
  };

  const setHover = (x: number, y: number) => {
    const hit = con.hit(x, y);
    ui.hover = hit?.id ?? null;
    el.style.cursor = drag ? 'grabbing' : hit ? 'pointer' : 'grab';
  };

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const hit = con.hit(e.clientX, e.clientY);
    if (hit?.id === 'explode') {
      takeover();
      sliding = e.pointerId;
      el.setPointerCapture(e.pointerId);
      controls.press('explode', hit.value);
      e.preventDefault();
      return;
    }
    if (hit) {
      press(hit.id);
      e.preventDefault();
      return;
    }
    takeover();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp, vx: 0, vy: 0 };
    fling.az = 0;
    fling.el = 0;
    el.setPointerCapture(e.pointerId);
    el.style.cursor = 'grabbing';
  };

  const onMove = (e: PointerEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (sliding === e.pointerId) {
      lastInput = now;
      controls.press('explode', con.sliderValue(e.clientX));
      return;
    }
    if (drag && drag.id === e.pointerId) {
      lastInput = now;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      const dt = Math.max(1, e.timeStamp - drag.at) / 1000;
      stage.orbit(-dx * ORBIT_X, dy * ORBIT_Y);
      // Smoothed drag velocity in degrees per second, for the fling on release.
      const k = Math.min(1, dt / 0.05);
      drag.vx += ((-dx * ORBIT_X) / dt - drag.vx) * k;
      drag.vy += ((dy * ORBIT_Y) / dt - drag.vy) * k;
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.at = e.timeStamp;
      return;
    }
    setHover(e.clientX, e.clientY);
  };

  const onUp = (e: PointerEvent) => {
    if (sliding === e.pointerId) sliding = null;
    if (drag && drag.id === e.pointerId) {
      // Only a drag still moving when released carries on.
      if (e.timeStamp - drag.at < 80) {
        const cap = (v: number) => Math.max(-400, Math.min(400, v));
        fling.az = cap(drag.vx);
        fling.el = cap(drag.vy);
      }
      drag = null;
    }
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    setHover(e.clientX, e.clientY);
  };

  const onLeave = () => {
    pointer = null;
    ui.hover = null;
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    takeover();
    stage.zoom(Math.exp(e.deltaY * 0.0012));
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= VIEW_IDS.length) {
      takeover();
      controls.press(`view:${VIEW_IDS[n - 1]}`);
      e.preventDefault();
    }
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
  el.style.cursor = 'grab';

  const live: Live = {
    get user() {
      return !player.running;
    },
    get idle() {
      return now - lastInput;
    },
    floor() {
      const rect = el.getBoundingClientRect();
      if (player.running && opts.cursor) {
        const [x, y] = opts.cursor.position;
        return stage.screenToFloor(x - rect.left, y - rect.top);
      }
      if (!pointer || con.hit(pointer.x, pointer.y)) return null;
      return stage.screenToFloor(pointer.x - rect.left, pointer.y - rect.top);
    },
    takeover,
    press,
    update(t, dt) {
      now = t;
      ui.time = t;
      // Holding a drag or the slider counts as input, even without movement.
      if (drag || sliding !== null) lastInput = t;
      if (Math.abs(fling.az) + Math.abs(fling.el) > 0.5) {
        stage.orbit(fling.az * dt, fling.el * dt);
        const k = Math.exp(-dt / FLING_TAU);
        fling.az *= k;
        fling.el *= k;
      }
      if (!player.running && t - lastInput >= idleFor) {
        stage.resetOrbit();
        player.resume(t);
      }
      ui.tour = {
        running: player.running,
        time: player.time,
        duration: player.duration,
        resumeIn: player.running ? null : Math.max(0, idleFor - (t - lastInput)),
      };
    },
    dispose() {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    },
  };
  return live;
}
