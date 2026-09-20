// R1/R10 构建步骤：把沙箱 preload 与 utility 服务入口打包为单文件 CommonJS。
// - preload 必须是 CJS：Electron sandbox 的 preload 不支持 ESM（评审 R1）。
// - service-entry 必须是 CJS：utilityProcess.fork / child_process.fork 的入口要求。
// esbuild 来自 devDependencies；产物写入 dist/desktop/。
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'desktop');
mkdirSync(outDir, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: [join(root, 'src', 'desktop', 'preload.ts')],
  outfile: join(outDir, 'preload.cjs'),
});

await build({
  ...common,
  entryPoints: [join(root, 'src', 'desktop', 'service-entry.ts')],
  outfile: join(outDir, 'service-entry.cjs'),
  mainFields: ['module', 'main'],
  external: ['electron', 'better-sqlite3', 'pino'],
});

console.log('bundles ready: preload.cjs, service-entry.cjs');
