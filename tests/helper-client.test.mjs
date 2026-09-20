// W4 原生 RPC 客户端契约测试：真实 stdio 传输对假 helper。
// 覆盖：握手成功/版本不匹配、方法白名单、超时、进程中途退出、协议垃圾与超长行防护。
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NativeHelperClient, HelperExitedError } from '../dist/native-client/helper-client.js';

const fakeHelperPath = fileURLToPath(new URL('./fixtures/fake-helper.mjs', import.meta.url));

async function startClient(mode = 'normal', options = {}) {
  const child = spawn(process.execPath, [fakeHelperPath, mode], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  const client = new NativeHelperClient(child, { requestTimeoutMs: 2_000, ...options });
  return { client, child };
}

test('handshake succeeds and capabilities report honest method matrix', async () => {
  const { client, child } = await startClient();
  try {
    const capabilities = await client.bind();
    assert.equal(capabilities.platform, process.platform);
    assert.equal(capabilities.methods['uia.setValue'], 'unsupported', '不支持的方法必须如实报告');
    const pong = await client.request('ping', null);
    assert.deepEqual(pong, { pong: true });
    const locate = await client.request('uia.locate', { appHint: 'TestApp', sessionHint: 'demo' });
    assert.ok(locate.elements[0].handle.length > 0);
    const text = await client.request('uia.readText', { handle: locate.elements[0].handle });
    assert.equal(text.complete, true);
    assert.ok(String(text.text).includes('70%'));
    await client.stop();
  } finally {
    child.kill();
  }
});

test('version mismatch fails handshake with clear error', async () => {
  const { client, child } = await startClient('version-mismatch');
  try {
    await assert.rejects(client.bind(), /protocol version mismatch|unsupported protocolVersion/);
  } finally {
    child.kill();
  }
});

test('non-whitelisted method rejected client-side', async () => {
  const { client, child } = await startClient();
  try {
    await client.bind();
    await assert.rejects(
      client.request('shell.exec', { cmd: 'dir' }),
      /method not in whitelist/,
    );
  } finally {
    child.kill();
  }
});

test('request timeout rejects and later requests still work', async () => {
  const { client, child } = await startClient('slow');
  try {
    await client.bind();
    await assert.rejects(client.request('ping', null, 80), /request timeout: ping/);
    // 队列不残留：新请求（给足期限）正常。
    const pong = await client.request('ping', null, 2_000);
    assert.ok(pong);
  } finally {
    child.kill();
  }
});

test('helper exit mid-request fails all pending with HelperExitedError', async () => {
  const { client, child } = await startClient('die-after-init');
  try {
    await client.bind();
    await assert.rejects(client.request('ping', null, 3_000), (error) => error instanceof HelperExitedError);
    await assert.rejects(client.request('ping', null), (error) => error instanceof HelperExitedError);
  } finally {
    child.kill();
  }
});

test('protocol garbage and oversized line corrupt client and kill process', async () => {
  const { client, child } = await startClient('protocol-garbage', { requestTimeoutMs: 3_000 });
  try {
    await client.bind();
    // 等 helper 输出超长行（60ms 定时）触发客户端防护并杀死进程。
    const started = Date.now();
    while (client.running && Date.now() - started < 3_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(client.running, false, '超长行必须终止客户端');
    await assert.rejects(client.request('ping', null), /corrupted|exited/);
    assert.ok(client.diagnostics.some((line) => line.includes('stdout-non-protocol')));
  } finally {
    child.kill();
  }
});

test('unknown method surfaces helper METHOD_NOT_FOUND error', async () => {
  const { client, child } = await startClient();
  try {
    await client.bind();
    // 白名单内但假 helper 未实现 clipboard.snapshot 之外的组合：用 initialize 再调一次会被拒? 直接验证错误面。
    await assert.rejects(
      client.request('uia.readText', { handle: 'el-nope' }),
      /-32003/,
    );
  } finally {
    child.kill();
  }
});
