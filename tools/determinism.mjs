// The library must be replayable from a seed: no wall clock, no Math.random in src/cats.
import { execSync } from 'node:child_process';
let out = '';
try {
  out = execSync(`grep -rn "Math.random\\|performance.now\\|Date.now\\|new Date" src/cats`, { encoding: 'utf8' });
} catch { /* grep exits 1 when nothing matches */ }
if (out.trim()) { console.error('Non-deterministic calls in src/cats:\n' + out); process.exit(1); }
console.log('determinism: ok');
