// Development check for the props: every toy and prop from brain/toys.ts on the studio
// floor, simulated live, next to a 0.62 m stand-in cat for scale.
import { Group, Mesh, MeshStandardMaterial } from 'three';
import { Rng } from '../cats/math/rng';
import { Toys } from '../cats/brain/toys';
import { createProps, syncProps } from '../cats/geo/props';
import { lathe, placed, superellipsoid, tube } from '../cats/geo/primitives';
import { createStage, STUDIO } from '../showcase/stage';

const stage = createStage(document.getElementById('stage') as HTMLCanvasElement);
const sim = new Toys(new Rng(7));
const props = createProps(sim, { wallZ: STUDIO.wallZ });
stage.add(props.root);

// A stand-in cat: body, head and ears up to 0.62 m, legs to the floor.
const cat = new Group();
const shell = new MeshStandardMaterial({ color: '#e9a15c', roughness: 0.45 });
const add = (geo: Parameters<typeof placed>[0]) => {
  const m = new Mesh(geo, shell);
  m.castShadow = m.receiveShadow = true;
  cat.add(m);
};
add(placed(superellipsoid([0.12, 0.11, 0.21], 0.6, 0.6, [32, 20]), [0, 0.27, 0]));
add(placed(superellipsoid([0.14, 0.11, 0.115], 0.4, 0.4, [32, 20]), [0, 0.43, 0.2]));
for (const x of [0.075, -0.075]) add(placed(lathe([[0, 0.085], [0.042, 0.02], [0.048, 0]], 16), [x, 0.535, 0.2]));
for (const [x, z] of [[0.072, 0.13], [-0.072, 0.13], [0.072, -0.13], [-0.072, -0.13]]) add(tube([[x, 0.21, z], [x, 0, z]], 0.027, 12));
cat.position.set(-0.2, 0, 0.1);
cat.rotation.y = 0.5;
stage.add(cat);

stage.fit([props.root, cat], 0.9);
stage.setView('three-quarter', { snap: true });

sim.laser.turnOn('path');
sim.yarn.pin([0.55, 0.02, 0.62]);
let t = 0;
let last = performance.now();
const loop = (now: number) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  // Fixed 120 Hz steps, as the world takes them.
  for (let acc = dt; acc > 1e-6; acc -= 1 / 120) {
    t += 1 / 120;
    if (Math.abs(t - 1) < 1 / 240) sim.cup.knock([1, 0], 0.5);
    if (Math.abs(t - 0.5) < 1 / 240) sim.ball.bat([0, 0, 0], 0.6);
    sim.keyboard.stepOn(t % 2 < 1 ? [[sim.keyboard.position[0], 0, sim.keyboard.position[2]]] : []);
    sim.cushion.press(0.5 + 0.5 * Math.sin(t * 6));
    if (t > 1.5) sim.yarn.unpin();
    sim.step(1 / 120);
  }
  syncProps(sim, props);
  stage.frame(dt);
  requestAnimationFrame(loop);
};
stage.resize();
window.addEventListener('resize', () => stage.resize());
(window as unknown as { __props: unknown }).__props = { sim, stage, ready: false };
stage.warm([]).then(() => {
  (document.getElementById('stage') as HTMLCanvasElement).style.opacity = '1';
  (window as unknown as { __props: { ready: boolean } }).__props.ready = true;
  requestAnimationFrame(loop);
});
