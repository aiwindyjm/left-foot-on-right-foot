// W3 核心循环测试：阈值语义（PRD 7.4/15）、澄清、故障暂停、恢复阻断、工作区互斥。
// 模型走真实 OllamaClient + 本地假模型服务（真实调用代码，非固定返回桩）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../dist/storage/database.js';
import { RecordStore } from '../dist/storage/records.js';
import { Coordinator } from '../dist/core/coordinator.js';
import { ForegroundQueue, SerialQueue } from '../dist/core/queues.js';
import { WorkspaceRegistry, resolveWorkspace } from '../dist/core/workspace-lock.js';
import { SessionRegistry } from '../dist/core/session-lock.js';
import { SimulatedAdapter } from '../dist/adapters/simulated/simulated-adapter.js';
import { OllamaCoordinationModel } from '../dist/ollama/model-service.js';
import { startFakeModelServer } from '../dist/fake-model/fake-ollama-server.js';

async function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'lfrr-core-'));
  const db = createStore(dir);
  const store = new RecordStore(db.db);
  const adapter = new SimulatedAdapter(undefined, { replyDelayMs: 10 });
  const fakeModel = await startFakeModelServer();
  const model = new OllamaCoordinationModel(fakeModel.url, 'fake-qwen3:8b');
  const coordinator = new Coordinator({
    store,
    model,
    adapters: new Map([['simulated', adapter]]),
    modelQueue: new SerialQueue(),
    foregroundQueue: new ForegroundQueue(),
    workspaces: new WorkspaceRegistry(),
    sessions: new SessionRegistry(),
    mode: 'simulated',
    pollIntervalMs: 15,
  });
  return {
    coordinator, adapter, fakeModel, store, db,
    async cleanup() {
      coordinator.dispose();
      await fakeModel.close();
      db.close();
      tryBestEffortRemove(dir);
    },
  };
}

function projectInput(id, overrides = {}) {
  return {
    config: {
      projectId: id,
      name: `项目-${id}`,
      workspacePath: join(tmpdir(), `lfrr-ws-${id}`),
      goal: '完成示例功能并验证',
      prdRef: 'docs/PRD.md@1.6',
      evaluator: { productId: 'simulated', sessionId: 'sim-eval-progress', label: '模拟A' },
      executor: { productId: 'simulated', sessionId: 'sim-exec', label: '模拟B' },
      stopThresholdPercent: 80,
      limits: {
        maxClarifyPerRound: 2, roundTimeoutMs: 6_000, modelTimeoutMs: 2_000,
        adapterTimeoutMs: 2_000, maxStalledRounds: null,
      },
      ...overrides,
    },
  };
}

async function waitFor(coordinator, projectId, predicate, timeoutMs = 8_000) {
  const started = Date.now();
  for (;;) {
    const project = coordinator.getStatus().projects.find((item) => item.projectId === projectId);
    if (project && predicate(project)) return project;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timeout; last=${project ? JSON.stringify({ state: project.state, phase: project.phase, detail: project.statusDetail }) : 'missing'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}


function tryBestEffortRemove(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // Windows 句柄释放延迟导致的 EPERM：尽力清理即可，不影响断言。
  }
}

test('65 -> 77 -> 80 with threshold 80: two dispatches then threshold stop, suppressed prompt recorded', async () => {
  const harness = await makeHarness();
  try {
    const result = harness.coordinator.createProject(projectInput('p1'));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(harness.coordinator.startProject('p1').ok, true);
    const stopped = await waitFor(harness.coordinator, 'p1', (project) => project.state === 'stopped_threshold');
    assert.equal(stopped.roundIndex, 3, '应在第 3 轮（80%）停止');
    assert.ok(stopped.statusDetail?.includes('80'), stopped.statusDetail ?? '');
    const intents = harness.store.listIntents('p1', 50);
    assert.equal(intents.filter((intent) => intent.target === 'executor' && intent.state === 'confirmed').length, 2, '前两轮各派发一次');
    const events = harness.coordinator.listEvents('p1', 100);
    const suppressed = events.find((event) => event.type === 'threshold_stop_suppressed_prompt');
    assert.ok(suppressed, '达标时的附带提示词必须记录为未发送');
    assert.equal(suppressed?.data.total, 80);
    // 评估原文已持久化
    const evaluation = harness.store.latestEvaluation('p1');
    assert.equal(evaluation?.total_completeness, 80);
    assert.equal(evaluation?.next_prompt, '请做最终回归并汇报');
  } finally {
    await harness.cleanup();
  }
});

test('first evaluation 83 with threshold 60 stops immediately without any dispatch', async () => {
  const harness = await makeHarness();
  try {
    const input = projectInput('p-fast', {
      stopThresholdPercent: 60,
      evaluator: { productId: 'simulated', sessionId: 'sim-eval-fast', label: '模拟A' },
    });
    assert.equal(harness.coordinator.createProject(input).ok, true);
    harness.coordinator.startProject('p-fast');
    const stopped = await waitFor(harness.coordinator, 'p-fast', (project) => project.state === 'stopped_threshold');
    assert.equal(stopped.roundIndex, 1);
    assert.equal(harness.store.listIntents('p-fast', 10).filter((intent) => intent.target === 'executor').length, 0, '首轮达标不得派发');
    const evaluation = harness.store.latestEvaluation('p-fast');
    assert.equal(evaluation?.next_prompt, '附加任务：不要发送', '附带任务提示词必须保留展示');
  } finally {
    await harness.cleanup();
  }
});

test('same 80% evaluation: threshold 60 stops while threshold 95 continues (threshold not hardcoded)', async () => {
  const harness = await makeHarness();
  try {
    const low = projectInput('p-low', {
      stopThresholdPercent: 60,
      evaluator: { productId: 'simulated', sessionId: 'sim-eval-progress', label: '模拟A' },
    });
    const high = projectInput('p-high', {
      stopThresholdPercent: 95,
      evaluator: { productId: 'simulated', sessionId: 'sim-eval-progress-b', label: '模拟A副本' },
      executor: { productId: 'simulated', sessionId: 'sim-exec-b', label: '模拟B副本' },
    });
    assert.equal(harness.coordinator.createProject(low).ok, true);
    assert.equal(harness.coordinator.createProject(high).ok, true);
    harness.coordinator.startProject('p-low');
    harness.coordinator.startProject('p-high');
    const lowStopped = await waitFor(harness.coordinator, 'p-low', (project) => project.state === 'stopped_threshold');
    assert.equal(lowStopped.roundIndex, 1, '60% 阈值首轮 80% 即停');
    // 高阈值项目继续推进：轮次超过 3（脚本耗尽后维持 80%）
    await waitFor(harness.coordinator, 'p-high', (project) => project.roundIndex >= 4, 15_000);
    const stillRunning = harness.coordinator.getStatus().projects.find((project) => project.projectId === 'p-high');
    assert.equal(stillRunning?.state, 'running', '95% 阈值未达标必须继续，不因 80% 停止');
    harness.coordinator.stopProject('p-high');
    await waitFor(harness.coordinator, 'p-high', (project) => project.state === 'stopped_user');
  } finally {
    await harness.cleanup();
  }
});

test('missing total triggers bounded clarify to A, then proceeds', async () => {
  const harness = await makeHarness();
  try {
    const input = projectInput('p-vague', {
      evaluator: { productId: 'simulated', sessionId: 'sim-eval-vague', label: '模拟A' },
      stopThresholdPercent: 90,
    });
    assert.equal(harness.coordinator.createProject(input).ok, true);
    harness.coordinator.startProject('p-vague');
    // 第一轮：缺总分 -> 澄清 -> 68% -> 继续派发（阈值 90 未达标）
    await waitFor(harness.coordinator, 'p-vague', (project) => project.lastEvaluation !== null, 10_000);
    const messages = harness.store.listMessages('p-vague', 50);
    const clarifyOut = messages.find((message) => message.kind === 'clarify' && message.direction === 'to_a');
    assert.ok(clarifyOut, '必须向 A 发出澄清消息');
    const events = harness.coordinator.listEvents('p-vague', 50);
    assert.ok(events.some((event) => event.type === 'clarify_sent'), '澄清事件已记录');
    const running = await waitFor(harness.coordinator, 'p-vague', (project) => project.roundIndex >= 2 || project.state === 'paused', 12_000);
    assert.notEqual(running.state, 'paused', `不应暂停：${running.statusDetail}`);
    harness.coordinator.stopProject('p-vague');
  } finally {
    await harness.cleanup();
  }
});

test('model http 500 pauses project with model_failure and no dispatch', async () => {
  const harness = await makeHarness();
  try {
    harness.fakeModel.setBehavior({ fault: 'http500' });
    assert.equal(harness.coordinator.createProject(projectInput('p-model')).ok, true);
    harness.coordinator.startProject('p-model');
    const paused = await waitFor(harness.coordinator, 'p-model', (project) => project.state === 'paused');
    assert.equal(paused.pauseReason, 'model_failure');
    assert.ok(paused.statusDetail?.includes('MODEL'), paused.statusDetail ?? '');
    assert.equal(harness.store.listIntents('p-model', 10).filter((intent) => intent.target === 'executor').length, 0, '模型故障时不得派发执行任务');
  } finally {
    await harness.cleanup();
  }
});

test('paraphrased prompt extraction is refused (verbatim guard)', async () => {
  const harness = await makeHarness();
  try {
    harness.fakeModel.setBehavior({ fault: 'paraphrase' });
    assert.equal(harness.coordinator.createProject(projectInput('p-para')).ok, true);
    harness.coordinator.startProject('p-para');
    const paused = await waitFor(harness.coordinator, 'p-para', (project) => project.state === 'paused');
    assert.equal(paused.pauseReason, 'model_failure');
    assert.ok(paused.statusDetail?.includes('verbatim') || paused.statusDetail?.includes('MODEL_INVALID_OUTPUT'), paused.statusDetail ?? '');
    assert.equal(harness.store.listIntents('p-para', 10).filter((intent) => intent.target === 'executor').length, 0, '改写版提示词绝不派发');
  } finally {
    await harness.cleanup();
  }
});

test('unknown send receipt: intent stays unknown, project paused, restart blocks until manual abandon', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lfrr-core-'));
  const db = createStore(dir);
  const store = new RecordStore(db.db);
  const adapter = new SimulatedAdapter(undefined, { replyDelayMs: 10 });
  adapter.setFaults('sim-exec', { sendReceipt: 'unknown' });
  const fakeModel = await startFakeModelServer();
  const model = new OllamaCoordinationModel(fakeModel.url, 'fake-qwen3:8b');
  const buildCoordinator = () => new Coordinator({
    store, model,
    adapters: new Map([['simulated', adapter]]),
    modelQueue: new SerialQueue(), foregroundQueue: new ForegroundQueue(),
    workspaces: new WorkspaceRegistry(), sessions: new SessionRegistry(), mode: 'simulated', pollIntervalMs: 15,
  });
  const coordinator = buildCoordinator();
  try {
    assert.equal(coordinator.createProject(projectInput('p-unk')).ok, true);
    coordinator.startProject('p-unk');
    const paused = await waitFor(coordinator, 'p-unk', (project) => project.state === 'paused');
    assert.equal(paused.pauseReason, 'unknown_send');
    const unknown = store.unresolvedIntents('p-unk');
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].state, 'unknown', '未知回执意图不得被改写或重发');
    coordinator.dispose();
    // 模拟重启：新协调器载入同一数据库。
    const revived = buildCoordinator();
    revived.loadPersisted();
    const view = revived.getStatus().projects.find((project) => project.projectId === 'p-unk');
    assert.equal(view?.state, 'paused');
    assert.equal(view?.pauseReason, 'recovery_pending');
    assert.equal(revived.startProject('p-unk').ok, false, '未核对前禁止启动');
    assert.equal(revived.resumeProject('p-unk').code, 'RECOVERY_PENDING');
    const intentId = store.unresolvedIntents('p-unk')[0].intent_id;
    assert.equal(revived.abandonIntent('p-unk', intentId).ok, true);
    // 放弃后允许启动；故障仍在则再次暂停，但意图未被重发（仍是 unknown 已放弃）。
    adapter.setFaults('sim-exec', null);
    assert.equal(revived.startProject('p-unk').ok, true);
    await waitFor(revived, 'p-unk', (project) => project.roundIndex >= 2, 15_000);
    const intents = store.listIntents('p-unk', 20);
    assert.equal(intents.filter((intent) => intent.intent_id === intentId)[0].state, 'aborted');
    assert.ok(intents.filter((intent) => intent.state === 'confirmed').length >= 1, '放弃后新轮次正常派发');
    revived.dispose();
  } finally {
    await fakeModel.close();
    db.close();
    tryBestEffortRemove(dir);
  }
});

test('workspace mutex: same directory cannot be configured or executed concurrently', async () => {
  const harness = await makeHarness();
  try {
    const shared = join(tmpdir(), `lfrr-shared-${Date.now()}`);
    assert.equal(harness.coordinator.createProject(projectInput('p-ws1', { workspacePath: shared })).ok, true);
    const conflict = harness.coordinator.createProject(projectInput('p-ws2', { workspacePath: shared }));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'WORKSPACE_CONFLICT');
    // 别名（尾斜杠/大小写）归并到同一工作区键。
    const alias = harness.coordinator.createProject(projectInput('p-ws3', { workspacePath: `${shared}\\` }));
    assert.equal(alias.code, 'WORKSPACE_CONFLICT');
    const caseAlias = harness.coordinator.createProject(projectInput('p-ws4', {
      workspacePath: shared.toUpperCase(),
    }));
    assert.equal(caseAlias.code, 'WORKSPACE_CONFLICT', 'win32 大小写不敏感归并');
  } finally {
    await harness.cleanup();
  }
});

test('stalled rounds pause when maxStalledRounds configured', async () => {
  const harness = await makeHarness();
  try {
    const input = projectInput('p-stall', {
      evaluator: { productId: 'simulated', sessionId: 'sim-eval-stall', label: '模拟A' },
      stopThresholdPercent: 90,
      limits: {
        maxClarifyPerRound: 2, roundTimeoutMs: 6_000, modelTimeoutMs: 2_000,
        adapterTimeoutMs: 2_000, maxStalledRounds: 2,
      },
    });
    assert.equal(harness.coordinator.createProject(input).ok, true);
    harness.coordinator.startProject('p-stall');
    const paused = await waitFor(harness.coordinator, 'p-stall', (project) => project.state === 'paused', 15_000);
    assert.equal(paused.pauseReason, 'stalled');
    assert.ok(paused.statusDetail?.includes('无进展'), paused.statusDetail ?? '');
  } finally {
    await harness.cleanup();
  }
});

test('threshold change is recorded and judged by new value; stopped project stays stopped', async () => {
  const harness = await makeHarness();
  try {
    const input = projectInput('p-thr', {
      evaluator: { productId: 'simulated', sessionId: 'sim-eval-fast', label: '模拟A' },
      stopThresholdPercent: 90,
    });
    assert.equal(harness.coordinator.createProject(input).ok, true);
    harness.coordinator.startProject('p-thr');
    // 脚本维持 83%：低于 90% 阈值必须继续运行。
    const running = await waitFor(harness.coordinator, 'p-thr', (project) => project.roundIndex >= 2, 12_000);
    assert.equal(running.state, 'running', '83% 低于 90% 阈值应继续运行');
    harness.coordinator.stopProject('p-thr');
    await waitFor(harness.coordinator, 'p-thr', (project) => project.state === 'stopped_user');
    const change = harness.coordinator.setThreshold('p-thr', 95);
    assert.equal(change.ok, true);
    const changes = harness.store.listThresholdChanges('p-thr', 10);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].new_value, 95);
    // 已停止项目不因阈值变化自动复活。
    const still = harness.coordinator.getStatus().projects.find((project) => project.projectId === 'p-thr');
    assert.equal(still?.state, 'stopped_user');
  } finally {
    await harness.cleanup();
  }
});

test('duplicate evaluator replies are ignored, never double-dispatched', async () => {
  const harness = await makeHarness();
  try {
    harness.adapter.setFaults('sim-eval-progress', { replyMode: 'duplicate' });
    assert.equal(harness.coordinator.createProject(projectInput('p-dup')).ok, true);
    harness.coordinator.startProject('p-dup');
    // 重复回复不算新进展：要么等来新回复继续，要么轮超时暂停；两种情况都不允许重复派发。
    const settled = await waitFor(harness.coordinator, 'p-dup', (project) => project.state === 'paused' || project.roundIndex >= 1, 12_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const confirmed = harness.store.listIntents('p-dup', 50).filter((intent) => intent.target === 'executor' && intent.state === 'confirmed');
    const events = harness.coordinator.listEvents('p-dup', 100);
    if (settled.state === 'paused') {
      assert.ok(
        events.some((event) => event.type === 'duplicate_reply_ignored') || settled.pauseReason === 'round_timeout',
        `重复场景暂停原因：${settled.pauseReason}`,
      );
    }
    assert.ok(confirmed.length <= 1, '重复回复绝不导致重复派发');
    harness.coordinator.stopProject('p-dup');
  } finally {
    await harness.cleanup();
  }
});

test('79.9 vs 80: exact threshold comparison, no rounding to stop early', async () => {
  // 79.9 需要继续、80 停止：用自定义脚本驱动模拟 A。
  const dir = mkdtempSync(join(tmpdir(), 'lfrr-core-'));
  const db = createStore(dir);
  const store = new RecordStore(db.db);
  const adapter = new SimulatedAdapter([
    { sessionId: 'eval-boundary', label: '边界', role: 'evaluator', script: [
      { total: 79.9, basis: '接近阈值', missing: ['最后一项'], prompt: '请完成最后一项' },
      { total: 80, basis: '达标', missing: [], prompt: '收尾' },
    ] },
    { sessionId: 'exec-boundary', label: '执行', role: 'executor' },
  ], { replyDelayMs: 5 });
  const fakeModel = await startFakeModelServer();
  const model = new OllamaCoordinationModel(fakeModel.url, 'fake-qwen3:8b');
  const coordinator = new Coordinator({
    store, model, adapters: new Map([['simulated', adapter]]),
    modelQueue: new SerialQueue(), foregroundQueue: new ForegroundQueue(),
    workspaces: new WorkspaceRegistry(), sessions: new SessionRegistry(), mode: 'simulated', pollIntervalMs: 10,
  });
  try {
    const input = projectInput('p-bound', {
      evaluator: { productId: 'simulated', sessionId: 'eval-boundary', label: '边界A' },
      executor: { productId: 'simulated', sessionId: 'exec-boundary', label: '边界B' },
      stopThresholdPercent: 80,
    });
    assert.equal(coordinator.createProject(input).ok, true);
    coordinator.startProject('p-bound');
    const stopped = await waitFor(coordinator, 'p-bound', (project) => project.state === 'stopped_threshold', 12_000);
    assert.equal(stopped.roundIndex, 2, '79.9% 必须继续（第 2 轮 80% 才停）');
    assert.equal(store.latestEvaluation('p-bound')?.total_completeness, 80);
    coordinator.dispose();
  } finally {
    await fakeModel.close();
    db.close();
    tryBestEffortRemove(dir);
  }
});

test('resolveWorkspace merges alias separators and win32 case', () => {
  const resolved = resolveWorkspace(join('C:\\', 'Work', 'Demo'));
  assert.ok(resolved.workspaceKey.startsWith('ws:'));
  const trailing = resolveWorkspace(`${join('C:\\', 'Work', 'Demo')}\\`);
  assert.equal(trailing.workspaceKey, resolved.workspaceKey, '尾分隔符归并');
  if (process.platform === 'win32') {
    const upper = resolveWorkspace(join('C:\\', 'WORK', 'DEMO'));
    assert.equal(upper.workspaceKey, resolved.workspaceKey, 'win32 大小写归并');
  }
});
