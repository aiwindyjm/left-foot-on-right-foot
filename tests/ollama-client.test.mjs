// W3 Ollama 客户端测试：真实 HTTP 调用链路对本地假服务的成功/故障/超时行为。
// 证明客户端不是固定返回桩：连接错误、超时、非 JSON、HTTP 5xx、改写拒绝均有独立路径。
import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaClient } from '../dist/ollama/client.js';
import { OllamaCoordinationModel } from '../dist/ollama/model-service.js';
import { ModelError } from '../dist/shared/ai-contract.js';
import { startFakeModelServer } from '../dist/fake-model/fake-ollama-server.js';

const REPLY = [
  '本轮总体完成度：72.5%',
  '评估依据：主流程已通，剩余文档',
  '缺项：',
  '- 用户手册',
  '下一轮提示词：「请补齐用户手册」',
].join('\n');

test('client chat succeeds against fake ollama with structured extraction', async () => {
  const server = await startFakeModelServer();
  try {
    const model = new OllamaCoordinationModel(server.url, 'fake-qwen3:8b');
    const outcome = await model.understand(
      { goal: '目标', prdRef: 'prd', roundIndex: 1, reply: REPLY },
      3_000,
    );
    assert.equal(outcome.kind, 'evaluation');
    assert.equal(outcome.totalCompleteness, 72.5);
    assert.deepEqual(outcome.missingItems, ['用户手册']);
    assert.equal(outcome.nextPrompt, '请补齐用户手册');
  } finally {
    await server.close();
  }
});

test('client maps http 500 to MODEL_REJECTED', async () => {
  const server = await startFakeModelServer();
  try {
    server.setBehavior({ fault: 'http500' });
    const model = new OllamaCoordinationModel(server.url, 'fake-qwen3:8b');
    await assert.rejects(
      model.understand({ goal: 'g', prdRef: 'p', roundIndex: 1, reply: REPLY }, 3_000),
      (error) => error instanceof ModelError && error.code === 'MODEL_REJECTED',
    );
  } finally {
    await server.close();
  }
});

test('client maps non-json model output to MODEL_INVALID_OUTPUT', async () => {
  const server = await startFakeModelServer();
  try {
    server.setBehavior({ fault: 'invalid-json' });
    const model = new OllamaCoordinationModel(server.url, 'fake-qwen3:8b');
    await assert.rejects(
      model.understand({ goal: 'g', prdRef: 'p', roundIndex: 1, reply: REPLY }, 3_000),
      (error) => error instanceof ModelError && error.code === 'MODEL_INVALID_OUTPUT',
    );
  } finally {
    await server.close();
  }
});

test('client timeout maps to MODEL_TIMEOUT', async () => {
  const server = await startFakeModelServer();
  try {
    server.setBehavior({ delayMs: 1_200 });
    const model = new OllamaCoordinationModel(server.url, 'fake-qwen3:8b');
    await assert.rejects(
      model.understand({ goal: 'g', prdRef: 'p', roundIndex: 1, reply: REPLY }, 300),
      (error) => error instanceof ModelError && error.code === 'MODEL_TIMEOUT',
    );
  } finally {
    await server.close();
  }
});

test('connection refused maps to MODEL_UNREACHABLE', async () => {
  const server = await startFakeModelServer();
  const deadPort = server.port;
  await server.close();
  const model = new OllamaCoordinationModel(`http://127.0.0.1:${deadPort}`, 'fake');
  await assert.rejects(
    model.understand({ goal: 'g', prdRef: 'p', roundIndex: 1, reply: REPLY }, 1_500),
    (error) => error instanceof ModelError && error.code === 'MODEL_UNREACHABLE',
  );
});

test('endpoint validation rejects non-http schemes and invalid urls', () => {
  assert.throws(() => new OllamaClient('ftp://x'), /only http\/https/);
  assert.throws(() => new OllamaClient('not a url'), /invalid base url/);
  assert.doesNotThrow(() => new OllamaClient('http://127.0.0.1:11434'));
});

test('paraphrased nextPrompt is rejected by verbatim guard', async () => {
  const server = await startFakeModelServer();
  try {
    server.setBehavior({ fault: 'paraphrase' });
    const model = new OllamaCoordinationModel(server.url, 'fake-qwen3:8b');
    await assert.rejects(
      model.understand({ goal: 'g', prdRef: 'p', roundIndex: 1, reply: REPLY }, 3_000),
      (error) => error instanceof ModelError && error.code === 'MODEL_INVALID_OUTPUT'
        && error.message.includes('verbatim'),
    );
  } finally {
    await server.close();
  }
});

test('listModels reports fake model (health path)', async () => {
  const server = await startFakeModelServer('my-model:latest');
  try {
    const client = new OllamaClient(server.url);
    const models = await client.listModels(2_000);
    assert.deepEqual(models, ['my-model:latest']);
  } finally {
    await server.close();
  }
});

test('serial model queue runs one at a time and failures do not block later tasks', async () => {
  const { SerialQueue } = await import('../dist/core/queues.js');
  const queue = new SerialQueue();
  const order = [];
  const first = queue.submit({
    label: 'a', timeoutMs: 2_000,
    run: async () => {
      order.push('a-start');
      await new Promise((resolve) => setTimeout(resolve, 60));
      order.push('a-end');
      return 1;
    },
  });
  const second = queue.submit({
    label: 'b', timeoutMs: 2_000,
    run: async () => {
      order.push('b-start');
      throw new Error('boom');
    },
  });
  const third = queue.submit({
    label: 'c', timeoutMs: 2_000,
    run: async () => {
      order.push('c-start');
      return 3;
    },
  });
  assert.equal(await first, 1);
  await assert.rejects(second, /boom/);
  assert.equal(await third, 3);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'c-start'], '串行且互不阻塞');
});
