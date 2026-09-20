// 假 helper（测试专用）：以真实 NDJSON JSON-RPC 协议在 stdin/stdout 上应答，
// 用于驱动真实 NativeHelperClient（不接触任何用户应用）。
// 用法：node fake-helper.mjs <mode>；mode 缺省为 normal。
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'normal';

const CAPABILITIES = {
  platform: process.platform,
  methods: {
    initialize: 'supported',
    shutdown: 'supported',
    ping: 'supported',
    'sys.capabilities': 'supported',
    'uia.locate': 'supported',
    'uia.readText': 'supported',
    'uia.setValue': 'unsupported',
    'uia.invoke': 'unsupported',
    'fg.activate': 'unsupported',
    'clipboard.snapshot': 'supported',
    'clipboard.restore': 'supported',
  },
  notes: ['fake helper for contract tests only'],
};

let nextElementId = 0;
const elements = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, messageText) {
  send({ jsonrpc: '2.0', id, error: { code, message: messageText } });
}

function handle(request) {
  const { id, method, params } = request;
  switch (mode) {
    case 'version-mismatch':
      if (method === 'initialize') {
        replyError(id, -32602, `protocol version mismatch: server wants 0.9, client sent ${params?.protocolVersion}`);
        return;
      }
      break;
    case 'die-after-init':
      if (method !== 'initialize') {
        // 初始化后立即退出，制造"请求中途进程死亡"。
        process.stderr.write('fake helper dying mid-request\n');
        process.exit(1);
      }
      break;
    default:
      break;
  }
  switch (method) {
    case 'initialize':
      if (params?.protocolVersion !== '1.0') {
        replyError(id, -32602, `unsupported protocolVersion ${params?.protocolVersion}`);
        return;
      }
      reply(id, CAPABILITIES);
      return;
    case 'shutdown':
      reply(id, { bye: true });
      setTimeout(() => process.exit(0), 10);
      return;
    case 'ping':
      if (mode === 'slow') {
        setTimeout(() => reply(id, { pong: true, delayMs: 400 }), 400);
        return;
      }
      reply(id, { pong: true });
      return;
    case 'sys.capabilities':
      reply(id, CAPABILITIES);
      return;
    case 'uia.locate': {
      if (!params?.appHint) {
        replyError(id, -32602, 'appHint required');
        return;
      }
      nextElementId += 1;
      const handle = `el-${nextElementId}`;
      elements.set(handle, { text: `会话内容：完成度 70%。` });
      reply(id, { elements: [{ handle, identityEvidence: `App:${params.appHint}/Doc`, requiresForeground: false }] });
      return;
    }
    case 'uia.readText': {
      const element = elements.get(params?.handle);
      if (!element) {
        replyError(id, -32003, `stale or unknown handle ${params?.handle}`);
        return;
      }
      reply(id, { text: element.text, complete: true });
      return;
    }
    case 'clipboard.snapshot':
      reply(id, { formats: { text: 'snapshot-value' } });
      return;
    case 'clipboard.restore':
      reply(id, { restored: true });
      return;
    default:
      replyError(id, -32601, `method not found: ${method}`);
  }
}

if (mode === 'protocol-garbage') {
  // 先输出非协议内容，再输出超长行，测试客户端防御。
  process.stdout.write('debug noise line\n');
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 999, result: null }).slice(0, 40)}\n`);
  }, 20);
  setTimeout(() => {
    process.stdout.write(`${'x'.repeat(9 * 1024 * 1024)}\n`);
  }, 60);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim().length === 0) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  if (typeof request.id !== 'number' || typeof request.method !== 'string') {
    send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
    return;
  }
  handle(request);
});
