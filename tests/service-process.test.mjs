// R10 回归：协调 utility 进程协议链路（node fork 同一 entry 构建产物）——
// init/命令/串行/失联（kill 后在途请求立即失败）。宿主 utilityProcess.fork 接线
// 因 src/ 进程启动被安全门拦截而记录为阻塞（见 batch-A-R1 报告），协议层在此验证。
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServiceProcessManager } from '../dist/desktop/service-process.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entryPath = join(root, 'dist', 'desktop', 'service-entry.cjs');

function bestEffortRemove(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch { /* 尽力清理 */ }
}

async function forkService(dbDir) {
  const child = spawn(process.execPath, [entryPath], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    shell: false,
    windowsHide: true,
  });
  const manager = new ServiceProcessManager(child, { commandTimeoutMs: 10_000 });
  manager.bind();
  const init = await manager.command(
    { kind: 'init', dbDir, mode: 'simulated', modelEndpoint: 'http://127.0.0.1:9', modelName: 'probe' },
    20_000,
  );
  return { child, manager, init };
}

test('service process: init, project lifecycle, and clean shutdown over fork protocol', { skip: !existsSync(entryPath) ? '需要 npm run build:bundles 产物' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lfrr-svc-'));
  const { child, manager, init } = await forkService(dir);
  try {
    assert.equal(init.ok, true, JSON.stringify(init));
    const state = await manager.command({ kind: 'getState' });
    assert.equal(state.ok, true);
    assert.equal(state.status.mode, 'simulated');
    const created = await manager.command({
      kind: 'createProject',
      input: {
        config: {
          projectId: 'svc-probe', name: 'n', workspacePath: join(dir, 'ws'), goal: 'g', prdRef: 'p',
          evaluator: { productId: 'simulated', sessionId: 'sim-eval-progress', label: null },
          executor: { productId: 'simulated', sessionId: 'sim-exec', label: null },
          stopThresholdPercent: 80,
        },
      },
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const started = await manager.command({ kind: 'startProject', projectId: 'svc-probe' });
    assert.equal(started.ok, true, JSON.stringify(started));
    // 等到达标停止（模拟脚本 65→77→80）。
    let stopped = false;
    for (let index = 0; index < 200 && !stopped; index += 1) {
      const view = await manager.command({ kind: 'getState' });
      stopped = view.ok && view.status.projects[0]?.state === 'stopped_threshold';
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(stopped, 'utility 进程内的完整循环应达到阈值停止');
    await manager.command({ kind: 'shutdown' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(manager.running, false, 'shutdown 后进程应退出');
  } finally {
    child.kill();
    bestEffortRemove(dir);
  }
});

test('service process: killing the child fails in-flight requests immediately (lost-link semantics)', { skip: !existsSync(entryPath) ? '需要 npm run build:bundles 产物' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lfrr-svc-'));
  const { child, manager, init } = await forkService(dir);
  try {
    assert.equal(init.ok, true);
    // 杀掉子进程：下一个命令立刻返回 SERVICE_LOST，不悬挂。
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const result = await manager.command({ kind: 'getState' }, 2_000);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SERVICE_LOST');
  } finally {
    child.kill();
    bestEffortRemove(dir);
  }
});

test('service process: first command must be init (uninitialized service refuses)', { skip: !existsSync(entryPath) ? '需要 npm run build:bundles 产物' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lfrr-svc-'));
  const child = spawn(process.execPath, [entryPath], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    shell: false,
    windowsHide: true,
  });
  const manager = new ServiceProcessManager(child, {});
  manager.bind();
  try {
    const result = await manager.command({ kind: 'getState' }, 5_000);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SERVICE_NOT_INITIALIZED');
  } finally {
    child.kill();
    bestEffortRemove(dir);
  }
});
