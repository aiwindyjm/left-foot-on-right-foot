// W2 契约测试：AI协调契约、项目配置校验、原生RPC线格式、状态机转移与服务协议信封。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseUnderstandOutcome, nextPromptMatchesSource, ModelError,
} from '../dist/shared/ai-contract.js';
import { validateProjectConfig, ProjectConfigError } from '../dist/shared/project-config.js';
import {
  isRpcMessage, encodeLine, NATIVE_METHODS, RpcErrorCode, MAX_LINE_BYTES,
} from '../dist/shared/native-rpc.js';
import { transitionAllowed, assertTransition } from '../dist/core/states.js';
import {
  makeCommandEnvelope, makeResultEnvelope, makeEventEnvelope, isServiceEnvelope,
} from '../dist/shared/service-protocol.js';

function baseConfig(overrides = {}) {
  return {
    projectId: 'proj-1',
    name: '示例项目',
    workspacePath: 'C:\\work\\demo',
    goal: '完成示例功能',
    prdRef: 'docs/PRD.md@1.6',
    evaluator: { productId: 'simulated', sessionId: 'eval-1', label: 'A' },
    executor: { productId: 'simulated', sessionId: 'exec-1', label: 'B' },
    stopThresholdPercent: 80,
    ...overrides,
  };
}

// ---- AI 协调契约 ----

test('valid evaluation extraction passes schema and normalizes', () => {
  const outcome = parseUnderstandOutcome({
    kind: 'evaluation',
    totalCompleteness: 79.9,
    basis: '核心功能完成，剩余发布项',
    missingItems: ['安装包验证'],
    nextPrompt: '请继续完成剩余发布项',
  });
  assert.equal(outcome.kind, 'evaluation');
  assert.equal(outcome.totalCompleteness, 79.9);
  assert.deepEqual(outcome.missingItems, ['安装包验证']);
});

test('clarify outcome parses', () => {
  const outcome = parseUnderstandOutcome({ kind: 'clarify', question: '请给出本轮总体完成度' });
  assert.equal(outcome.kind, 'clarify');
  assert.equal(outcome.question, '请给出本轮总体完成度');
});

const invalidOutcomes = [
  ['empty object', {}],
  ['unknown kind', { kind: 'rescore', totalCompleteness: 50 }],
  ['score out of range', { kind: 'evaluation', totalCompleteness: 101, basis: 'x', missingItems: [], nextPrompt: null }],
  ['negative score', { kind: 'evaluation', totalCompleteness: -1, basis: 'x', missingItems: [], nextPrompt: null }],
  ['missing basis', { kind: 'evaluation', totalCompleteness: 50, missingItems: [], nextPrompt: null }],
  ['empty nextPrompt', { kind: 'evaluation', totalCompleteness: 50, basis: 'x', missingItems: [], nextPrompt: '' }],
  ['clarify without question', { kind: 'clarify' }],
  ['array envelope', [{ kind: 'clarify', question: 'x' }]],
];

for (const [name, value] of invalidOutcomes) {
  test(`invalid extraction rejected: ${name}`, () => {
    assert.throws(() => parseUnderstandOutcome(value), (error) => {
      assert.ok(error instanceof ModelError);
      assert.equal(error.code, 'MODEL_INVALID_OUTPUT');
      return true;
    });
  });
}

test('model must not inject extra audit fields', () => {
  assert.throws(() => parseUnderstandOutcome({
    kind: 'evaluation',
    totalCompleteness: 60,
    basis: 'x',
    missingItems: [],
    nextPrompt: null,
    rescoredTotal: 90,
  }), /MODEL_INVALID_OUTPUT/);
});

test('nextPrompt must match reply source verbatim', () => {
  const reply = '目前完成度 65%。下一轮提示词：「请修复登录模块」';
  const hit = { kind: 'evaluation', totalCompleteness: 65, basis: 'b', missingItems: [], nextPrompt: '请修复登录模块' };
  const miss = { kind: 'evaluation', totalCompleteness: 65, basis: 'b', missingItems: [], nextPrompt: '请先把登录修好' };
  assert.equal(nextPromptMatchesSource(hit, reply), true);
  assert.equal(nextPromptMatchesSource(miss, reply), false);
  const nullPrompt = { kind: 'evaluation', totalCompleteness: 65, basis: 'b', missingItems: [], nextPrompt: null };
  assert.equal(nextPromptMatchesSource(nullPrompt, reply), true);
});

// ---- 项目配置校验 ----

test('valid project config passes and clones bindings', () => {
  const config = validateProjectConfig(baseConfig());
  assert.equal(config.stopThresholdPercent, 80);
  assert.equal(config.limits.maxClarifyPerRound, 2);
});

test('threshold must be explicit and within [0,100] (PRD 7.3 bounds inclusive)', () => {
  for (const threshold of [-5, 100.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => validateProjectConfig(baseConfig({ stopThresholdPercent: threshold })),
      (error) => error instanceof ProjectConfigError && (error.code === 'THRESHOLD_OUT_OF_RANGE' || error.code === 'THRESHOLD_MISSING'),
      `threshold ${threshold}`,
    );
  }
  assert.doesNotThrow(() => validateProjectConfig(baseConfig({ stopThresholdPercent: 100 })));
  assert.doesNotThrow(() => validateProjectConfig(baseConfig({ stopThresholdPercent: 0 })), '0 属于 PRD 0-100 合法边界');
  assert.doesNotThrow(() => validateProjectConfig(baseConfig({ stopThresholdPercent: 0.5 })));
  assert.throws(() => validateProjectConfig(baseConfig({ stopThresholdPercent: undefined })),
    /THRESHOLD_MISSING/);
});

test('evaluator and executor must not bind the same session (self loop)', () => {
  assert.throws(
    () => validateProjectConfig(baseConfig({
      evaluator: { productId: 'codex', sessionId: 's1', label: null },
      executor: { productId: 'codex', sessionId: 's1', label: null },
    })),
    /SESSION_SELF_LOOP/,
  );
  assert.doesNotThrow(() => validateProjectConfig(baseConfig({
    evaluator: { productId: 'codex', sessionId: 's1', label: null },
    executor: { productId: 'codex', sessionId: 's2', label: null },
  })));
});

test('goal/prdRef/name must be non-empty', () => {
  assert.throws(() => validateProjectConfig(baseConfig({ goal: '   ' })), /GOAL_EMPTY/);
  assert.throws(() => validateProjectConfig(baseConfig({ prdRef: '' })), /PRD_REF_EMPTY/);
  assert.throws(() => validateProjectConfig(baseConfig({ name: '' })), /NAME_EMPTY/);
});

// ---- 原生 RPC 线格式 ----

test('rpc messages validate method whitelist and shapes', () => {
  assert.equal(isRpcMessage({ jsonrpc: '2.0', id: 1, method: 'ping', params: null }), true);
  assert.equal(isRpcMessage({ jsonrpc: '2.0', id: 1, method: 'shell.exec', params: {} }), false);
  assert.equal(isRpcMessage({ jsonrpc: '2.0', id: 1, result: {} }), true);
  assert.equal(isRpcMessage({ jsonrpc: '2.0', id: null, error: { code: RpcErrorCode.INTERNAL_ERROR, message: 'x' } }), true);
  assert.equal(isRpcMessage({ jsonrpc: '1.0', id: 1, method: 'ping', params: null }), false);
  assert.equal(isRpcMessage({ id: 1, result: {} }), false);
  assert.equal(isRpcMessage(null), false);
});

test('all contract methods are in whitelist and no shell-like method exists', () => {
  assert.ok(NATIVE_METHODS.includes('uia.readText'));
  assert.ok(NATIVE_METHODS.every((method) => !method.startsWith('sys.') || ['sys.capabilities'].includes(method)));
});

test('encodeLine emits single NDJSON line (stringify escapes embedded newlines)', () => {
  const ok = encodeLine({ jsonrpc: '2.0', id: 1, method: 'ping', params: null });
  assert.ok(ok.endsWith('\n') && !ok.slice(0, -1).includes('\n'));
  const withNewline = encodeLine({ jsonrpc: '2.0', id: 2, method: 'ping', params: { text: 'a\nb' } });
  assert.ok(withNewline.endsWith('\n') && !withNewline.slice(0, -1).includes('\n'));
  assert.equal(typeof MAX_LINE_BYTES, 'number');
});

// ---- 状态机 ----

test('project state transitions follow contract', () => {
  assert.equal(transitionAllowed('created', 'running'), true);
  assert.equal(transitionAllowed('running', 'stopped_threshold'), true);
  assert.equal(transitionAllowed('running', 'paused'), true);
  assert.equal(transitionAllowed('paused', 'running'), true);
  // 达标停止是终态：调高阈值后不得自动复活（PRD 15）。
  assert.equal(transitionAllowed('stopped_threshold', 'running'), false);
  assert.throws(() => assertTransition('stopped_threshold', 'running'), /illegal/);
  assert.equal(transitionAllowed('created', 'stopped_threshold'), false);
  assert.equal(transitionAllowed('stopped_user', 'created'), true);
});

// ---- 服务协议信封 ----

test('service envelopes validate version and carry ids', () => {
  const command = makeCommandEnvelope(7, { kind: 'getState' });
  const result = makeResultEnvelope(7, { ok: true });
  const event = makeEventEnvelope({ kind: 'status', status: null });
  assert.equal(isServiceEnvelope(command), true);
  assert.equal(isServiceEnvelope(result), true);
  assert.equal(isServiceEnvelope(event), true);
  assert.equal(command.id, 7);
  assert.equal(isServiceEnvelope({ v: '0.9', id: 1, payload: {} }), false);
  assert.equal(isServiceEnvelope({ payload: {} }), false);
});
