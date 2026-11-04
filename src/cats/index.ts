// Public surface of the cats library. One block per area; each area's author adds its
// own exports to its block, and only modules that exist are exported.

// ---------- Types ----------
export * from './types';

// ---------- Maths (./math) ----------
export * from './math/spring';
export * from './math/rng';
export * from './math/curve';
export * from './math/ease';

// ---------- Rig (./rig) ----------
export * from './rig/skeleton';
export * from './rig/puppet';
export * from './rig/moves';

// ---------- Face (./face) ----------
export * from './face/face';

// ---------- Geometry (./geo) ----------
export * from './geo/primitives';
export * from './geo/paint';
export * from './geo/merge';
export * from './geo/props';

// ---------- Model (./model) ----------
export * from './model/dims';
export * from './model/coats';
export * from './model/materials';
export * from './model/parts';
export * from './model/build';

// ---------- Brain (./brain) ----------
export * from './brain/moods';
export * from './brain/steer';
export * from './brain/toys';
export * from './brain/acts';
export * from './brain/cat';
export * from './brain/play';
export * from './world';

// ---------- Clichés ----------
export * from './cliches';
