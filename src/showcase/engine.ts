// The page's handle on the cat world: one CatWorld from a seed, stepped with the console's
// input, read back as the plain WorldReadout the console draws. Starting over builds a new
// world from the same seed on the same models, so the scene keeps its meshes and a tour
// seek replays exactly what the tour showed.
import { BREEDS, CatWorld, type BreedId, type CatModel, type Input, type WorldReadout } from '../cats/index';

export interface Engine {
  readonly seed: number;
  /** The current world. reset() replaces it, so do not keep a reference across a reset. */
  readonly world: CatWorld;
  /** The three cats' models; the same objects for the life of the page. */
  readonly models: CatModel[];
  /** One step: apply the input, then advance dt seconds. */
  update(input: Input, dt: number): void;
  /** The readout after the last step. */
  state(): WorldReadout;
  /** Back to the state the seed starts from. */
  reset(): void;
}

export function createEngine(seed = 1, opts: { accent?: string } = {}): Engine {
  let world = new CatWorld(seed, { accent: opts.accent });
  const models = world.models;
  let snapshot: WorldReadout | null = null;
  return {
    seed,
    get world() {
      return world;
    },
    models,
    update(input, dt) {
      world.step(dt, input);
      snapshot = null;
    },
    state() {
      // Several readers ask in one frame; the readout copies arrays, so build it once per step.
      snapshot ??= world.readout();
      return snapshot;
    },
    reset() {
      world = new CatWorld(seed, { accent: opts.accent, models });
      snapshot = null;
    },
  };
}

/** The coat buttons: paints a cat in another breed's coat, its own breed's coat when coat is its id. */
export function recoat(model: CatModel, coat: BreedId): void {
  model.recoat(BREEDS[coat].coat);
}
