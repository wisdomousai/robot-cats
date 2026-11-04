# Conventions

These rules hold for every file in this repo. They exist so that work done in parallel fits together.

## Axes and units

- three.js axes. For a cat: +x is the cat's own left, +y is up, +z is its front (the way it faces).
- Units are metres. Pixel, the tabby, is about 0.62 m to the ear tips.
- Blender tables in `/Users/uti/repos/creatures/blender/cat.py` use Blender axes (x left, y back, z up, faces -y). Convert a Blender point `(x, y, z)` to `(x, z, -y)` here.
- Angles passed to the puppet are degrees, as a `Turn = [pitch, yaw, roll]`. Pitch about x, yaw about y, roll about z, in the cat's own axes relative to the bone's rest pose (the puppet converts through each bone's rest frame). Positive pitch tips an upright bone forward and swings a hanging one back; positive yaw turns a bone toward the cat's left.
- The floor is the plane y = 0. The play area is 3 m along x and 2 m along z, centred on the origin.

## Bones

Bone names are fixed strings used by geometry, puppet, acts and the console:
`root`, `body`, `head`, `ear.L`, `ear.R`, `tail.1` to `tail.N`, `leg.FL`, `leg.FR`, `leg.BL`, `leg.BR`, `shin.FL`, `shin.FR`, `shin.BL`, `shin.BR`.
L is the cat's left (+x). F is front (+z). `leg.*` runs hip to knee; `shin.*` runs knee to ankle. Parts are rigid meshes parented to bones. Only the tail tube is skinned.

## Determinism

Nothing in `src/cats` may call `Math.random`, `Date.now`, `new Date` or `performance.now`. Randomness comes from the `Rng` passed in; time comes from the world's `time`. `npm run check` enforces this with a grep. `src/showcase` may use the wall clock for fps only.

## Parts and systems

Every mesh part has a `name` (for example `Knee.FL`, `Whisker.L2`), a `system` (`SystemId`), a `bone`, a `role` (material role) and an `explode` direction. The console's isolate, x-ray and explode features and the cliché buttons select parts by `system` and by name prefix. Keep names stable.

## Materials

Material roles follow the creatures package: `shell`, `joint`, `bezel`, `screen`, `beacon`, `dot0` to `dot7`, `pad`, `inner`, `ghost`, `xray`. Coat regions are vertex colours on the `shell` material, so one material serves every coat.

## Code style

- TypeScript, ESM, strict. No React. No default exports.
- Comments explain why, in plain sentences. Headings and UI copy are plain nouns. No slogans, no taglines, no "X, not Y" phrasing anywhere, including cliché copy.
- Keep each module's public surface in `src/cats/types.ts` where it is shared across modules.
