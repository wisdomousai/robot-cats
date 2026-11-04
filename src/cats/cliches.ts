import type { Subsystem } from './types';

/**
 * The cat clichés, written as a spec sheet for each subsystem. This table is the only
 * place the copy lives: the console draws one button and one callout per row, the
 * engine maps a row's button to its demo act and its parts to isolate, and the tour
 * generates one beat per row. Adding a row adds all three.
 *
 * Copy rules: titles are plain nouns; lines are one or two factual sentences; the joke
 * is in the facts, never in the phrasing.
 */

const pct = (v: unknown) => `${Math.round(Number(v) * 100)} %`;
const deg = (v: unknown) => `${Math.round(Number(v))}°`;
const num = (digits: number) => (v: unknown) => Number(v).toFixed(digits);
const yesNo = (v: unknown) => (v ? 'yes' : 'no');
const pair = (v: unknown) => {
  const [a, b] = v as [number, number];
  return `${Math.round(a)}° / ${Math.round(b)}°`;
};

export const SUBSYSTEMS: Subsystem[] = [
  {
    id: 'ears',
    title: 'Selective hearing array',
    parts: ['Ear.', 'InnerEar.', 'EarRim.', 'EarHinge.', 'EarLed.'],
    line: 'Both ears turn toward the sound within 80 ms. The head stays where it was.',
    specs: [
      { label: 'Ear azimuth L / R', live: 'earAzimuth', format: pair },
      { label: 'Head yaw', live: 'headYaw', format: deg },
      { label: 'Treat bag detection range', value: '50 m' },
      { label: 'Tin opener detection range', value: '120 m' },
      { label: 'Own name recognition', value: '0 %' },
    ],
    demo: 'listen',
  },
  {
    id: 'head',
    title: 'Attention allocation unit',
    parts: ['Head', 'CrownSeam', 'CrownBolt', 'TempleBolt.', 'Fluff.'],
    line: 'Attention is allocated from a fixed table. The owner has an entry in the table.',
    specs: [
      { label: 'Owner', live: 'attention', format: (v) => pct((v as { owner: number }).owner) },
      { label: 'Empty box', live: 'attention', format: (v) => pct((v as { box: number }).box) },
      { label: 'A point on the wall', live: 'attention', format: (v) => pct((v as { nothing: number }).nothing) },
      { label: 'Current target', live: 'gazeTarget' },
    ],
    demo: 'ignore',
    props: ['box'],
    chart: 'donut',
  },
  {
    id: 'eyes',
    title: 'Slow blink trust protocol',
    parts: ['Screen', 'Bezel', 'ScreenLip'],
    line: 'One slow blink transmits one unit of trust. The pupils also dilate at a point in an empty corner.',
    specs: [
      { label: 'Blink duration', live: 'blinkMs', unit: 'ms', format: num(0) },
      { label: 'Trust per blink', value: '1 unit' },
      { label: 'Blinks issued', live: 'blinks' },
      { label: 'Pupil width', live: 'pupil', format: pct },
      { label: 'Entities in empty corner', value: '1, unverified' },
    ],
    demo: 'slowBlink',
  },
  {
    id: 'whiskers',
    title: 'Clearance gauge',
    parts: ['Pod.', 'Whisker.', 'WTip.'],
    line: 'Whisker span is compared with the opening before entry. The result is advisory.',
    specs: [
      { label: 'Measured span', live: 'whiskerSpan', unit: 'm', format: num(2) },
      { label: 'Opening width', value: '0.24 m' },
      { label: 'Verdict', value: 'proceed' },
      { label: 'Cases where the verdict mattered', value: '0' },
    ],
    demo: 'fitsCheck',
    props: ['box'],
  },
  {
    id: 'body',
    title: 'Liquid cat module',
    parts: ['Body', 'Seam.', 'Back.', 'ChestPlate'],
    line: 'Volume is conserved during container entry. Shape is adjusted to the container.',
    specs: [
      { label: 'State', live: 'liquid', format: (v) => (v ? 'liquid' : 'solid') },
      { label: 'Squash ratio', live: 'squash', format: pct },
      { label: 'Container fit', value: '100 %' },
      { label: 'Minimum container', value: '1 shoebox' },
    ],
    demo: 'fits',
    props: ['box'],
  },
  {
    id: 'belly',
    title: 'Belly trap',
    parts: ['BellyPlate', 'Hub.', 'HubBolt.'],
    line: 'The belly is displayed as an invitation. A touch is logged as consent to the grab.',
    specs: [
      { label: 'Trap armed', live: 'bellyArmed', format: yesNo },
      { label: 'Displayed trust', value: '100 %' },
      { label: 'Actual trust', value: '0 %' },
      { label: 'Trigger latency', value: '120 ms' },
      { label: 'Grabs this session', live: 'grabs' },
    ],
    demo: 'roll',
    chart: 'counter',
  },
  {
    id: 'paws',
    title: 'Knock-off actuator',
    parts: ['Leg.F', 'Shin.F', 'Paw.F', 'Pad.F', 'Toe.F', 'Knee.F', 'Sock.F'],
    line: 'Objects on an edge are moved to the floor. Eye contact is held for the duration.',
    specs: [
      { label: 'Objects displaced', live: 'cups' },
      { label: 'Eye contact during displacement', value: '100 %' },
      { label: 'Front paw load', live: 'load', format: (v) => pct((v as { FL: number }).FL) },
      { label: 'Edge detection', value: 'ledge' },
    ],
    demo: 'knock',
    props: ['ledge', 'cup'],
    chart: 'counter',
  },
  {
    id: 'kneading',
    title: 'Biscuit factory',
    parts: ['Pad.', 'Toe.'],
    line: 'Alternating paw presses are applied to any soft surface. No dough is involved.',
    specs: [
      { label: 'Biscuits this session', live: 'biscuits' },
      { label: 'Dough detected', value: 'none' },
      { label: 'Output', value: '0 biscuits' },
      { label: 'Purr coupling', live: 'purrHz', unit: 'Hz', format: num(0) },
    ],
    demo: 'knead',
    props: ['cushion'],
    chart: 'counter',
  },
  {
    id: 'legs',
    title: 'Zoomies drive',
    parts: ['Leg.', 'Shin.', 'Knee.', 'Hub.', 'HubBolt.', 'Sock.'],
    line: 'A sprint burst starts at 03:00. No trigger is recorded.',
    specs: [
      { label: 'Local time', value: '03:00' },
      { label: 'Burst speed', live: 'speed', unit: 'm/s', format: num(2) },
      { label: 'Reason', value: 'none' },
      { label: 'Laps', live: 'laps' },
    ],
    demo: 'zoomies',
    chart: 'clock',
  },
  {
    id: 'righting',
    title: 'Landing system',
    parts: ['Body', 'Hub.', 'Shin.', 'Paw.'],
    line: 'Any orientation is corrected before landing. Nine attempts are provisioned.',
    specs: [
      { label: 'Lives remaining', live: 'lives' },
      { label: 'Drop height', value: '0.6 m' },
      { label: 'Landings on feet', value: '100 %' },
      { label: 'Roll during fall', live: 'tailCarriage', format: deg },
    ],
    demo: 'dropTest',
    chart: 'counter',
  },
  {
    id: 'tail',
    title: 'Mood antenna',
    parts: ['Tail', 'TailBand.', 'TailCap', 'TailTip', 'TailHub'],
    line: 'Tail carriage encodes the current mood. The six carriages are listed in the chart.',
    specs: [
      { label: 'Carriage', live: 'tailCarriage', format: deg },
      { label: 'State', live: 'tailState' },
      { label: 'Spring energy', live: 'tailEnergy', format: num(2) },
    ],
    demo: 'semaphore',
    chart: 'semaphore',
  },
  {
    id: 'collar',
    title: 'Purr generator',
    parts: ['Collar', 'Stud.', 'Tag', 'TagRim', 'TagRing', 'Bell', 'BellSlit', 'BellCrown', 'Charm.'],
    line: 'Output is 25 Hz. The cause is recorded as proximity, or as unknown.',
    specs: [
      { label: 'Frequency', live: 'purrHz', unit: 'Hz', format: num(0) },
      { label: 'Cause', live: 'purrHz', format: (v) => (Number(v) > 0 ? 'proximity' : 'unknown') },
      { label: 'Mood', live: 'mood' },
    ],
    demo: 'purr',
  },
  {
    id: 'voice',
    title: 'Prey vocaliser',
    parts: ['Screen', 'WTip.'],
    line: 'Birds behind glass are addressed by chattering. Birds addressed: many. Birds caught: 0.',
    specs: [
      { label: 'Birds addressed', live: 'birds' },
      { label: 'Birds caught', value: '0' },
      { label: 'Jaw rate', value: '18 Hz' },
      { label: 'Window present', value: 'yes' },
    ],
    demo: 'chatter',
    props: ['bird'],
    chart: 'counter',
  },
  {
    id: 'keyboard',
    title: 'Warm surface targeting',
    parts: [],
    line: 'The warmest flat surface in use is selected. Document importance is weighted positively.',
    specs: [
      { label: 'Keys pressed', live: 'keys' },
      { label: 'Surface temperature', value: '31 °C' },
      { label: 'Document importance', value: 'high' },
      { label: 'Posture', live: 'posture' },
    ],
    demo: 'keyboard',
    props: ['keyboard'],
    chart: 'counter',
  },
  {
    id: 'bedding',
    title: 'Resting surface selector',
    parts: [],
    line: 'Two surfaces are offered. The cheaper one is chosen.',
    specs: [
      { label: 'Bed price', value: '89.00' },
      { label: 'Box price', value: '0.00' },
      { label: 'Boxes claimed', live: 'boxes' },
      { label: 'Bed occupancy', value: '0 %' },
    ],
    demo: 'boxOverBed',
    props: ['box', 'bed'],
    chart: 'counter',
  },
];

/** The six tail carriages the mood antenna publishes, with the angle in degrees above horizontal. */
export const TAIL_SEMAPHORE: { state: string; carriage: number; mood: string }[] = [
  { state: 'up, hooked tip', carriage: 80, mood: 'pleased' },
  { state: 'up, quivering', carriage: 85, mood: 'love' },
  { state: 'out, level', carriage: 10, mood: 'calm' },
  { state: 'low, still', carriage: -30, mood: 'sleepy' },
  { state: 'low, thumping', carriage: -20, mood: 'cross' },
  { state: 'up, puffed', carriage: 70, mood: 'startled' },
];

export const byId = (id: string): Subsystem | undefined => SUBSYSTEMS.find((s) => s.id === id);
