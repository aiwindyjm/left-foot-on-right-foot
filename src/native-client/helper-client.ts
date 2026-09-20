// 原生 helper 的 stdio JSON-RPC 客户端（W4，真实协议实现）。
// NDJSON 帧、请求关联、版本握手、超时、退出处理、超长行保护。
// 进程启动职责不在本模块：产品宿主在批次B接入真实 helper 时注入进程句柄
// （本批次无 .NET SDK、无 helper 二进制，产品侧启动 NOT_RUN）；
// 测试以受控假 helper 进程驱动同一实现（见 tests/helper-client.test.mjs）。
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import {
  encodeLine, isRpcMessage, MAX_LINE_BYTES, NATIVE_METHODS, NATIVE_RPC_VERSION,
  type NativeCapabilities, type NativeMethod, type RpcMessage,
} from '../shared/native-rpc.js';

/** 客户端依赖的进程形态（node ChildProcess 结构兼容子集）。 */
export interface HelperProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export class HelperProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelperProtocolError';
  }
}

export class HelperExitedError extends Error {
  constructor(
    public readonly code: number | null,
    detail: string,
  ) {
    super(`helper exited (code=${code}): ${detail}`);
    this.name = 'HelperExitedError';
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: NativeMethod;
}

export interface HelperClientOptions {
  /** 单请求默认期限（毫秒）。 */
  requestTimeoutMs?: number;
  /** stderr 诊断保留上限。 */
  maxStderrLines?: number;
}

export class NativeHelperClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly stderrLines: string[] = [];
  private capabilitiesCache: NativeCapabilities | null = null;
  private exited = false;
  private exitDetail = '';
  private exitCode: number | null = null;
  private corrupt = false;
  private bound = false;

  constructor(
    private readonly child: HelperProcess,
    private readonly options: HelperClientOptions = {},
  ) {}

  /** 绑定流并完成版本握手（initialize）。 */
  async bind(handshakeTimeoutMs = 5_000): Promise<NativeCapabilities> {
    if (this.bound) throw new HelperProtocolError('client already bound');
    this.bound = true;
    this.child.on('error', (error) => {
      this.exitDetail = `process error: ${error.message}`;
      this.failAll(new HelperExitedError(null, this.exitDetail));
    });
    this.child.on('exit', (code) => {
      this.exited = true;
      this.exitCode = code;
      this.exitDetail = this.exitDetail || 'process exited unexpectedly';
      this.failAll(new HelperExitedError(code, this.exitDetail));
    });
    const readline = createInterface({ input: this.child.stdout });
    readline.on('line', (line: string) => this.handleLine(line));
    const stderrReadline = createInterface({ input: this.child.stderr });
    stderrReadline.on('line', (line: string) => {
      if (this.stderrLines.length < (this.options.maxStderrLines ?? 200)) {
        this.stderrLines.push(line.slice(0, 500));
      }
    });
    const capabilities = (await this.request(
      'initialize',
      { protocolVersion: NATIVE_RPC_VERSION, client: 'lfrr-desktop' },
      handshakeTimeoutMs,
    )) as NativeCapabilities;
    if (!capabilities || typeof capabilities !== 'object' || !capabilities.methods) {
      throw new HelperProtocolError('initialize result missing capabilities');
    }
    this.capabilitiesCache = capabilities;
    return capabilities;
  }

  get capabilities(): NativeCapabilities | null {
    return this.capabilitiesCache;
  }

  get diagnostics(): string[] {
    return [...this.stderrLines];
  }

  get running(): boolean {
    return !this.exited;
  }

  /** 发起白名单方法调用；超时拒绝；进程退出时全部失败。 */
  async request(method: NativeMethod, params: Record<string, unknown> | null, timeoutMs = this.options.requestTimeoutMs ?? 10_000): Promise<unknown> {
    if (!(NATIVE_METHODS as readonly string[]).includes(method)) {
      throw new HelperProtocolError(`method not in whitelist: ${method}`);
    }
    if (this.exited) throw new HelperExitedError(this.exitCode, this.exitDetail);
    if (this.corrupt) throw new HelperProtocolError('protocol corrupted by oversized line; client closed');
    const id = this.nextId;
    this.nextId += 1;
    const message: RpcMessage = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperProtocolError(`request timeout: ${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(encodeLine(message), (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new HelperProtocolError(`stdin write failed: ${error.message}`));
        }
      });
    });
  }

  /** 请求 shutdown 并等待退出（尽力而为）。 */
  async stop(graceMs = 2_000): Promise<void> {
    if (this.exited) return;
    try {
      await this.request('shutdown', null, graceMs);
    } catch {
      // shutdown 超时也继续终止。
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, graceMs);
      this.child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      this.corrupt = true;
      this.failAll(new HelperProtocolError(`line exceeds ${MAX_LINE_BYTES} bytes; terminating`));
      this.child.kill();
      return;
    }
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 非协议输出：记为诊断（helper 契约要求 stdout 仅协议，此处防御）。
      this.stderrLines.push(`stdout-non-protocol: ${line.slice(0, 200)}`);
      return;
    }
    if (!isRpcMessage(parsed) || !('id' in parsed)) return;
    const message = parsed as { id: number; result?: unknown; error?: { code: number; message: string } };
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ('error' in message && message.error) {
      pending.reject(new HelperProtocolError(`rpc ${pending.method} error ${message.error.code}: ${message.error.message}`));
    } else {
      pending.resolve((message as { result?: unknown }).result);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
