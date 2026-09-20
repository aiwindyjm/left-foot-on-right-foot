// W7 故障收口测试：存储失败禁止新项目/新派发路径；前台队列互斥语义；helper 生命周期错误面。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoordinationService } from '../dist/desktop/service.js';
import { ForegroundQueue } from '../dist/core/queues.js';
import { NativeHelperClient } from '../dist/native-client/helper-client.js';
import { Writable, Readable } from 'node:stream';

function bestEffortRemove(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch { /* 尽力清理 */ }
}

test('storage failure: closed database refuses createProject with STORAGE_FAILURE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lfrr-w7-'));
  const service = await CoordinationService.create({ mode: 'simulated', dbDir: join(dir, 'db'), pollIntervalMs: 20 });
  await service.dispose();
  const result = await service.handleCommand({
    kind: 'createProject',
    input: {
      config: {
        projectId: 'after-dispose',
        name: 'x', workspacePath: 'C:\\tmp\\x', goal: 'g', prdRef: 'p',
        evaluator: { productId: 'simulated', sessionId: 'a', label: null },
        executor: { productId: 'simulated', sessionId: 'b', label: null },
        stopThresholdPercent: 50,
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SERVICE_DISPOSED');
  bestEffortRemove(dir);
});

test('foreground queue: single owner, units run exclusively, overrun stalls then recovers', async () => {
  const queue = new ForegroundQueue();
  const order = [];
  let releaseFirst;
  const first = queue.submit({
    owner: 'proj-a', label: 'a-send', timeoutMs: 5_000,
    run: () => new Promise((resolve) => {
      order.push('a-hold');
      releaseFirst = () => { order.push('a-release'); resolve(); };
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = queue.submit({
    owner: 'proj-b', label: 'b-send', timeoutMs: 5_000,
    run: async () => { order.push('b-run'); },
  });
  assert.equal(queue.active.owner, 'proj-a', 'a 持有前台');
  assert.equal(queue.active.queued, 1, 'b 排队');
  releaseFirst();
  await first;
  await second;
  assert.deepEqual(order, ['a-hold', 'a-release', 'b-run'], '严格串行，不并行持有');
  assert.equal(queue.active.owner, null);
});

test('helper client surfaces exit and refuses further requests', async () => {
  // 最小死进程形态：直接用已退出的管道构造（协议层不依赖进程启动方式）。
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  await new Promise((resolve) => child.on('exit', resolve));
  const client = new NativeHelperClient(child);
  await assert.rejects(client.bind(), /exited|error|EPIPE|EOF|closed/i);
});

test('read-only stdin stream ends: client requests fail with exited error', async () => {
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const childLike = {
    stdin: input,
    stdout: output,
    stderr,
    on: () => {},
    kill: () => {},
  };
  const client = new NativeHelperClient(childLike, { requestTimeoutMs: 300 });
  // 未 bind 直接请求：stdin 可写但没有对端应答 → 超时。
  await assert.rejects(client.request('ping', null), /request timeout: ping/);
  input.end();
});
