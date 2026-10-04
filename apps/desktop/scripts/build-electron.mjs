// Bundle main + preload của Electron bằng esbuild (renderer do Vite build).
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node20', external: ['electron'], sourcemap: true };
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.js', format: 'cjs' });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.js', format: 'cjs' });
console.log('electron: dist-electron/{main,preload}.js');
