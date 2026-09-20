// W4 产品 Adapter 测试：模拟 Adapter 行为面 + 未联调 Adapter 的诚实拒绝。
import assert from 'node:assert/strict';
import test from 'node:test';
import { SimulatedAdapter } from '../dist/adapters/simulated/simulated-adapter.js';
import { createCodexAdapter, createZcodeAdapter } from '../dist/adapters/pending-integration.js';
import { AdapterError } from '../dist/adapters/types.js';

test('simulated adapter reports scripted evaluation replies with verbatim prompts', async () => {
  const adapter = new SimulatedAdapter(undefined, { replyDelayMs: 5 });
  const binding = await adapter.verifyBinding('sim-eval-progress');
  assert.equal(binding.ok, true);
  await adapter.sendPrompt('sim-eval-progress', '评估请求', { intentId: 'i1', roundIndex: 1, timeoutMs: 1_000, ownerId: 't1' });
  const reply = await adapter.readReply('sim-eval-progress', null, 1_000, 't1');
  assert.ok(reply);
  assert.ok(String(reply.text).includes('总体完成度：65%'));
  assert.ok(String(reply.text).includes('「请继续完成收尾项」'));
  assert.equal(reply.complete, true);
});

test('simulated executor returns execution receipt text', async () => {
  const adapter = new SimulatedAdapter(undefined, { replyDelayMs: 5 });
  await adapter.sendPrompt('sim-exec', '请完成登录模块', { intentId: 'i2', roundIndex: 2, timeoutMs: 1_000, ownerId: 't1' });
  const reply = await adapter.readReply('sim-exec', null, 1_000, 't1');
  assert.ok(reply?.text.includes('第 2 轮'));
  assert.ok(reply?.text.includes('请完成登录模块'));
});

test('simulated capabilities honestly marked simulated', () => {
  const capabilities = new SimulatedAdapter().capabilities();
  assert.equal(capabilities.integration, 'simulated');
  assert.equal(capabilities.cancelRunningTask, 'unsupported');
});

test('simulated binding-lost fault forces verifyBinding failure', async () => {
  const adapter = new SimulatedAdapter(undefined, { replyDelayMs: 5 });
  adapter.setFaults('sim-eval-progress', { bindingLost: true });
  const binding = await adapter.verifyBinding('sim-eval-progress');
  assert.equal(binding.ok, false);
  await assert.rejects(
    adapter.sendPrompt('sim-eval-progress', 'x', { intentId: 'i', roundIndex: 1, timeoutMs: 1_000, ownerId: 't1' }),
    (error) => error instanceof AdapterError && error.code === 'ADAPTER_BINDING_LOST',
  );
});

test('unknown send receipt is surfaced without retry semantics', async () => {
  const adapter = new SimulatedAdapter(undefined, { replyDelayMs: 5 });
  adapter.setFaults('sim-exec', { sendReceipt: 'unknown' });
  const receipt = await adapter.sendPrompt('sim-exec', 'x', { intentId: 'i', roundIndex: 1, timeoutMs: 1_000, ownerId: 't1' });
  assert.equal(receipt.status, 'unknown');
});

test('incomplete reply mode flags complete=false', async () => {
  const adapter = new SimulatedAdapter(undefined, { replyDelayMs: 5 });
  adapter.setFaults('sim-eval-progress', { replyMode: 'incomplete' });
  await adapter.sendPrompt('sim-eval-progress', 'x', { intentId: 'i', roundIndex: 1, timeoutMs: 1_000, ownerId: 't1' });
  const reply = await adapter.readReply('sim-eval-progress', null, 1_000, 't1');
  assert.equal(reply?.complete, false);
});

test('codex/zcode adapters honestly refuse all operations', async () => {
  for (const adapter of [createCodexAdapter(), createZcodeAdapter()]) {
    const capabilities = adapter.capabilities();
    assert.equal(capabilities.integration, 'pending-integration');
    assert.equal(capabilities.sendPrompt, 'unknown');
    const health = await adapter.health();
    assert.equal(health.status, 'not-integrated');
    assert.deepEqual(await adapter.listSessions(), [], '不得枚举或猜测会话');
    assert.equal((await adapter.verifyBinding('anything')).ok, false);
    await assert.rejects(
      adapter.sendPrompt('x', 'y', { intentId: 'i', roundIndex: 1, timeoutMs: 1_000, ownerId: 't1' }),
      (error) => error instanceof AdapterError && error.code === 'ADAPTER_NOT_INTEGRATED',
    );
    await assert.rejects(adapter.readReply('x', null, 1_000), /ADAPTER_NOT_INTEGRATED/);
  }
});
