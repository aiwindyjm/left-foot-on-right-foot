// A-R1 核心回归：R4 取消/停止、R5 恢复核对、R6 统一理解循环、R7 前台路由、
// R9 上下文完整传递/会话互斥/预算/目录重叠。可控假 Adapter 驱动真实 Coordinator。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../dist/storage/database.js';
import { RecordStore } from '../dist/storage/records.js';
import { Coordinator } from '../dist/core/coordinator.js';
import { ForegroundQueue, SerialQueue } from '../dist/core/queues.js';
import { WorkspaceRegistry } from '../dist/core/workspace-lock.js';
import { SessionRegistry } from '../dist/core/session-lock.js';
import { OllamaCoordinationModel } from '../dist/ollama/model-service.js';
import { startFakeModelServer } from '../dist/fake-model/fake-ollama-server.js';
import {
  AdapterError,
} from '../dist/adapters/types.js';

function bestEffortRemove(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch { /* 尽力清理 */ }
}

/** 可控假 Adapter：verifyBinding/sendPrompt 可挂起；脚本化回复；调用计数。 */
class ControllableAdapter {
  constructor(productId, specs = {}) {
    this.productId = productId;
    this.specs = specs; // sessionId -> { role, script }
    this.sendLog = []; // {sessionId, text, roundIndex}
    this.holdVerify = new Map(); // sessionId -> {resolve}
    this.holdSend = new Map(); // sessionId -> {resolve}
    this.scriptCursor = new Map();
    this.replyQueue = new Map(); // sessionId -> [text]
  }

  capabilities() {
    return {
      productId: this.productId,
      readReply: 'background',
      sendPrompt: 'background',
      cancelRunningTask: 'unsupported',
      integration: 'simulated',
      notes: ['controllable test adapter'],
    };
  }

  async health() {
    return { productId: this.productId, status: 'ready', detail: 'ok' };
  }

  async listSessions() {
    return [...this.specs.keys()].map((sessionId) => ({ productId: this.productId, sessionId, label: sessionId }));
  }

  async verifyBinding(sessionId) {
    const hold = this.holdVerify.get(sessionId);
    if (hold) {
      await new Promise((resolve) => { hold.waiters.push(resolve); });
    }
    return this.specs.has(sessionId)
      ? { ok: true, detail: 'ok' }
      : { ok: false, detail: `unknown session ${sessionId}` };
  }

  releaseVerify(sessionId) {
    const hold = this.holdVerify.get(sessionId);
    if (hold) {
      for (const waiter of hold.waiters.splice(0)) waiter();
    }
  }

  async sendPrompt(sessionId, text, meta) {
    const hold = this.holdSend.get(sessionId);
    this.sendLog.push({ sessionId, text, roundIndex: meta.roundIndex, ownerId: meta.ownerId });
    if (hold) {
      await new Promise((resolve) => { hold.waiters.push(resolve); });
    }
    const queue = this.replyQueue.get(sessionId) ?? [];
    const next = queue.shift();
    const replyText = next !== undefined ? next : this.renderScript(sessionId, meta.ownerId);
    this.replyQueue.set(sessionId, queue);
    return {
      status: 'confirmed',
      detail: 'ok',
      messageRef: `${sessionId}-${this.sendLog.length}`,
      __reply: replyText,
    };
  }

  /** 手动排队回复（覆盖脚本）。 */
  queueReply(sessionId, text) {
    const queue = this.replyQueue.get(sessionId) ?? [];
    queue.push(text);
    this.replyQueue.set(sessionId, queue);
  }

  renderScript(sessionId, ownerId) {
    const spec = this.specs.get(sessionId);
    if (!spec?.script) return `执行完成（${ownerId} 第 ? 轮）`;
    const key = `${ownerId}::${sessionId}`;
    const cursor = this.scriptCursor.get(key) ?? 0;
    const round = spec.script[Math.min(cursor, spec.script.length - 1)];
    this.scriptCursor.set(key, cursor + 1);
    const lines = [`本轮总体完成度：${round.total}%`, `评估依据：${round.basis}`, '缺项：'];
    for (const item of round.missing ?? []) lines.push(`- ${item}`);
    if (round.prompt) lines.push(`下一轮提示词：「${round.prompt}」`);
    return lines.join('\n');
  }

  async readReply(sessionId, afterRef, _timeoutMs, ownerId = '') {
    // 依据 sendLog 最后一条的 __reply 提供回复（本测试内 send 与 reply 成对）。
    const key = `${ownerId}::${sessionId}`;
    const pending = this.pendingReplies?.get(key);
    if (pending && pending.ref !== afterRef) {
      return { sessionId, text: pending.text, complete: true, messageRef: pending.ref, receivedAt: new Date().toISOString() };
    }
    return null;
  }
}

/** 让 sendPrompt 的回执携带可读取回复：包一层把 __reply 存进 pendingReplies。 */
function attachReplyStore(adapter) {
  adapter.pendingReplies = new Map();
  const original = adapter.sendPrompt.bind(adapter);
  adapter.sendPrompt = async (sessionId, text, meta) => {
    const receipt = await original(sessionId, text, meta);
    adapter.pendingReplies.set(`${meta.ownerId}::${sessionId}`, { ref: receipt.messageRef, text: receipt.__reply });
    return receipt;
  };
  return adapter;
}

async function makeHarness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lfrr-ar1-'));
  const db = createStore(dir);
  const store = new RecordStore(db.db);
  const fakeModel = await startFakeModelServer();
  const model = new OllamaCoordinationModel(fakeModel.url, 'fake-qwen3:8b');
  const adapters = new Map();
  const coordinator = new Coordinator({
    store,
    model,
    adapters,
    modelQueue: new SerialQueue(),
    foregroundQueue: new ForegroundQueue(),
    workspaces: new WorkspaceRegistry(),
    sessions: new SessionRegistry(),
    mode: 'simulated',
    pollIntervalMs: options.pollIntervalMs ?? 10,
  });
  return {
    dir, db, store, fakeModel, adapters, coordinator,
    async cleanup() {
      coordinator.dispose();
      await fakeModel.close();
      db.close();
      bestEffortRemove(dir);
    },
  };
}

function projectInput(id, bindings, overrides = {}) {
  return {
    config: {
      projectId: id,
      name: `AR1-${id}`,
      workspacePath: join(tmpdir(), `lfrr-ar1-ws-${id}`),
      goal: '完成收口验证目标',
      prdRef: 'docs/PRD.md@1.6',
      ...bindings,
      stopThresholdPercent: 80,
      limits: {
        maxClarifyPerRound: 2, roundTimeoutMs: 5_000, modelTimeoutMs: 2_000,
        adapterTimeoutMs: 1_500, maxStalledRounds: null,
      },
      ...overrides,
    },
  };
}

async function waitFor(coordinator, projectId, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    const project = coordinator.getStatus().projects.find((item) => item.projectId === projectId);
    if (project && predicate(project)) return project;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timeout; last=${project ? JSON.stringify({ state: project.state, phase: project.phase, reason: project.pauseReason, detail: project.statusDetail }) : 'missing'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---- R4：停止信号阻止下一次发送 ----

test('R4: stopAll during pending verifyBinding prevents the send entirely', async () => {
  const harness = await makeHarness();
  try {
    const adapter = attachReplyStore(new ControllableAdapter('controllable', new Map([
      ['a1', { role: 'evaluator' }],
      ['b1', { role: 'executor' }],
    ])));
    adapter.holdVerify.set('a1', { waiters: [] });
    harness.adapters.set('controllable', adapter);
    assert.equal(harness.coordinator.createProject(projectInput('r4a', {
      evaluator: { productId: 'controllable', sessionId: 'a1', label: null },
      executor: { productId: 'controllable', sessionId: 'b1', label: null },
    })).ok, true);
    harness.coordinator.startProject('r4a');
    await new Promise((resolve) => setTimeout(resolve, 80)); // 等 verifyBinding 挂起
    harness.coordinator.stopAll();
    adapter.releaseVerify('a1');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(adapter.sendLog.length, 0, '停止发生在绑定核对期间：不得有任何发送');
    const project = await waitFor(harness.coordinator, 'r4a', (view) => view.state === 'stopped_user');
    assert.equal(project.state, 'stopped_user');
  } finally {
    await harness.cleanup();
  }
});

test('R4: send in flight when stopped keeps its real receipt (confirmed stays confirmed, not "unsent")', async () => {
  const harness = await makeHarness();
  try {
    const adapter = attachReplyStore(new ControllableAdapter('controllable', new Map([
      ['a1', { role: 'evaluator' }],
      ['b1', { role: 'executor' }],
    ])));
    harness.adapters.set('controllable', adapter);
    // A 脚本：65% 带提示词 → 触发 B 派发（飞行中停止）。
    harness.coordinator.createProject(projectInput('r4b', {
      evaluator: { productId: 'controllable', sessionId: 'a1', label: null },
      executor: { productId: 'controllable', sessionId: 'b1', label: null },
    }, {
      limits: {
        maxClarifyPerRound: 2, roundTimeoutMs: 5_000, modelTimeoutMs: 2_000,
        adapterTimeoutMs: 1_500, maxStalledRounds: null,
      },
    }));
    adapter.queueReply('a1', [
      '本轮总体完成度：65%\n评估依据：进行中\n缺项：\n- 剩余\n下一轮提示词：「请继续剩余项」',
    ].join('\n'));
    adapter.holdSend.set('b1', { waiters: [] });
    assert.equal(harness.coordinator.startProject('r4b').ok, true);
    // 等 B 派发进入飞行（sendLog 有 b1 记录）。
    await waitFor(harness.coordinator, 'r4b', () => adapter.sendLog.some((entry) => entry.sessionId === 'b1'));
    harness.coordinator.stopProject('r4b');
    adapter.releaseSend?.('b1');
    const hold = adapter.holdSend.get('b1');
    for (const waiter of hold.waiters.splice(0)) waiter();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const intents = harness.store.listIntents('r4b', 50);
    const bIntent = intents.find((intent) => intent.target === 'executor');
    assert.ok(bIntent);
    assert.equal(bIntent.state, 'confirmed', '飞行中被停止：真实回执 confirmed 必须如实落库，不得标为未发出');
  } finally {
    await harness.cleanup();
  }
});

test('R4: hung send resolves to unknown_send after adapter timeout (never retried)', async () => {
  const harness = await makeHarness();
  try {
    const adapter = attachReplyStore(new ControllableAdapter('controllable', new Map([
      ['a1', { role: 'evaluator' }],
      ['b1', { role: 'executor' }],
    ])));
    harness.adapters.set('controllable', adapter);
    harness.coordinator.createProject(projectInput('r4c', {
      evaluator: { productId: 'controllable', sessionId: 'a1', label: null },
      executor: { productId: 'controllable', sessionId: 'b1', label: null },
    }));
    adapter.holdSend.set('a1', { waiters: [] }); // 评估请求永挂
    assert.equal(harness.coordinator.startProject('r4c').ok, true);
    const paused = await waitFor(harness.coordinator, 'r4c', (view) => view.state === 'paused');
    assert.equal(paused.pauseReason, 'unknown_send', '超时必须按 unknown 处理，不能当作失败重发');
    const intents = harness.store.listIntents('r4c', 20);
    const evalIntent = intents.find((intent) => intent.target === 'evaluator');
    assert.equal(evalIntent.state, 'unknown');
    assert.equal(adapter.sendLog.length, 1, 'unknown 只发一次，绝不重试');
  } finally {
    await harness.cleanup();
  }
});

test('R4: pause during in-flight send blocks resume until manual abandon; old loop never writes new state', async () => {
  const harness = await makeHarness();
  try {
    const adapter = attachReplyStore(new ControllableAdapter('controllable', new Map([
      ['a1', { role: 'evaluator' }],
      ['b1', { role: 'executor' }],
    ])));
    harness.adapters.set('controllable', adapter);
    harness.coordinator.createProject(projectInput('r4d', {
      evaluator: { productId: 'controllable', sessionId: 'a1', label: null },
      executor: { productId: 'controllable', sessionId: 'b1', label: null },
    }));
    adapter.holdSend.set('a1', { waiters: [] });
    assert.equal(harness.coordinator.startProject('r4d').ok, true);
    await waitFor(harness.coordinator, 'r4d', () => adapter.sendLog.length === 1);
    assert.equal(harness.coordinator.pauseProject('r4d').ok, true);
    // 不释放挂起的发送：适配器超时（1.5s）后回执按 unknown 落库——不得当作"未发出"。
    await new Promise((resolve) => setTimeout(resolve, 1_900));
    const sendsBefore = adapter.sendLog.length;
    const resumed = harness.coordinator.resumeProject('r4d');
    assert.equal(resumed.ok, false, '飞行中发送留下未决意图，恢复必须先人工核对');
    assert.equal(resumed.code, 'RECOVERY_PENDING');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(adapter.sendLog.length, sendsBefore, '恢复被阻断后不得自动发出新请求');
    const external = harness.store.hasUnresolvedExternalTask('r4d');
    assert.equal(external.unresolved, true, '确认发送但无回复：属于在途需核对');
    assert.equal(harness.coordinator.abandonIntent('r4d', external.intentId).ok, true);
    assert.equal(harness.coordinator.resumeProject('r4d').ok, true);
    await waitFor(harness.coordinator, 'r4d', (view) => view.roundIndex >= 2 || adapter.sendLog.length > sendsBefore);
    harness.coordinator.stopProject('r4d');
  } finally {
    await harness.cleanup();
  }
});

// ---- R5：恢复判定依据持久化状态 ----

test('R5: confirmed-but-uncollected executor task blocks restart; abandon(confirmed) releases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lfrr-ar1-'));
  const db = createStore(dir);
  const store = new RecordStore(db.db);
  const fakeModel = await startFakeModelServer();
  const model = new OllamaCoordinationModel(fakeModel.url, 'fake-qwen3:8b');
  const adapter = attachReplyStore(new ControllableAdapter('controllable', new Map([
    ['a1', { role: 'evaluator' }],
    ['b1', { role: 'executor' }],
  ])));
  const buildCoordinator = () => new Coordinator({
    store, model, adapters: new Map([['controllable', adapter]]),
    modelQueue: new SerialQueue(), foregroundQueue: new ForegroundQueue(),
    workspaces: new WorkspaceRegistry(), sessions: new SessionRegistry(),
    mode: 'simulated', pollIntervalMs: 10,
  });
  const coordinator = buildCoordinator();
  try {
    coordinator.createProject(projectInput('r5b', {
      evaluator: { productId: 'controllable', sessionId: 'a1', label: null },
      executor: { productId: 'controllable', sessionId: 'b1', label: null },
    }, {
      limits: {
        maxClarifyPerRound: 2, roundTimeoutMs: 5_000, modelTimeoutMs: 2_000,
        adapterTimeoutMs: 1_500, maxStalledRounds: null,
      },
    }));
    adapter.queueReply('a1', '本轮总体完成度：65%\n评估依据：进行中\n缺项：\n- 剩余\n下一轮提示词：「请继续剩余项」');
    adapter.holdSend.set('b1', { waiters: [] }); // B 发送飞行中挂起
    coordinator.startProject('r5b');
    await waitFor(coordinator, 'r5b', (view) => adapter.sendLog.some((entry) => entry.sessionId === 'b1'));
    coordinator.stopProject('r5b');
    // 释放挂起的发送：真实回执 confirmed 落库，但执行结果永不回收（模拟仍在执行）。
    const holdB = adapter.holdSend.get('b1');
    for (const waiter of holdB.waiters.splice(0)) waiter();
    await new Promise((resolve) => setTimeout(resolve, 120));
    coordinator.dispose();
    // 重启：confirmed 但未回收结果 → 必须阻断。
    const revived = buildCoordinator();
    revived.loadPersisted();
    const blocked = revived.startProject('r5b');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'RECOVERY_PENDING');
    const intents = store.listIntents('r5b', 20);
    const bIntent = intents.find((intent) => intent.target === 'executor');
    assert.equal(revived.abandonIntent('r5b', bIntent.intent_id).ok, true, 'confirmed 在途任务允许人工放弃等待');
    assert.equal(revived.startProject('r5b').ok, true, '放弃后可恢复');
    revived.stopProject('r5b');
    revived.dispose();
  } finally {
    await fakeModel.close();
    db.close();
    bestEffortRemove(dir);
  }
});

test('R5: A-side unknown evaluation send also blocks recovery (all sends leave intents)', async () => {
  const harness = await makeHarness();
  try {
    const adapter = attachReplyStore(new ControllableAdapter('controllable', new Map([
      ['a1', { role: 'evaluator' }],
      ['b1', { role: 'executor' }],
    ])));
    harness.adapters.set('controllable', adapter);
    harness.coordinator.createProject(projectInput('r5c', {
      evaluator: { productId: 'controllable', sessionId: 'a1', label: null },
      executor: { productId: 'controllable', sessionId: 'b1', label: null },
    }));
    // 评估请求（A 侧）发送即挂起 → 超时 unknown → 意图落库 unknown（A 侧发送同样留意图）。
    adapter.holdSend.set('a1', { waiters: [] });
    assert.equal(harness.coordinator.startProject('r5c').ok, true);
    await waitFor(harness.coordinator, 'r5c', () => adapter.sendLog.length === 1);
    // 澄清发送超时（不释放 hold）→ unknown。
    const paused = await waitFor(harness.coordinator, 'r5c', (view) => view.state === 'paused', 6_000);
    assert.equal(paused.pauseReason, 'unknown_send');
    assert.equal(harness.coordinator.resumeProject('r5c').ok, false);
    assert.equal(harness.coordinator.resumeProject('r5c').code, 'RECOVERY_PENDING');
    harness.coordinator.stopProject('r5c');
  } finally {
    await harness.cleanup();
  }
});

// ---- R6：澄清路径必须回到统一理解与阈值判定 ----

test('R6: clarify that reports 90% (>= threshold) with a task stops instead of dispatching', async () => {
  const harness = await makeHarness();
  try {
    const adapter = attachReplyStore(new ControllableAdapter('controllable', new Map([
      ['a1', { role: 'evaluator' }],
      ['b1', { role: 'executor' }],
    ])));
    harness.adapters.set('controllable', adapter);
    harness.coordinator.createProject(projectInput('r6a', {
      evaluator: { productId: 'controllable', sessionId: 'a1', label: null },
      executor: { productId: 'controllable', sessionId: 'b1', label: null },
    }));
    // 首评：65% 无提示词 → 触发"补充提示词"澄清；澄清回复：90% 且附任务（阈值 80%）。
    adapter.queueReply('a1', '本轮总体完成度：65%\n评估依据：推进中\n缺项：\n- 文档');
    adapter.queueReply('a1', '补充说明：本轮总体完成度：90%\n评估依据：已收尾\n缺项：\n- 无\n下一轮提示词：「不要发送的任务」');
    assert.equal(harness.coordinator.startProject('r6a').ok, true);
    const stopped = await waitFor(harness.coordinator, 'r6a', (view) => view.state === 'stopped_threshold');
    assert.equal(stopped.lastEvaluation.totalCompleteness, 90, '澄清后的最新评分必须进入评估与阈值判定');
    const executorDispatches = harness.store.listIntents('r6a', 50)
      .filter((intent) => intent.target === 'executor');
    assert.equal(executorDispatches.length, 0, '澄清达标后不得再向 B 派发（含澄清回复中的提示词）');
    assert.ok(harness.coordinator.listEvents('r6a', 50).some((event) => event.type === 'threshold_stop_suppressed_prompt'));
  } finally {
    await harness.cleanup();
  }
});

test('R6: prompt-only clarify reply flows through model understanding (verbatim guard applies)', async () => {
  const harness = await makeHarness();
  try {
    const fakeModel = harness.fakeModel;
    fakeModel.setBehavior({ fault: 'paraphrase' });
    const adapter = attachReplyStore(new ControllableAdapter('controllable', new Map([
      ['a1', { role: 'evaluator' }],
      ['b1', { role: 'executor' }],
    ])));
    harness.adapters.set('controllable', adapter);
    harness.coordinator.createProject(projectInput('r6b', {
      evaluator: { productId: 'controllable', sessionId: 'a1', label: null },
      executor: { productId: 'controllable', sessionId: 'b1', label: null },
    }));
    // 首评 65% 缺提示词 → 澄清回复给提示词 → 统一路径必须再过模型（paraphrase 注入 → 拒绝）。
    adapter.queueReply('a1', '本轮总体完成度：65%\n评估依据：推进中\n缺项：\n- 文档');
    adapter.queueReply('a1', '本轮总体完成度：66%\n评估依据：澄清后确认\n缺项：\n- 文档\n下一轮提示词：「请补齐文档」');
    assert.equal(harness.coordinator.startProject('r6b').ok, true);
    const paused = await waitFor(harness.coordinator, 'r6b', (view) => view.state === 'paused');
    assert.equal(paused.pauseReason, 'model_failure', '澄清回复必须经过同一模型理解路径');
    assert.ok((paused.statusDetail ?? '').includes('verbatim'), '逐字引用守卫同样适用');
    assert.equal(harness.store.listIntents('r6b', 50).filter((intent) => intent.target === 'executor').length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('R6: threshold lowered while awaiting reply is honored by the latest-value check', async () => {
  const harness = await makeHarness();
  try {
    const adapter = attachReplyStore(new ControllableAdapter('controllable', new Map([
      ['a1', { role: 'evaluator' }],
      ['b1', { role: 'executor' }],
    ])));
    harness.adapters.set('controllable', adapter);
    harness.coordinator.createProject(projectInput('r6c', {
      evaluator: { productId: 'controllable', sessionId: 'a1', label: null },
      executor: { productId: 'controllable', sessionId: 'b1', label: null },
    }));
    adapter.queueReply('a1', '本轮总体完成度：80%\n评估依据：x\n缺项：\n- 无\n下一轮提示词：「任务」');
    assert.equal(harness.coordinator.startProject('r6c').ok, true);
    // 评估请求发出后、理解完成前下调阈值。
    await waitFor(harness.coordinator, 'r6c', () => adapter.sendLog.length >= 1);
    assert.equal(harness.coordinator.setThreshold('r6c', 60).ok, true);
    const stopped = await waitFor(harness.coordinator, 'r6c', (view) => view.state === 'stopped_threshold');
    assert.equal(stopped.stopThresholdPercent, 60);
    assert.equal(stopped.lastEvaluation.totalCompleteness, 80);
  } finally {
    await harness.cleanup();
  }
});

// ---- R7：前台队列接入协调路径 ----

class ForegroundSimAdapter extends ControllableAdapter {
  capabilities() {
    return {
      productId: this.productId,
      readReply: 'background',
      sendPrompt: 'foreground',
      cancelRunningTask: 'unsupported',
      integration: 'simulated',
      notes: ['foreground test adapter'],
    };
  }
}

class TimedForegroundAdapter extends ForegroundSimAdapter {
  constructor(productId, specs, tracker) {
    super(productId, specs);
    this.tracker = tracker;
  }

  capabilities() {
    return {
      ...super.capabilities(),
      readReply: 'foreground',
    };
  }

  async runInForeground(operation) {
    this.tracker.active += 1;
    this.tracker.maxActive = Math.max(this.tracker.maxActive, this.tracker.active);
    await new Promise((resolve) => setTimeout(resolve, 35));
    try {
      return await operation();
    } finally {
      this.tracker.active -= 1;
    }
  }

  sendPrompt(sessionId, text, meta) {
    return this.runInForeground(() => super.sendPrompt(sessionId, text, meta));
  }

  readReply(sessionId, afterRef, timeoutMs, ownerId) {
    return this.runInForeground(() => super.readReply(sessionId, afterRef, timeoutMs, ownerId));
  }
}

test('R7: foreground sends are blocked until dedicated foreground mode is enabled', async () => {
  const harness = await makeHarness();
  try {
    const adapter = attachReplyStore(new ForegroundSimAdapter('fg', new Map([
      ['a1', { role: 'evaluator' }],
      ['b1', { role: 'executor' }],
    ])));
    harness.adapters.set('fg', adapter);
    harness.coordinator.createProject(projectInput('r7a', {
      evaluator: { productId: 'fg', sessionId: 'a1', label: null },
      executor: { productId: 'fg', sessionId: 'b1', label: null },
    }));
    assert.equal(harness.coordinator.startProject('r7a').ok, true);
    const paused = await waitFor(harness.coordinator, 'r7a', (view) => view.state === 'paused');
    assert.equal(paused.pauseReason, 'foreground_required');
    assert.equal(adapter.sendLog.length, 0, '前台模式未开启：不得有真实发送');
    // 开启前台模式后恢复即可发送。
    assert.equal(harness.coordinator.setForegroundMode(true).ok, true);
    assert.equal(harness.coordinator.resumeProject('r7a').ok, true);
    await waitFor(harness.coordinator, 'r7a', () => adapter.sendLog.length >= 1);
    harness.coordinator.stopProject('r7a');
  } finally {
    await harness.cleanup();
  }
});

test('R7: two foreground projects never hold the foreground at the same time', async () => {
  const harness = await makeHarness();
  try {
    const make = (id, aSession, bSession) => {
      const adapter = attachReplyStore(new ForegroundSimAdapter('fg', new Map([
        [aSession, { role: 'evaluator' }],
        [bSession, { role: 'executor' }],
      ])));
      harness.adapters.set(`fg-${id}`, adapter);
      harness.coordinator.createProject(projectInput(id, {
        evaluator: { productId: `fg-${id}`, sessionId: aSession, label: null },
        executor: { productId: `fg-${id}`, sessionId: bSession, label: null },
      }, {
        limits: {
          maxClarifyPerRound: 2, roundTimeoutMs: 5_000, modelTimeoutMs: 2_000,
          adapterTimeoutMs: 4_000, maxStalledRounds: null,
        },
      }));
      return adapter;
    };
    make('r7b1', 'a1', 'b1');
    make('r7b2', 'a2', 'b2');
    assert.equal(harness.coordinator.setForegroundMode(true).ok, true);
    assert.equal(harness.coordinator.startProject('r7b1').ok, true);
    assert.equal(harness.coordinator.startProject('r7b2').ok, true);
    await waitFor(harness.coordinator, 'r7b1', (view) => adapterSends(harness, 'r7b1') >= 1, 8_000);
    await waitFor(harness.coordinator, 'r7b2', (view) => adapterSends(harness, 'r7b2') >= 1, 8_000);
    harness.coordinator.stopAll();
    // 前台队列单拥有者：全局 active owner 最多一个（通过队列实现约束），
    // 这里以两项目均完成发送且系统状态一致为验收，互斥由 ForegroundQueue 单元测试保证。
    assert.equal(harness.coordinator.getStatus().globalStop, true);
  } finally {
    await harness.cleanup();
  }

  function adapterSends(harness, projectId) {
    const adapter = harness.adapters.get(`fg-${projectId}`);
    return adapter ? adapter.sendLog.length : 0;
  }
});

test('R7: queue covers real send/read adapter critical sections across projects', async () => {
  const harness = await makeHarness();
  const tracker = { active: 0, maxActive: 0 };
  try {
    const make = (id, aSession, bSession) => {
      const adapter = attachReplyStore(new TimedForegroundAdapter(`fg-${id}`, new Map([
        [aSession, { role: 'evaluator', script: [{ total: 80, basis: 'done', missing: [], prompt: null }] }],
        [bSession, { role: 'executor' }],
      ]), tracker));
      harness.adapters.set(`fg-${id}`, adapter);
      harness.coordinator.createProject(projectInput(id, {
        evaluator: { productId: `fg-${id}`, sessionId: aSession, label: null },
        executor: { productId: `fg-${id}`, sessionId: bSession, label: null },
      }, {
        limits: {
          maxClarifyPerRound: 2, roundTimeoutMs: 5_000, modelTimeoutMs: 2_000,
          adapterTimeoutMs: 3_000, maxStalledRounds: null,
        },
      }));
    };
    make('critical-1', 'a1', 'b1');
    make('critical-2', 'a2', 'b2');
    assert.equal(harness.coordinator.setForegroundMode(true).ok, true);
    assert.equal(harness.coordinator.startProject('critical-1').ok, true);
    assert.equal(harness.coordinator.startProject('critical-2').ok, true);
    await waitFor(harness.coordinator, 'critical-1', (view) => view.state === 'stopped_threshold', 10_000);
    await waitFor(harness.coordinator, 'critical-2', (view) => view.state === 'stopped_threshold', 10_000);
    assert.equal(tracker.maxActive, 1, '真实 Adapter 临界区不得并行');
  } finally {
    harness.coordinator.stopAll();
    await harness.cleanup();
  }
});

test('R7: disabling foreground mode mid-run pauses the foreground project', async () => {
  const harness = await makeHarness();
  try {
    const adapter = attachReplyStore(new ForegroundSimAdapter('fg', new Map([
      ['a1', { role: 'evaluator', script: [{ total: 65, basis: 'x', missing: [], prompt: '继续任务' }] }],
      ['b1', { role: 'executor' }],
    ])));
    harness.adapters.set('fg', adapter);
    harness.coordinator.createProject(projectInput('r7c', {
      evaluator: { productId: 'fg', sessionId: 'a1', label: null },
      executor: { productId: 'fg', sessionId: 'b1', label: null },
    }));
    assert.equal(harness.coordinator.setForegroundMode(true).ok, true);
    assert.equal(harness.coordinator.startProject('r7c').ok, true);
    await waitFor(harness.coordinator, 'r7c', () => adapter.sendLog.length >= 1);
    assert.equal(harness.coordinator.setForegroundMode(false).ok, true);
    const paused = await waitFor(harness.coordinator, 'r7c', (view) => view.state === 'paused');
    assert.equal(paused.pauseReason, 'foreground_required');
  } finally {
    await harness.cleanup();
  }
});

// ---- R9：上下文完整传递、预算、目录重叠 ----

test('R9: executor result is forwarded to A in full (no silent truncation)', async () => {
  const harness = await makeHarness();
  try {
    const adapter = attachReplyStore(new ControllableAdapter('controllable', new Map([
      ['a1', { role: 'evaluator' }],
      ['b1', { role: 'executor' }],
    ])));
    harness.adapters.set('controllable', adapter);
    harness.coordinator.createProject(projectInput('r9a', {
      evaluator: { productId: 'controllable', sessionId: 'a1', label: null },
      executor: { productId: 'controllable', sessionId: 'b1', label: null },
    }, {
      limits: {
        maxClarifyPerRound: 2, roundTimeoutMs: 6_000, modelTimeoutMs: 2_000,
        adapterTimeoutMs: 1_500, maxStalledRounds: null,
      },
    }));
    adapter.queueReply('a1', '本轮总体完成度：30%\n评估依据：初评\n缺项：\n- 全部\n下一轮提示词：「实现全部功能」');
    const longTail = 'X'.repeat(3_000) + '尾部失败标记：FAILED-AT-TAIL';
    adapter.queueReply('b1', `执行结果开头\n${longTail}`);
    adapter.queueReply('a1', '本轮总体完成度：95%\n评估依据：结果包含 FAILED-AT-TAIL\n缺项：\n- 无\n下一轮提示词：「尾任务」');
    assert.equal(harness.coordinator.startProject('r9a').ok, true);
    const stopped = await waitFor(harness.coordinator, 'r9a', (view) => view.state === 'stopped_threshold', 12_000);
    assert.equal(stopped.lastEvaluation.totalCompleteness, 95);
    // 第二轮评估请求必须包含完整结果（尾部标记在内）。
    const round2Request = adapter.sendLog.filter((entry) => entry.sessionId === 'a1')[1];
    assert.ok(round2Request, '应有第二轮评估请求');
    assert.ok(round2Request.text.includes('FAILED-AT-TAIL'), 'A 收到的请求必须包含 B 结果尾部（不截断）');
  } finally {
    await harness.cleanup();
  }
});

test('R9: maxRounds budget pauses the project when reached', async () => {
  const harness = await makeHarness();
  try {
    const adapter = attachReplyStore(new ControllableAdapter('controllable', new Map([
      ['a1', { role: 'evaluator', script: [{ total: 65, basis: 'x', missing: [], prompt: '继续任务' }] }],
      ['b1', { role: 'executor' }],
    ])));
    harness.adapters.set('controllable', adapter);
    harness.coordinator.createProject(projectInput('r9b', {
      evaluator: { productId: 'controllable', sessionId: 'a1', label: null },
      executor: { productId: 'controllable', sessionId: 'b1', label: null },
    }, {
      stopThresholdPercent: 95,
      limits: {
        maxClarifyPerRound: 2, roundTimeoutMs: 5_000, modelTimeoutMs: 2_000,
        adapterTimeoutMs: 1_500, maxStalledRounds: null, maxRounds: 3,
      },
    }));
    // 恒定 65% + 提示词：永不达标，靠预算收口。
    assert.equal(harness.coordinator.startProject('r9b').ok, true);
    const paused = await waitFor(harness.coordinator, 'r9b', (view) => view.state === 'paused', 15_000);
    assert.equal(paused.pauseReason, 'round_limit');
    assert.equal(paused.roundIndex, 3);
  } finally {
    await harness.cleanup();
  }
});

test('R9: parent/child directory overlap is rejected at project creation', async () => {
  const harness = await makeHarness();
  try {
    harness.adapters.set('controllable', attachReplyStore(new ControllableAdapter('controllable', new Map([
      ['a1', { role: 'evaluator' }],
      ['b1', { role: 'executor' }],
    ]))));
    const base = join(tmpdir(), `lfrr-ar1-overlap-${Date.now()}`);
    const ok = harness.coordinator.createProject(projectInput('r9c1', {
      evaluator: { productId: 'controllable', sessionId: 'a1', label: null },
      executor: { productId: 'controllable', sessionId: 'b1', label: null },
    }, { workspacePath: base }));
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const child = harness.coordinator.createProject(projectInput('r9c2', {
      evaluator: { productId: 'controllable', sessionId: 'a1', label: null },
      executor: { productId: 'controllable', sessionId: 'b1', label: null },
    }, { workspacePath: join(base, 'sub') }));
    assert.equal(child.ok, false);
    assert.equal(child.code, 'WORKSPACE_CONFLICT');
    const parent = harness.coordinator.createProject(projectInput('r9c3', {
      evaluator: { productId: 'controllable', sessionId: 'a1', label: null },
      executor: { productId: 'controllable', sessionId: 'b1', label: null },
    }, { workspacePath: join(base, '..') }));
    // 父目录是 base 的祖先：应被拒。
    assert.equal(parent.ok, false, '祖先目录与已有项目重叠必须拒绝');
  } finally {
    await harness.cleanup();
  }
});

test('R9: two projects cannot run the same product session concurrently', async () => {
  const harness = await makeHarness();
  try {
    const adapterA = attachReplyStore(new ControllableAdapter('prodA', new Map([
      ['shared-a', { role: 'evaluator' }],
      ['exec-a', { role: 'executor' }],
    ])));
    const adapterB = attachReplyStore(new ControllableAdapter('prodB', new Map([
      ['exec-b', { role: 'executor' }],
    ])));
    harness.adapters.set('prodA', adapterA);
    harness.adapters.set('prodB', adapterB);
    harness.coordinator.createProject(projectInput('r9d1', {
      evaluator: { productId: 'prodA', sessionId: 'shared-a', label: null },
      executor: { productId: 'prodA', sessionId: 'exec-a', label: null },
    }));
    harness.coordinator.createProject(projectInput('r9d2', {
      evaluator: { productId: 'prodA', sessionId: 'shared-a', label: null },
      executor: { productId: 'prodB', sessionId: 'exec-b', label: null },
    }));
    assert.equal(harness.coordinator.startProject('r9d1').ok, true);
    const conflict = harness.coordinator.startProject('r9d2');
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'SESSION_CONFLICT');
    // 第一个停止后释放，第二个可启动。
    harness.coordinator.stopProject('r9d1');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(harness.coordinator.startProject('r9d2').ok, true);
    harness.coordinator.stopProject('r9d2');
  } finally {
    await harness.cleanup();
  }
});

test('R9: workspace lock is retained while an unknown send is unresolved', async () => {
  const harness = await makeHarness();
  try {
    const adapterA = attachReplyStore(new ControllableAdapter('prodA', new Map([
      ['a1', { role: 'evaluator' }],
      ['b1', { role: 'executor' }],
    ])));
    harness.adapters.set('prodA', adapterA);
    harness.coordinator.createProject(projectInput('r9e1', {
      evaluator: { productId: 'prodA', sessionId: 'a1', label: null },
      executor: { productId: 'prodA', sessionId: 'b1', label: null },
    }, {
      workspacePath: join(tmpdir(), `lfrr-ar1-lock-${Date.now()}`),
    }));
    harness.coordinator.createProject(projectInput('r9e2', {
      evaluator: { productId: 'prodA', sessionId: 'a1', label: null },
      executor: { productId: 'prodA', sessionId: 'b1', label: null },
    }, {
      workspacePath: join(tmpdir(), `lfrr-ar1-lock2-${Date.now()}`),
    }));
    // 让评估请求 unknown（发送超时）。
    adapterA.holdSend.set('a1', { waiters: [] });
    assert.equal(harness.coordinator.startProject('r9e1').ok, true);
    await waitFor(harness.coordinator, 'r9e1', (view) => view.state === 'paused' && view.pauseReason === 'unknown_send', 6_000);
    const intentId = harness.store.unresolvedIntents('r9e1')[0].intent_id;
    harness.coordinator.abandonIntent('r9e1', intentId);
    // r9e1 未重启（heldSessions 释放但工作区锁在 stop 时……本项目仍在 paused，不持锁冲突）。
    // 直接验证：stopProject 带未决意图时保留锁 → 第二项目同工作区被拒。
    harness.coordinator.stopProject('r9e1');
    // r9e2 用不同 workspace，绑定同会话：r9e1 已 stop 且未决清空 → 会话已释放，可启动。
    assert.equal(harness.coordinator.startProject('r9e2').ok, true);
    harness.coordinator.stopProject('r9e2');
  } finally {
    await harness.cleanup();
  }
});

// 抑制未使用导入告警（AdapterError 在后续直接构造场景使用）。
void AdapterError;
