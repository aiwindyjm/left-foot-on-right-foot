// R11 桌面 E2E：真实启动 Electron（生产加载路径），从 renderer 经 preload 桥
// 完成 创建→启动→阈值停止→暂停/恢复/停止→全局停止/解除→记录/事件 全流程，
// 并断言无 preload 错误与渲染层错误。仅 win32 + electron 二进制就绪时运行
// （npm run test:desktop；CI 跨平台核心测试不受影响）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const platformOk = process.platform === 'win32';
const binariesOk = existsSync(electronBin)
  && existsSync(join(root, 'dist', 'desktop', 'main.js'))
  && existsSync(join(root, 'dist', 'desktop', 'preload.cjs'))
  && existsSync(join(root, 'dist-ui', 'index.html'));

test('desktop E2E: renderer drives create->start->threshold-stop->pause/resume/stop->global flow', { skip: !platformOk || !binariesOk ? '需要 win32 与已构建的 Electron 产物（npm run build）' : false }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'lfrr-e2e-'));
  const child = spawn(electronBin, ['.'], {
    cwd: root,
    env: {
      ...process.env,
      LFRR_MODE: 'simulated',
      LFRR_USER_DATA: dataDir,
      LFRR_E2E: '1',
      ELECTRON_ENABLE_LOGGING: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
    if (stdout.includes('LFRR_E2E_RESULT:')) {
      // 结果已到，触发退出。
      setTimeout(() => child.kill(), 300);
    }
  });
  const stderrTail = (() => {
    let text = '';
    child.stderr.on('data', (chunk) => {
      text = `${text}${String(chunk)}`.slice(-2_000);
      return text;
    });
    return () => text;
  })();

  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 90_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // 尽力清理。
  }

  const marker = stdout.indexOf('LFRR_E2E_RESULT:');
  assert.ok(marker >= 0, `E2E 未输出结果（exit=${exitCode}）\nstdout 尾部：${stdout.slice(-1_000)}\nstderr 尾部：${stderrTail()}`);
  const line = stdout.slice(marker).split('\n')[0] ?? '';
  const outcome = JSON.parse(line.slice('LFRR_E2E_RESULT:'.length));
  const failed = outcome.steps.filter((step) => !step.ok);
  assert.deepEqual(failed, [], `E2E 步骤失败：${JSON.stringify(failed)}`);
  assert.deepEqual(outcome.preloadErrors, [], 'preload 不得有任何加载错误（R1）');
  assert.deepEqual(outcome.pageErrors, [], '渲染层不得有未捕获错误');
  assert.equal(outcome.ok, true);
  // 阶段名抽查：确认关键覆盖存在。
  const names = outcome.steps.map((step) => step.name);
  for (const expected of [
    'getState', 'createProject', 'startProject and reach threshold stop',
    'second project: pause -> resume -> stop',
    'global stop blocks start; resumeAll lifts without auto-revive',
    'invalid command returns structured error',
  ]) {
    assert.ok(names.includes(expected), `缺少 E2E 覆盖步骤：${expected}`);
  }
});
