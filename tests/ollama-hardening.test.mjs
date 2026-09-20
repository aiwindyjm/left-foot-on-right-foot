// R8 回归：Ollama 客户端边界——正文阶段期限、流式体积限制、本机端点、
// 完成态/模型身份校验、重复键拒绝、取消不发请求。全部走本地假 HTTP，不调用真实模型。
import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaClient, OllamaHttpError, OllamaProtocolError } from '../dist/ollama/client.js';
import { OllamaCoordinationModel } from '../dist/ollama/model-service.js';
import { ModelError } from '../dist/shared/ai-contract.js';
import { startFakeModelServer } from '../dist/fake-model/fake-ollama-server.js';

const REPLY = '本轮总体完成度：70%\n评估依据：测试\n缺项：\n- 无\n下一轮提示词：「继续」';

test('slow body after headers: timeout still enforced (R8 body-phase deadline)', async () => {
  const server = await startFakeModelServer();
  try {
    server.setBehavior({ bodyDelayMs: 900 });
    const model = new OllamaCoordinationModel(server.url, 'fake-qwen3:8b');
    const started = Date.now();
    await assert.rejects(
      model.understand({ goal: 'g', prdRef: 'p', roundIndex: 1, reply: REPLY }, 200),
      (error) => error instanceof ModelError && error.code === 'MODEL_TIMEOUT',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 800, `body 阶段超时应约 200ms 生效，实际 ${elapsed}ms`);
  } finally {
    await server.close();
  }
});

test('oversized body is aborted at byte limit, not fully buffered', async () => {
  const server = await startFakeModelServer();
  try {
    server.setBehavior({ bigBodyBytes: 20 * 1024 * 1024 });
    const client = new OllamaClient(server.url);
    await assert.rejects(
      client.chat({ model: 'fake-qwen3:8b', messages: [{ role: 'user', content: 'x' }], timeoutMs: 15_000 }),
      (error) => error instanceof OllamaHttpError && error.status === 413,
    );
  } finally {
    await server.close();
  }
});

test('remote (non-local) endpoint is rejected at construction', () => {
  assert.throws(() => new OllamaClient('https://example.com'), /must be local/);
  assert.throws(() => new OllamaClient('http://192.168.1.10:11434'), /must be local/);
  assert.doesNotThrow(() => new OllamaClient('http://localhost:11434'));
  assert.doesNotThrow(() => new OllamaClient('http://127.0.0.1:11434'));
});

test('endpoint with credentials is rejected', () => {
  assert.throws(() => new OllamaClient('http://user:pass@127.0.0.1:11434'), /credentials/);
});

test('done=false (truncated generation) is refused', async () => {
  const server = await startFakeModelServer();
  try {
    server.setBehavior({ doneFalse: true });
    const model = new OllamaCoordinationModel(server.url, 'fake-qwen3:8b');
    await assert.rejects(
      model.understand({ goal: 'g', prdRef: 'p', roundIndex: 1, reply: REPLY }, 3_000),
      (error) => error instanceof ModelError
        && error.code === 'MODEL_REJECTED'
        && error.message.includes('done=false'),
    );
  } finally {
    await server.close();
  }
});

test('model identity mismatch is refused', async () => {
  const server = await startFakeModelServer();
  try {
    server.setBehavior({ modelMismatch: true });
    const model = new OllamaCoordinationModel(server.url, 'fake-qwen3:8b');
    await assert.rejects(
      model.understand({ goal: 'g', prdRef: 'p', roundIndex: 1, reply: REPLY }, 3_000),
      (error) => error instanceof ModelError && error.message.includes('model mismatch'),
    );
  } finally {
    await server.close();
  }
});

test('duplicate-key model output cannot overwrite totalCompleteness', async () => {
  const server = await startFakeModelServer();
  try {
    server.setBehavior({ duplicateKey: true });
    const model = new OllamaCoordinationModel(server.url, 'fake-qwen3:8b');
    // 假回复给出 70%；重复键先写 95 再覆盖 70——严格解析必须整体拒绝。
    await assert.rejects(
      model.understand({ goal: 'g', prdRef: 'p', roundIndex: 1, reply: REPLY }, 3_000),
      (error) => error instanceof ModelError && error.code === 'MODEL_INVALID_OUTPUT',
    );
  } finally {
    await server.close();
  }
});

test('strictJsonParse rejects duplicate keys at nested levels', async () => {
  const { strictJsonParse } = await import('../dist/shared/strict-json.js');
  assert.throws(() => strictJsonParse('{"a":{"b":1,"b":2}}'), /duplicate property: b/);
  assert.throws(() => strictJsonParse('{"a":1,"a":2}'), /duplicate property: a/);
  assert.deepEqual(strictJsonParse('{"a":{"b":1}}'), { a: { b: 1 } });
});

test('already-cancelled request is never sent', async () => {
  const server = await startFakeModelServer();
  try {
    let chatHits = 0;
    server.server.on('request', (req) => {
      if (req.url === '/api/chat') chatHits += 1;
    });
    const client = new OllamaClient(server.url);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      client.chat({
        model: 'fake-qwen3:8b', messages: [{ role: 'user', content: 'x' }],
        timeoutMs: 2_000, signal: controller.signal,
      }),
      /aborted|timeout/i,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(chatHits, 0, '已取消的请求不得发出');
  } finally {
    await server.close();
  }
});

test('error response body is also byte-limited (huge 500 body fails fast with MODEL_REJECTED)', async () => {
  const server = await startFakeModelServer();
  try {
    server.setBehavior({ fault: 'http500', errorBigBodyBytes: 8 * 1024 * 1024 });
    const model = new OllamaCoordinationModel(server.url, 'fake-qwen3:8b');
    await assert.rejects(
      model.understand({ goal: 'g', prdRef: 'p', roundIndex: 1, reply: REPLY }, 5_000),
      (error) => error instanceof ModelError && error.code === 'MODEL_REJECTED',
    );
  } finally {
    await server.close();
  }
});
