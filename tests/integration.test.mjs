// W6 集成测试：桌面同款服务装配（CoordinationService）全链路——
// 服务命令 → 协调核心 → 真实 OllamaClient → 本地假模型服务 → 模拟会话 → SQLite 持久化。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoordinationService } from '../dist/desktop/service.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'lfrr-w6-'));
}

function bestEffortRemove(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // Windows 句柄释放延迟导致的 EPERM：尽力清理即可。
  }
}

async function waitFor(service, projectId, predicate, timeoutMs = 15_000) {
  const started = Date.now();
  for (;;) {
    const status = await service.handleCommand({ kind: 'getState' });
    const project = status.ok && status.status
      ? status.status.projects.find((item) => item.projectId === projectId)
      : undefined;
    if (project && predicate(project)) return project;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timeout; last=${project ? JSON.stringify({ state: project.state, phase: project.phase, detail: project.statusDetail }) : 'missing'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

function createInput(id, threshold, suffix = '') {
  return {
    config: {
      projectId: id,
      name: `集成-${id}`,
      workspacePath: join(tempDir(), `ws-${id}`),
      goal: '完成集成验证目标',
      prdRef: 'docs/PRD.md@1.6',
      evaluator: { productId: 'simulated', sessionId: `sim-eval-progress${suffix}`, label: null },
      executor: { productId: 'simulated', sessionId: `sim-exec${suffix}`, label: null },
      stopThresholdPercent: threshold,
    },
  };
}

test('service full chain: create -> start -> threshold stop -> records persisted', async () => {
  const dir = tempDir();
  const service = await CoordinationService.create({ mode: 'simulated', dbDir: join(dir, 'db'), pollIntervalMs: 20 });
  try {
    const products = service.listProducts();
    assert.ok(products.some((product) => product.productId === 'simulated'));
    assert.equal(products.find((product) => product.productId === 'codex')?.integration, 'pending-integration');

    const created = await service.handleCommand({ kind: 'createProject', input: createInput('int-1', 80) });
    assert.equal(created.ok, true, JSON.stringify(created));
    const started = await service.handleCommand({ kind: 'startProject', projectId: 'int-1' });
    assert.equal(started.ok, true, JSON.stringify(started));

    const stopped = await waitFor(service, 'int-1', (project) => project.state === 'stopped_threshold');
    assert.equal(stopped.roundIndex, 3);
    assert.equal(stopped.lastEvaluation?.totalCompleteness, 80);

    const records = await service.handleCommand({ kind: 'listRecords', projectId: 'int-1', limit: 100 });
    assert.equal(records.ok, true);
    const kinds = new Set((records.records ?? []).map((record) => record.kind));
    for (const expected of ['evaluation_request', 'evaluation_reply', 'prompt_dispatch', 'execution_result']) {
      assert.ok(kinds.has(expected), `记录缺少 ${expected}`);
    }
    const events = await service.handleCommand({ kind: 'listEvents', projectId: 'int-1', limit: 100 });
    const eventTypes = new Set((events.events ?? []).map((event) => event.type));
    assert.ok(eventTypes.has('threshold_stop'));
    assert.ok(eventTypes.has('threshold_stop_suppressed_prompt'));
  } finally {
    await service.dispose();
    bestEffortRemove(dir);
  }
});

test('service multi-project isolation: 60% stops, 95% keeps running, independent state', async () => {
  const dir = tempDir();
  const service = await CoordinationService.create({ mode: 'simulated', dbDir: join(dir, 'db'), pollIntervalMs: 20 });
  try {
    assert.equal((await service.handleCommand({ kind: 'createProject', input: createInput('m-low', 60) })).ok, true);
    assert.equal((await service.handleCommand({ kind: 'createProject', input: createInput('m-high', 95, '-b') })).ok, true);
    assert.equal((await service.handleCommand({ kind: 'startProject', projectId: 'm-low' })).ok, true);
    assert.equal((await service.handleCommand({ kind: 'startProject', projectId: 'm-high' })).ok, true);
    const low = await waitFor(service, 'm-low', (project) => project.state === 'stopped_threshold');
    assert.equal(low.roundIndex, 1, '60% 阈值首轮停');
    await waitFor(service, 'm-high', (project) => project.roundIndex >= 3, 20_000);
    const high = await waitFor(service, 'm-high', (project) => project.state === 'running' || project.state !== 'stopped_threshold', 1_000);
    assert.notEqual(high.state, 'stopped_threshold', '95% 阈值不得在 80% 停');
    // 单项目暂停不影响另一个；全局停止收尾。
    assert.equal((await service.handleCommand({ kind: 'pauseProject', projectId: 'm-high' })).ok, true);
    const after = await service.handleCommand({ kind: 'getState' });
    const highView = after.status.projects.find((project) => project.projectId === 'm-high');
    assert.equal(highView.state, 'paused');
    assert.equal((await service.handleCommand({ kind: 'stopAll' })).ok, true);
    const final = await service.handleCommand({ kind: 'getState' });
    assert.equal(final.status.globalStop, true);
    // 全局停止后启动被拒绝。
    const blocked = await service.handleCommand({ kind: 'startProject', projectId: 'm-high' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'GLOBAL_STOPPED');
  } finally {
    await service.dispose();
    bestEffortRemove(dir);
  }
});

test('service persistence across restart: projects reload paused, threshold change recorded', async () => {
  const dir = tempDir();
  const dbDir = join(dir, 'db');
  const first = await CoordinationService.create({ mode: 'simulated', dbDir, pollIntervalMs: 20 });
  assert.equal((await first.handleCommand({ kind: 'createProject', input: createInput('persist-1', 70) })).ok, true);
  assert.equal((await first.handleCommand({ kind: 'setThreshold', projectId: 'persist-1', threshold: 85 })).ok, true);
  await first.dispose();

  const second = await CoordinationService.create({ mode: 'simulated', dbDir, pollIntervalMs: 20 });
  try {
    const status = await second.handleCommand({ kind: 'getState' });
    const project = status.status.projects.find((item) => item.projectId === 'persist-1');
    assert.ok(project, '重启后项目应载入');
    assert.equal(project.state, 'paused', '重启默认暂停');
    assert.equal(project.stopThresholdPercent, 85, '阈值持久化');
    const change = (await second.handleCommand({ kind: 'listEvents', projectId: 'persist-1', limit: 50 }))
      .events.find((event) => event.type === 'threshold_changed');
    assert.ok(change);
    assert.equal(change.data.from, 70);
    assert.equal(change.data.to, 85);
    // 暂停恢复可正常运行（无未决意图时无需核对）。
    assert.equal((await second.handleCommand({ kind: 'resumeProject', projectId: 'persist-1' })).ok, true);
    await waitFor(second, 'persist-1', (view) => view.roundIndex >= 1, 10_000);
    await second.handleCommand({ kind: 'stopProject', projectId: 'persist-1' });
  } finally {
    await second.dispose();
    bestEffortRemove(dir);
  }
});
