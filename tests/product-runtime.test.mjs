// R10 回归：产品交互逻辑层（ProductSessionRuntime）以受控控件 fixture 驱动——
// 锚点缺失显式失败、片段读取拒绝、发送回显核对（unknown 语义）、剪贴板竞争拒绝。
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProductSessionRuntime, InteractionError } from '../dist/adapters/product-runtime/session-runtime.js';

/** 受控 fixture 传输：内存控件树，可注入异常。 */
function makeFixture(options = {}) {
  const state = {
    transcript: '',
    clipboard: '旧剪贴板内容',
    locateCalls: [],
    sentValues: [],
  };
  const transport = {
    async locate(appHint, sessionHint) {
      state.locateCalls.push({ appHint, sessionHint });
      if (options.noWindow) return [];
      if (options.noAnchor) {
        // 有窗口但无会话锚点证据（模拟"只有标题匹配"）。
        return [{ handle: 'win-1', identityEvidence: `Window(title='标题匹配 ${sessionHint}')`, requiresForeground: false }];
      }
      return [{ handle: `win-anchored-${sessionHint}`, identityEvidence: `Window(pid=4242) +Anchor('${sessionHint}')`, requiresForeground: options.requiresForeground ?? false }];
    },
    async readText(handle) {
      if (options.incompleteTranscript) return { text: state.transcript.slice(0, 10), complete: false };
      return { text: state.transcript, complete: true };
    },
    async setValue(handle, text) {
      state.sentValues.push(text);
    },
    async invoke(handle) {
      // 模拟发送：回显到转录区。
      const last = state.sentValues.at(-1) ?? '';
      state.transcript = `${state.transcript}\n${last.slice(0, 80)}`;
      if (options.echoBroken) state.transcript = '回显丢失';
    },
    async activateForeground() {
      if (options.foregroundDenied) throw new Error('SetForegroundWindow denied');
    },
    async clipboardSnapshot() {
      return { formats: { text: state.clipboard } };
    },
    async clipboardRestore(formats) {
      state.clipboard = formats.text;
      return { restored: true };
    },
  };
  return { transport, state };
}

test('bind fails explicitly when no window matches', async () => {
  const { transport } = makeFixture({ noWindow: true });
  const runtime = new ProductSessionRuntime(transport, { productId: 'codex', appHint: 'Codex' });
  await assert.rejects(
    runtime.bind('s1', '项目A会话'),
    (error) => error instanceof InteractionError && error.code === 'LOCATE_FAILED',
  );
});

test('bind refuses title-only match: missing session anchor evidence is a hard failure', async () => {
  const { transport } = makeFixture({ noAnchor: true });
  const runtime = new ProductSessionRuntime(transport, { productId: 'codex', appHint: 'Codex' });
  await assert.rejects(
    runtime.bind('s1', '项目A会话'),
    (error) => error instanceof InteractionError && error.code === 'SESSION_ANCHOR_NOT_FOUND',
  );
});

test('bind succeeds with anchor evidence; verifyBinding reports identity', async () => {
  const { transport } = makeFixture();
  const runtime = new ProductSessionRuntime(transport, { productId: 'codex', appHint: 'Codex' });
  const bound = await runtime.bind('s1', '项目A会话');
  assert.ok(bound.identityEvidence.includes("Anchor('项目A会话')"));
  assert.equal(runtime.verifyBinding('s1').ok, true);
  assert.equal(runtime.verifyBinding('other').ok, false);
});

test('incomplete transcript read is rejected, never used as full reply', async () => {
  const { transport } = makeFixture({ incompleteTranscript: true });
  const runtime = new ProductSessionRuntime(transport, { productId: 'codex', appHint: 'Codex' });
  await runtime.bind('s1', 'anchor');
  await assert.rejects(
    runtime.readReplyText('s1'),
    (error) => error instanceof InteractionError && error.code === 'INCOMPLETE_READ',
  );
});

test('send verifies echo: broken echo yields unknown receipt (not confirmed, no retry)', async () => {
  const { transport, state } = makeFixture({ echoBroken: true });
  const runtime = new ProductSessionRuntime(transport, { productId: 'codex', appHint: 'Codex' });
  await runtime.bind('s1', 'anchor');
  const receipt = await runtime.sendPrompt('s1', '请完成登录模块', { intentId: 'i', roundIndex: 1, timeoutMs: 1_000, ownerId: 'p' });
  assert.equal(receipt.status, 'unknown', '回显丢失必须按 unknown 处理');
  assert.equal(receipt.status !== 'confirmed', true);
  // 正常回显 → confirmed。
  const healthy = makeFixture();
  const runtime2 = new ProductSessionRuntime(healthy.transport, { productId: 'codex', appHint: 'Codex' });
  await runtime2.bind('s1', 'anchor');
  const receipt2 = await runtime2.sendPrompt('s1', '请完成登录模块', { intentId: 'i', roundIndex: 1, timeoutMs: 1_000, ownerId: 'p' });
  assert.equal(receipt2.status, 'confirmed');
  assert.equal(healthy.state.sentValues.length, 1);
});

test('clipboard restore refuses to overwrite user-modified content', async () => {
  const { transport, state } = makeFixture();
  const runtime = new ProductSessionRuntime(transport, { productId: 'codex', appHint: 'Codex' });
  await runtime.bind('s1', 'anchor');
  const snapshot = state.clipboard;
  state.clipboard = '用户新复制的内容';
  const result = await runtime.restoreClipboard(snapshot);
  assert.equal(result.restored, false);
  assert.equal(state.clipboard, '用户新复制的内容', '用户内容不得被覆盖');
  // 未被修改（剪贴板仍为快照值）时正常恢复。
  state.clipboard = snapshot;
  const result2 = await runtime.restoreClipboard(snapshot);
  assert.equal(result2.restored, true);
  assert.equal(state.clipboard, snapshot);
});
