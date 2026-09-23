// 协调服务 utility 进程入口（R10）：协调核心与 SQLite 单写入者隔离在独立进程，
// 阻塞/崩溃不拖住窗口主进程；失联由宿主显式报告（停止输入）。
// 传输抽象：Electron utilityProcess（process.parentPort）与 node child_process.fork
// （process.send/on('message')）同一入口可跑，便于无 Electron 环境测试。
import { CoordinationService } from './service.js';
import type { AppStatusView } from '../shared/views.js';
import {
  isServiceEnvelope, makeEventEnvelope, makeResultEnvelope,
  type ServiceCommand, type ServiceResult,
} from '../shared/service-protocol.js';

interface PortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
}

function resolvePort(): PortLike | null {
  const parentPort = (process as unknown as { parentPort?: PortLike }).parentPort;
  if (parentPort) {
    return {
      postMessage: (message) => parentPort.postMessage(message),
      on: (_event, listener) => parentPort.on('message', (event: unknown) => {
        // Electron MessagePort 事件形态：{ data }
        const payload = (event as { data?: unknown } | null)?.data ?? event;
        listener(payload);
      }),
    };
  }
  if (typeof process.send === 'function') {
    return {
      postMessage: (message) => process.send?.(message),
      on: (_event, listener) => process.on('message', (message: unknown) => listener(message)),
    };
  }
  return null;
}

async function main(): Promise<void> {
  const port = resolvePort();
  if (!port) {
    console.error('[lfrr-service-entry] no parent port; exiting');
    process.exit(1);
  }
  // 命令串行排队：SQLite 单写入者语义（顺序处理），但并发到达的命令排队等待
  // 而不是拒绝——renderer 的状态查询与操作命令天然并发，拒绝会造成大量误失败。
  // 长命令的超时保护由宿主 ServiceProcessManager 的请求期限承担。
  let service: CoordinationService | null = null;
  let lastStatusPush = 0;
  let pendingStatus: AppStatusView | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let queue: Promise<void> = Promise.resolve();
  const commandTimers = new Map<number, NodeJS.Timeout>();

  const handleMessage = (raw: unknown): void => {
    if (!isServiceEnvelope(raw) || raw.id === null || typeof raw.id !== 'number') return;
    const id = raw.id;
    queue = queue.then(() => processEnvelope(id, raw.payload as ServiceCommand)).catch(() => {});
  };

  const processEnvelope = async (id: number, command: ServiceCommand): Promise<void> => {
    if (!service) {
      // 首条命令必须是 init。
      if (command.kind !== 'init') {
        port.postMessage(makeResultEnvelope(id, { ok: false, code: 'SERVICE_NOT_INITIALIZED', message: '服务未初始化' }));
        return;
      }
      try {
        service = await CoordinationService.create({
          mode: command.mode,
          dbDir: command.dbDir,
          modelEndpoint: command.modelEndpoint,
          modelName: command.modelName,
          // 事件驱动状态推送（trailing-edge 节流）：窗口内保留最新快照并定时补推，
          // 同步块内的终态更新（如达标停止）不会被前沿截断丢弃。
          onStatusChanged: (status) => {
            pendingStatus = status;
            if (statusTimer !== null) return;
            const wait = Math.max(0, 80 - (Date.now() - lastStatusPush));
            statusTimer = setTimeout(() => {
              statusTimer = null;
              lastStatusPush = Date.now();
              if (pendingStatus) {
                port.postMessage(makeEventEnvelope({ kind: 'status', status: pendingStatus }));
                pendingStatus = null;
              }
            }, wait);
          },
        });
      } catch (error) {
        port.postMessage(makeResultEnvelope(id, {
          ok: false,
          code: 'SERVICE_BOOT_FAILED',
          message: error instanceof Error ? error.message : String(error),
        }));
        return;
      }
      port.postMessage(makeResultEnvelope(id, { ok: true }));
      return;
    }
    try {
      // 服务侧看门狗：单命令 60s 期限（adapter/model 契约要求自带期限，
      // 此处兜底保证宿主不会无限等待；队列仍保序等待底层收敛）。
      const result: ServiceResult = await Promise.race([
        service.handleCommand(command),
        new Promise<ServiceResult>((resolve) => {
          commandTimers.set(id, setTimeout(() => resolve({
            ok: false, code: 'SERVICE_TIMEOUT', message: `服务命令超时（${command.kind}，60s）`,
          }), 60_000));
        }),
      ]);
      const timer = commandTimers.get(id);
      if (timer) { clearTimeout(timer); commandTimers.delete(id); }
      port.postMessage(makeResultEnvelope(id, result));
    } catch (error) {
      port.postMessage(makeResultEnvelope(id, {
        ok: false,
        code: 'SERVICE_FAULT',
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  port.on('message', (message: unknown) => {
    void handleMessage(message);
  });

  // 优雅关闭：父进程断开或收到 shutdown 后退出（dispose 关闭数据库与假模型）。
  // 注意：仅 node child_process.fork 场景监听 'disconnect'——Electron utilityProcess
  // 不使用 Node ipc 通道，disconnect 会在启动后立即触发导致服务自我关闭（已复现）；
  // Electron 场景的退出由宿主发送 shutdown 命令或 kill 驱动。
  const shutdown = (): void => {
    void (async () => {
      if (service) await service.dispose();
      process.exit(0);
    })();
  };
  if (typeof process.send === 'function') {
    process.on('disconnect', shutdown);
  }
  port.on('message', (message: unknown) => {
    if (isServiceEnvelope(message) && message.id !== null
      && (message.payload as ServiceCommand)?.kind === 'shutdown') {
      setTimeout(shutdown, 50);
    }
  });
  void makeEventEnvelope; // 保留导入（状态推送事件由宿主轮询 getState，当前不需要主动推送）
}

void main();
