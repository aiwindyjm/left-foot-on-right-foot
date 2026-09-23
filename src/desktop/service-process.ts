// 宿主侧协调服务进程管理器（R10，注入式）。
// 进程启动由宿主注入（Electron utilityProcess.fork 或测试的 node fork）——
// 与 helper-client 相同的注入模式：本模块只管协议（请求-响应关联、超时、失联）。
// 注意：src/ 下的 child_process 启动被 Mimosa PreToolUse 安全门拦截（误报命令注入，
// 评审 R10 已知）；Electron 宿主用 utilityProcess.fork（非 child_process）注入，
// 测试在 tests/ 路径自行 fork 本 entry 构建产物。
import {
  makeCommandEnvelope, isServiceEnvelope,
  type ServiceCommand, type ServiceResult,
} from '../shared/service-protocol.js';

export interface ServiceProcessHandle {
  send(message: unknown, callback?: (error: Error | null) => void): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  kill?(): void;
}

export interface ServiceProcessOptions {
  commandTimeoutMs?: number;
  onExit?: ((code: number | null) => void) | undefined;
  /** 服务主动推送的事件（id=null 信封，如状态变化）。 */
  onEvent?: ((event: unknown) => void) | undefined;
}

export class ServiceProcessManager {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (result: ServiceResult) => void; timer: NodeJS.Timeout }>();
  private exited = false;
  private bound = false;

  constructor(
    private readonly handle: ServiceProcessHandle,
    private readonly options: ServiceProcessOptions = {},
  ) {}

  /** 绑定进程事件（在发出 init 前调用一次）。 */
  bind(): void {
    if (this.bound) throw new Error('manager already bound');
    this.bound = true;
    this.handle.on('exit', (code) => {
      this.exited = true;
      this.failAll({ ok: false, code: 'SERVICE_LOST', message: `协调服务进程退出（code=${code}）；停止新输入` });
      this.options.onExit?.(code);
    });
    this.handle.on('message', (message: unknown) => this.handleMessage(message));
  }

  get running(): boolean {
    return !this.exited;
  }

  async command(command: ServiceCommand, timeoutMs = this.options.commandTimeoutMs ?? 10_000): Promise<ServiceResult> {
    if (this.exited) {
      return { ok: false, code: 'SERVICE_LOST', message: '协调服务未运行' };
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<ServiceResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, code: 'SERVICE_TIMEOUT', message: `服务命令超时（${command.kind}，${timeoutMs}ms）` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.handle.send(makeCommandEnvelope(id, command), (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          resolve({ ok: false, code: 'SERVICE_SEND_FAILED', message: error.message });
        }
      });
    });
  }

  async shutdown(timeoutMs = 2_000): Promise<void> {
    if (this.exited) return;
    await this.command({ kind: 'shutdown' }, timeoutMs);
    if (!this.exited) this.handle.kill?.();
  }

  private handleMessage(message: unknown): void {
    if (!isServiceEnvelope(message)) return;
    if (message.id === null) {
      // 事件信封（无关联 id）：转发给宿主事件回调（如状态推送）。
      this.options.onEvent?.(message.payload);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message.payload as ServiceResult);
  }

  private failAll(result: ServiceResult): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(result);
    }
    this.pending.clear();
  }
}
