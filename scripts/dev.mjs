// 开发启动：构建主进程与 UI，然后以模拟模式启动 Electron。
// 用法：npm run dev（等价 npm run build + LFRR_DEV 未设置的生产加载方式，
// 但使用本地 dist-ui；不启动 Vite dev server，避免 CSP 与端口依赖）。
// 真实 Ollama 模式：LFRR_MODE=production LFRR_MODEL_ENDPOINT=... npm run dev
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run('npm', ['run', 'build:app']);
run('npm', ['run', 'build:ui']);

const electron = spawn('node_modules/.bin/electron', ['.'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, LFRR_MODE: process.env.LFRR_MODE ?? 'simulated' },
});
electron.on('exit', (code) => process.exit(code ?? 0));
