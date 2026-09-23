// 宿主(main)与协调服务(utility进程/同进程测试)之间的命令-事件协议。
// 传输无关：Electron parentPort、node:test 直连均可承载（W5/W6 复用同一实现）。
import type { ProjectConfig, RunLimits } from './project-config.js';
import type { AppStatusView, AuditEventItem, ModelStatusView, RecordItem } from './views.js';
import type { AdapterCapabilities, ProductSessionInfo } from '../adapters/types.js';

export const SERVICE_PROTOCOL_VERSION = '1.0';

/** 创建项目时的输入（config 各字段 + 可选限额覆盖）。 */
export interface CreateProjectInput {
  config: Omit<ProjectConfig, 'limits'> & { limits?: Partial<RunLimits> };
}

export type ServiceCommand =
  | { kind: 'init'; dbDir: string; mode: 'simulated' | 'production'; modelEndpoint: string; modelName: string }
  | { kind: 'getState' }
  | { kind: 'createProject'; input: CreateProjectInput }
  | { kind: 'updateProject'; projectId: string; patch: { name?: string; goal?: string; prdRef?: string } }
  | { kind: 'setThreshold'; projectId: string; threshold: number }
  | { kind: 'startProject'; projectId: string }
  | { kind: 'pauseProject'; projectId: string }
  | { kind: 'resumeProject'; projectId: string }
  | { kind: 'stopProject'; projectId: string }
  | { kind: 'abandonIntent'; projectId: string; intentId: number }
  | { kind: 'stopAll' }
  | { kind: 'resumeAll' }
  | { kind: 'setForegroundMode'; enabled: boolean }
  | { kind: 'listProducts' }
  | { kind: 'listSessions'; productId: string }
  | { kind: 'checkModel' }
  | { kind: 'listRecords'; projectId: string; limit: number }
  | { kind: 'listEvents'; projectId: string | null; limit: number }
  /**
   * 测试基础设施（仅 simulated 模式有效，production 返回错误）：
   * 向模拟 Adapter 注入故障，供桌面 E2E 覆盖 unknown_send → 恢复核对 →
   * abandon → resume 的完整 UI 路径；生产模式无模拟 Adapter，不可触发。
   */
  | { kind: 'testInjectFault'; scope: 'send-unknown' | 'clear'; sessionId: string }
  | { kind: 'shutdown' };

export type ServiceResult =
  | {
    ok: true;
    status?: AppStatusView;
    products?: AdapterCapabilities[];
    sessions?: ProductSessionInfo[];
    model?: ModelStatusView;
    records?: RecordItem[];
    events?: AuditEventItem[];
  }
  | { ok: false; code: string; message: string };

/** 服务主动推送的事件（带协议版本，方向 service -> host）。 */
export type ServiceEvent =
  | { kind: 'status'; status: AppStatusView }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string };
export interface ServiceEnvelope<T> {
  v: typeof SERVICE_PROTOCOL_VERSION;
  /** 命令关联 id；结果回填同一 id。 */
  id: number | null;
  payload: T;
}

export function makeCommandEnvelope(id: number, command: ServiceCommand): ServiceEnvelope<ServiceCommand> {
  return { v: SERVICE_PROTOCOL_VERSION, id, payload: command };
}

export function makeResultEnvelope(id: number, result: ServiceResult): ServiceEnvelope<ServiceResult> {
  return { v: SERVICE_PROTOCOL_VERSION, id, payload: result };
}

export function makeEventEnvelope(event: ServiceEvent): ServiceEnvelope<ServiceEvent> {
  return { v: SERVICE_PROTOCOL_VERSION, id: null, payload: event };
}

/** 入站消息基础校验（main 收 renderer IPC 后、转发服务前同样使用）。 */
export function isServiceEnvelope(value: unknown): value is ServiceEnvelope<unknown> {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Record<string, unknown>;
  return envelope.v === SERVICE_PROTOCOL_VERSION && 'payload' in envelope;
}
