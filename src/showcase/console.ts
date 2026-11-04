/**
 * The showcase's controls, laid out the way the creatures playground lays out its own: a
 * frame round the window, a heading in the corner, a settings key that opens a small card
 * (views, x-ray, explode), the three cats as cards along the bottom with a row of subsystem
 * keys under them, the selected subsystem's spec sheet pinned on the right, and a menu of
 * tricks on a cat's right-click. It is plain HTML over the stage; the page styles it in
 * showcase.css.
 *
 * Coordinates: the tour and the name tags work in "console px", the window scaled to
 * 1600 x 900, so a tour written for one window size points at the same places in another.
 * `toClient` and `toConsole` convert to and from the window's CSS pixels.
 */
import { SUBSYSTEMS, type BreedId, type CatReadout, type Counters, type SpecRow, type SystemId, type WorldReadout } from '../cats/index';
import { VIEW_IDS, type ViewId } from './stage';

// ---------- Constants ----------

export const CONSOLE_WIDTH = 1600;
export const CONSOLE_HEIGHT = 900;

export const BREED_IDS: readonly BreedId[] = ['tabby', 'siamese', 'black'];

/** Coat swatches on the cat cards. */
const BREED_INK: Record<BreedId, { fill: string; stroke: string }> = {
  tabby: { fill: '#e9a15c', stroke: '#b9763a' },
  siamese: { fill: '#efe4d0', stroke: '#8f7f68' },
  black: { fill: '#2e2e33', stroke: '#18181b' },
};

/** The tricks in a cat's menu, in order. Each one sends its name as the trigger. */
export const BEHAVIOURS = [
  'walk',
  'trot',
  'run',
  'sit',
  'loaf',
  'stretch',
  'groom',
  'pounce',
  'ball',
  'laser',
  'sleep',
  'chase',
  'wrestle',
  'tag',
  'yarn',
] as const;
export type Behaviour = (typeof BEHAVIOURS)[number];

/** Behaviours that are group games (the world reports them in `game`). */
export const GAMES: readonly Behaviour[] = ['laser', 'chase', 'wrestle', 'tag', 'yarn'];

export const VIEW_LABELS: Record<ViewId, string> = {
  'three-quarter': '3/4',
  front: 'front',
  side: 'side',
  top: 'top',
  head: 'head',
  follow: 'follow',
};

const REPO = 'https://github.com/wisdomousai/robot-cats';

// ---------- Buttons and actions ----------

/**
 * Button ids: `sys:<SystemId>`, `act:<behaviour>`, `cat:<BreedId>`, `coat:<BreedId>`,
 * `view:<ViewId>`, `xray`, `explode` (the slider) and `tour`.
 */
export type Action =
  | { kind: 'subsystem'; id: SystemId }
  | { kind: 'behaviour'; name: Behaviour }
  | { kind: 'cat'; breed: BreedId }
  | { kind: 'coat'; breed: BreedId }
  | { kind: 'view'; view: ViewId }
  | { kind: 'xray' }
  | { kind: 'explode' }
  | { kind: 'tour' };

export type ButtonKind = Action['kind'];

/** Parses a button id; null for an id no button has. */
export function actionOf(id: string): Action | null {
  const [head, rest] = id.split(':') as [string, string | undefined];
  switch (head) {
    case 'sys':
      return SUBSYSTEMS.some((s) => s.id === rest) ? { kind: 'subsystem', id: rest as SystemId } : null;
    case 'act':
      return (BEHAVIOURS as readonly string[]).includes(rest ?? '') ? { kind: 'behaviour', name: rest as Behaviour } : null;
    case 'cat':
      return BREED_IDS.includes(rest as BreedId) ? { kind: 'cat', breed: rest as BreedId } : null;
    case 'coat':
      return BREED_IDS.includes(rest as BreedId) ? { kind: 'coat', breed: rest as BreedId } : null;
    case 'view':
      return VIEW_IDS.includes(rest as ViewId) ? { kind: 'view', view: rest as ViewId } : null;
    case 'xray':
    case 'explode':
    case 'tour':
      return rest === undefined ? { kind: head } : null;
    default:
      return null;
  }
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a pointer is over: a button id, and for the explode slider the value under it. */
export interface ConsoleHit {
  id: string;
  value?: number;
}

// ---------- Page state the console shows ----------

/**
 * The page's side of the console: which view, effects and coats are on, the tour, the
 * caption, and where the spec sheet's leader and the name tags point. The world knows
 * none of this.
 */
export interface ConsoleUi {
  /** Page time in seconds. */
  time: number;
  view: ViewId;
  xray: boolean;
  explode: number;
  /** The coat each cat wears, by the breed the coat comes from. */
  coats: Record<BreedId, BreedId>;
  tour: { running: boolean; time: number; duration: number; resumeIn: number | null };
  caption: string | null;
  /** Button under the visitor's pointer. */
  hover: string | null;
  /** Last pressed button. */
  flash: { id: string; at: number } | null;
  fps: number;
  tier: number;
  /** The isolated parts of the selected cat on screen, console px, or null. */
  anchor: [number, number] | null;
  /** Each cat's name tag position on screen, console px. */
  tags: { id: BreedId; at: [number, number] }[];
}

export function createUi(): ConsoleUi {
  return {
    time: 0,
    view: 'three-quarter',
    xray: false,
    explode: 0,
    coats: { tabby: 'tabby', siamese: 'siamese', black: 'black' },
    tour: { running: false, time: 0, duration: 0, resumeIn: null },
    caption: null,
    hover: null,
    flash: null,
    fps: 0,
    tier: 0,
    anchor: null,
    tags: [],
  };
}

// ---------- Formatting ----------

const formatAny = (v: unknown): string => {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.map(formatAny).join(' / ');
  return String(v);
};

/** The value a spec row shows for a cat: its static value, or the live key formatted. */
export function specValue(row: SpecRow, cat: CatReadout | undefined, counters: Counters): string {
  if (row.live === undefined) return row.value ?? '';
  const key = row.live as string;
  let v: unknown;
  if (cat && Object.prototype.hasOwnProperty.call(cat, key)) v = (cat as unknown as Record<string, unknown>)[key];
  else if (Object.prototype.hasOwnProperty.call(counters, key)) v = (counters as unknown as Record<string, unknown>)[key];
  else return row.value ?? '–';
  const s = row.format ? row.format(v) : formatAny(v);
  return row.unit ? `${s} ${row.unit}` : s;
}

// ---------- Console ----------

export interface Console {
  toConsole(clientX: number, clientY: number): [number, number];
  toClient(x: number, y: number): [number, number];
  /** The button under a client point, or null. */
  hit(clientX: number, clientY: number): ConsoleHit | null;
  /** A button's rectangle in client px, or null while it is not on the page. */
  rect(id: string): Rect | null;
  /**
   * Where to point at a button, client px: its centre, or for the slider the knob at
   * `value`. A button in the settings card or a cat's menu opens it for a few seconds, so
   * the tour's cursor has something to press.
   */
  point(id: string, value?: number): [number, number] | null;
  /** The explode value under a client x. */
  sliderValue(clientX: number): number;
  /** Opens a cat's menu of tricks at a client point. */
  tricks(id: BreedId, clientX: number, clientY: number): void;
  /** Updates what changed; always true. */
  frame(world: WorldReadout, ui: ConsoleUi, t: number, tier?: number): boolean;
  draw(world: WorldReadout, ui: ConsoleUi, t: number): void;
  /** Nothing to forget: the console keeps no history. Kept for the tour's seek. */
  clearHistory(): void;
  dispose(): void;
}

export interface ConsoleOptions {
  /** A visitor pressed a button: the page applies it as live input. */
  onPress(id: string, value?: number): void;
}

/** Seconds a card the tour opened stays open. */
const REVEAL = 2.8;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const key = (id: string, label: string, cls = 'key'): HTMLButtonElement => {
  const b = el('button', cls);
  b.type = 'button';
  b.dataset.id = id;
  b.append(el('span', 'label', label));
  return b;
};

export function createConsole(parent: HTMLElement, opts: ConsoleOptions): Console {
  const root = el('div', 'ui');
  parent.appendChild(root);

  // ----- Frame and heading -----

  root.appendChild(el('div', 'frame'));
  const head = el('header', 'head');
  head.append(el('h1', '', 'Robot cats'));
  head.append(el('p', 'lede', 'Three toy-robot cats. Pick a cat and give it a trick, or pick a subsystem to see how it works.'));
  root.appendChild(head);

  // ----- Corner: tour and settings -----

  const corner = el('div', 'corner');
  const tourKey = key('tour', 'Tour');
  const tourLabel = tourKey.querySelector<HTMLElement>('.label')!;
  const settingsKey = el('button', 'settings-key');
  settingsKey.type = 'button';
  settingsKey.title = 'Settings';
  settingsKey.setAttribute('aria-label', 'Settings');
  settingsKey.setAttribute('aria-expanded', 'false');
  settingsKey.innerHTML =
    '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M3 6.5h14M3 13.5h14"/><circle cx="7.5" cy="6.5" r="2.2"/><circle cx="12.5" cy="13.5" r="2.2"/></svg>';
  corner.append(tourKey, settingsKey);
  root.appendChild(corner);

  const settings = el('div', 'settings');
  settings.hidden = true;
  const viewRow = el('div', 'choice');
  viewRow.append(el('span', 'choice-name', 'View'));
  VIEW_IDS.forEach((v, i) => {
    const b = key(`view:${v}`, VIEW_LABELS[v]);
    b.prepend(el('span', 'num', String(i + 1)));
    viewRow.append(b);
  });
  const partsRow = el('div', 'choice');
  partsRow.append(el('span', 'choice-name', 'Parts'));
  const xrayKey = key('xray', 'X-ray');
  const explodeLabel = el('label', 'slider');
  explodeLabel.dataset.id = 'explode';
  explodeLabel.append(el('span', '', 'Explode'));
  const explode = el('input');
  explode.type = 'range';
  explode.min = '0';
  explode.max = '1';
  explode.step = '0.01';
  explode.value = '0';
  explodeLabel.append(explode);
  partsRow.append(xrayKey, explodeLabel);
  settings.append(viewRow, partsRow, el('p', 'hint', 'Drag to turn the camera, scroll to zoom, keys 1–6 for views.'));
  root.appendChild(settings);

  // ----- Spec sheet -----

  const sheet = el('section', 'spec');
  sheet.hidden = true;
  const specTitle = el('h2');
  const specId = el('span', 'spec-id');
  const specTop = el('div', 'spec-top');
  specTop.append(specTitle, specId);
  const specLine = el('p', 'spec-line');
  const specRows = el('dl', 'spec-rows');
  const specDemo = el('p', 'spec-demo');
  sheet.append(el('i', 'pin'), specTop, specLine, specRows, specDemo);
  root.appendChild(sheet);

  const svgNS = 'http://www.w3.org/2000/svg';
  const leaderSvg = document.createElementNS(svgNS, 'svg');
  leaderSvg.classList.add('leader');
  const leader = document.createElementNS(svgNS, 'path');
  const leaderDot = document.createElementNS(svgNS, 'circle');
  leaderDot.setAttribute('r', '3.5');
  leaderSvg.append(leader, leaderDot);
  root.appendChild(leaderSvg);

  // ----- Caption and name tags -----

  const caption = el('p', 'caption');
  caption.hidden = true;
  root.appendChild(caption);

  const tags = new Map<BreedId, HTMLElement>();
  for (const id of BREED_IDS) {
    const t = el('span', 'tag');
    t.hidden = true;
    tags.set(id, t);
    root.appendChild(t);
  }

  // ----- Bottom: cat cards and subsystem keys -----

  const dock = el('div', 'dock');
  const cards = el('div', 'cards');
  const cardParts = new Map<BreedId, { card: HTMLButtonElement; swatch: HTMLElement; name: HTMLElement; line: HTMLElement }>();
  BREED_IDS.forEach((id, i) => {
    const card = el('button', 'card');
    card.type = 'button';
    card.dataset.id = `cat:${id}`;
    // Pinned a little crooked, as the playground's cards are.
    card.style.setProperty('--turn', `${[-1.2, 0.8, -0.5][i]}deg`);
    const top = el('span', 'card-top');
    const swatch = el('i', 'swatch');
    const name = el('span', 'card-name', id);
    top.append(swatch, name);
    const line = el('span', 'card-line', '');
    card.append(el('i', 'pin'), top, line);
    cards.append(card);
    cardParts.set(id, { card, swatch, name, line });
  });
  // Rows of keys under the cards: the selected cat's tricks and the group games, then the
  // subsystems. The tricks row names the cat it applies to.
  const row = (name: string) => {
    const r = el('div', 'row');
    const label = el('span', 'row-name', name);
    r.append(label);
    return { r, label };
  };
  const tricksRow = row('Tricks');
  for (const b of BEHAVIOURS) if (!GAMES.includes(b)) tricksRow.r.append(key(`act:${b}`, b));
  const gamesName = el('span', 'row-name games-name', 'Games');
  tricksRow.r.append(gamesName);
  for (const b of GAMES) tricksRow.r.append(key(`act:${b}`, b));
  const subsRow = row('Subsystems');
  for (const s of SUBSYSTEMS) {
    const b = key(`sys:${s.id}`, s.id);
    b.title = s.title;
    subsRow.r.append(b);
  }
  dock.append(cards, tricksRow.r, subsRow.r);
  root.appendChild(dock);

  const foot = el('p', 'foot');
  const repo = el('a', '', 'wisdomousai/robot-cats');
  repo.href = REPO;
  repo.target = '_blank';
  repo.rel = 'noopener';
  foot.append(repo, document.createTextNode(' · MIT'));
  root.appendChild(foot);

  // ----- Tricks menu -----

  const menu = el('div', 'trick-menu');
  menu.hidden = true;
  const menuName = el('p', 'trick-menu-name');
  const menuItems = el('div', 'trick-menu-items');
  for (const b of BEHAVIOURS) menuItems.append(key(`act:${b}`, b, 'trick'));
  const coatRow = el('div', 'choice');
  coatRow.append(el('span', 'choice-name', 'Coat'));
  for (const b of BREED_IDS) coatRow.append(key(`coat:${b}`, b));
  menu.append(menuName, menuItems, coatRow);
  root.appendChild(menu);

  // ----- Open and shut -----

  let worldCats: CatReadout[] = [];
  let selected: BreedId = 'tabby';
  let now = 0;
  // Page time until which a card stays open: a few seconds when the tour opened it,
  // Infinity when a visitor did.
  let settingsUntil = -Infinity;
  let menuUntil = -Infinity;
  let revealPending: 'settings' | 'menu' | null = null;

  const setSettings = (open: boolean) => {
    settings.hidden = !open;
    settingsKey.setAttribute('aria-expanded', String(open));
    if (!open) settingsUntil = -Infinity;
  };
  const openMenu = (id: BreedId, x: number, y: number) => {
    const c = worldCats.find((k) => k.id === id);
    menuName.textContent = c ? `${c.name}, ${c.id}` : id;
    menu.hidden = false;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, x))}px`;
    menu.style.top = `${Math.max(12, Math.min(window.innerHeight - h - 12, y))}px`;
  };
  const shutMenu = () => {
    menu.hidden = true;
    menuUntil = -Infinity;
  };

  /** Opens whatever holds a button, for the tour; false if no such button. */
  const reveal = (id: string): boolean => {
    const a = actionOf(id);
    if (!a) return false;
    if (a.kind === 'view' || a.kind === 'xray' || a.kind === 'explode') {
      if (settings.hidden) setSettings(true);
      if (settingsUntil !== Infinity) revealPending = 'settings';
    } else if (a.kind === 'coat') {
      if (menu.hidden) {
        const tag = tags.get(selected);
        const r = tag && !tag.hidden ? tag.getBoundingClientRect() : null;
        openMenu(selected, r ? r.right + 12 : window.innerWidth * 0.55, r ? r.top : window.innerHeight * 0.35);
      }
      if (menuUntil !== Infinity) revealPending = 'menu';
    }
    return true;
  };

  // ----- Visitor input -----

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.settings-key')) {
      setSettings(settings.hidden !== false);
      if (!settings.hidden) settingsUntil = Infinity;
      return;
    }
    const b = target.closest<HTMLElement>('[data-id]');
    if (!b || b.dataset.id === 'explode') return;
    const id = b.dataset.id!;
    opts.onPress(id);
    if (id.startsWith('act:')) shutMenu();
  };
  const onContext = (e: MouseEvent) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
    if (!card) return;
    e.preventDefault();
    const id = card.dataset.id!.slice(4) as BreedId;
    opts.onPress(`cat:${id}`);
    openMenu(id, e.clientX, e.clientY - 20);
    menuUntil = Infinity;
  };
  const onInput = () => opts.onPress('explode', Number(explode.value));
  const onDocDown = (e: PointerEvent) => {
    const t = e.target as HTMLElement;
    if (!menu.hidden && !t.closest('.trick-menu') && !t.closest('.card')) shutMenu();
    if (!settings.hidden && !t.closest('.settings') && !t.closest('.settings-key')) setSettings(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    shutMenu();
    setSettings(false);
  };
  root.addEventListener('click', onClick);
  root.addEventListener('contextmenu', onContext);
  explode.addEventListener('input', onInput);
  document.addEventListener('pointerdown', onDocDown, true);
  window.addEventListener('keydown', onKey);

  // ----- Geometry -----

  const toConsole = (cx: number, cy: number): [number, number] => [(cx * CONSOLE_WIDTH) / window.innerWidth, (cy * CONSOLE_HEIGHT) / window.innerHeight];
  const toClient = (x: number, y: number): [number, number] => [(x * window.innerWidth) / CONSOLE_WIDTH, (y * window.innerHeight) / CONSOLE_HEIGHT];
  /** The first element with a button id: the dock's key where the menu has one too. */
  const find = (id: string) => root.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
  const toggleAll = (id: string, cls: string, on: boolean) => {
    for (const e of root.querySelectorAll(`[data-id="${CSS.escape(id)}"]`)) toggle(e, cls, on);
  };
  const rectOf = (e: HTMLElement): Rect => {
    const r = e.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  /** Where 0 and 1 sit on the range input, client px (the knob's centre at each end). */
  const track = (): [number, number] => {
    const r = explode.getBoundingClientRect();
    const knob = 7;
    return [r.left + knob, r.right - knob];
  };
  const sliderValue = (clientX: number) => {
    const [a, b] = track();
    return Math.min(1, Math.max(0, (clientX - a) / (b - a)));
  };

  // ----- Drawing -----

  /** Writes text only when it changed, so a frame touches the DOM as little as it can. */
  const set = (e: HTMLElement, s: string) => {
    if (e.textContent !== s) e.textContent = s;
  };
  const toggle = (e: Element, cls: string, on: boolean) => {
    if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on);
  };
  const show = (e: HTMLElement, on: boolean) => {
    if (e.hidden === on) e.hidden = !on;
  };

  let specFor = '';
  const rowEls: { value: HTMLElement; row: SpecRow }[] = [];

  const draw = (world: WorldReadout, ui: ConsoleUi, t: number) => {
    now = t;
    worldCats = world.cats;
    selected = world.selected;
    const cat = world.cats.find((c) => c.id === world.selected);

    // A card the tour opened stays open REVEAL seconds from the frame it opened in.
    if (revealPending === 'settings') settingsUntil = now + REVEAL;
    if (revealPending === 'menu') menuUntil = now + REVEAL;
    revealPending = null;
    if (!settings.hidden && now > settingsUntil) setSettings(false);
    if (!menu.hidden && now > menuUntil) shutMenu();

    // Keys.
    toggle(tourKey, 'on', ui.tour.running);
    set(tourLabel, ui.tour.running ? 'Tour on' : ui.tour.resumeIn !== null ? `Tour in ${Math.ceil(ui.tour.resumeIn)} s` : 'Tour off');
    for (const v of VIEW_IDS) toggle(find(`view:${v}`)!, 'on', ui.view === v);
    toggle(xrayKey, 'on', ui.xray);
    if (document.activeElement !== explode && Number(explode.value) !== ui.explode) explode.value = String(ui.explode);
    for (const s of SUBSYSTEMS) toggle(find(`sys:${s.id}`)!, 'on', world.subsystem === s.id);
    for (const b of BEHAVIOURS) toggleAll(`act:${b}`, 'on', world.game === b || (!!cat && cat.act === b));
    set(tricksRow.label, cat ? `${cat.name}’s tricks` : 'Tricks');
    for (const b of BREED_IDS) toggle(find(`coat:${b}`)!, 'on', ui.coats[selected] === b);
    for (const k of root.querySelectorAll('.hover')) if ((k as HTMLElement).dataset.id !== ui.hover) k.classList.remove('hover');
    if (ui.hover) find(ui.hover)?.classList.add('hover');

    // Cat cards.
    for (const id of BREED_IDS) {
      const p = cardParts.get(id)!;
      const c = world.cats.find((k) => k.id === id);
      toggle(p.card, 'on', world.selected === id);
      const ink = BREED_INK[ui.coats[id] ?? id];
      p.swatch.style.background = ink.fill;
      p.swatch.style.borderColor = ink.stroke;
      if (!c) continue;
      set(p.name, c.name);
      set(p.line, `${c.id}, ${c.mood}, ${c.act}`);
    }

    // Spec sheet.
    const sub = world.subsystem ? SUBSYSTEMS.find((s) => s.id === world.subsystem) : undefined;
    show(sheet, !!sub);
    if (sub) {
      if (specFor !== sub.id) {
        specFor = sub.id;
        set(specTitle, sub.title);
        set(specId, sub.id);
        set(specLine, sub.line);
        specRows.replaceChildren();
        rowEls.length = 0;
        for (const row of sub.specs) {
          const dd = el('dd');
          specRows.append(el('dt', '', row.label), dd);
          rowEls.push({ value: dd, row });
        }
      }
      for (const { value, row } of rowEls) set(value, specValue(row, cat, world.counters));
      set(specDemo, cat ? `Demo: ${cat.name}, ${cat.act}` : '');
    } else specFor = '';

    // Leader from the isolated parts to the sheet.
    const anchor = !!sub && ui.anchor ? toClient(ui.anchor[0], ui.anchor[1]) : null;
    if (anchor) {
      const r = sheet.getBoundingClientRect();
      const ey = Math.min(r.bottom - 24, Math.max(r.top + 24, anchor[1]));
      leader.setAttribute('d', `M${anchor[0]},${anchor[1]} L${r.left - 36},${ey} L${r.left},${ey}`);
      leaderDot.setAttribute('cx', String(anchor[0]));
      leaderDot.setAttribute('cy', String(anchor[1]));
    }
    toggle(leaderSvg, 'shown', !!anchor);

    // Caption.
    show(caption, !!ui.caption);
    if (ui.caption) set(caption, ui.caption);
    toggle(caption, 'touring', ui.tour.running);

    // Name tags.
    const seen = new Set<BreedId>();
    for (const tag of ui.tags) {
      const c = world.cats.find((k) => k.id === tag.id);
      const e = tags.get(tag.id);
      if (!c || !e) continue;
      const [x, y] = toClient(tag.at[0], tag.at[1]);
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
      seen.add(tag.id);
      set(e, c.name);
      toggle(e, 'on', c.id === world.selected);
      e.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
    for (const [id, e] of tags) show(e, seen.has(id));
  };

  return {
    toConsole,
    toClient,
    hit(x, y) {
      const e = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!e || !root.contains(e)) return null;
      const b = e.closest<HTMLElement>('[data-id]');
      if (!b) return null;
      return b.dataset.id === 'explode' ? { id: 'explode', value: sliderValue(x) } : { id: b.dataset.id! };
    },
    rect(id) {
      const e = find(id);
      return e && e.offsetParent !== null ? rectOf(e) : null;
    },
    point(id, value) {
      if (!reveal(id)) return null;
      const e = find(id);
      if (!e || e.offsetParent === null) return null;
      if (id === 'explode') {
        const [a, b] = track();
        const r = explode.getBoundingClientRect();
        return [a + (b - a) * (value ?? 0), r.top + r.height / 2];
      }
      const r = rectOf(e);
      return [r.x + r.w / 2, r.y + r.h / 2];
    },
    sliderValue,
    tricks(id, x, y) {
      openMenu(id, x, y);
      menuUntil = Infinity;
    },
    frame(world, ui, t) {
      draw(world, ui, t);
      return true;
    },
    draw,
    clearHistory() {},
    dispose() {
      root.removeEventListener('click', onClick);
      root.removeEventListener('contextmenu', onContext);
      explode.removeEventListener('input', onInput);
      document.removeEventListener('pointerdown', onDocDown, true);
      window.removeEventListener('keydown', onKey);
      root.remove();
    },
  };
}
