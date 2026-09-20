// 原生组件 RPC 契约 v1：桌面宿主与 Windows(C#)/Mac(Swift) helper 之间的
// 版本化 JSON-RPC（子进程 stdin/stdout，UTF-8 逐行 NDJSON）。
// 独立于 AI 消息协议版本（PRD 11）；模型输出永远不能选择这里的方法或参数。
export const NATIVE_RPC_VERSION = '1.0';

export type NativeMethod =
  | 'initialize'
  | 'shutdown'
  | 'ping'
  | 'sys.capabilities'
  | 'uia.locate'
  | 'uia.readText'
  | 'uia.setValue'
  | 'uia.invoke'
  | 'fg.activate'
  | 'clipboard.snapshot'
  | 'clipboard.restore';

export const NATIVE_METHODS: readonly NativeMethod[] = Object.freeze([
  'initialize', 'shutdown', 'ping', 'sys.capabilities',
  'uia.locate', 'uia.readText', 'uia.setValue', 'uia.invoke',
  'fg.activate', 'clipboard.snapshot', 'clipboard.restore',
]);

/** 能力声明：缺失的能力必须显式报告，不得假装成功（架构三层边界）。 */
export interface NativeCapabilities {
  platform: 'win32' | 'darwin' | string;
  methods: Partial<Record<NativeMethod, 'supported' | 'unsupported'>>;
  /** 平台限制说明（如权限不足、控件不可用）。 */
  notes: string[];
}

export interface LocateQuery {
  /** 目标应用进程名或窗口名线索；身份不能只靠窗口标题（架构绑定与完整性）。 */
  appHint: string;
  /** 产品会话身份线索（项目路径、会话标题片段等）。 */
  sessionHint: string;
}

export interface LocatedElement {
  /** helper 内部稳定的元素句柄（重启后失效，宿主不得跨生命周期复用）。 */
  handle: string;
  /** 身份证据摘要（控件名/自动化ID/层级路径），用于展示与核对，不是权限凭证。 */
  identityEvidence: string;
  /** 需要前台交互才能读/写时为 true。 */
  requiresForeground: boolean;
}

export interface ClipboardSnapshot {
  formats: { text: string | null };
}

// ---- JSON-RPC 2.0 线格式 ----

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: NativeMethod;
  params: Record<string, unknown> | null;
}

export interface RpcResult {
  jsonrpc: '2.0';
  id: number;
  result: unknown;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcError {
  jsonrpc: '2.0';
  id: number | null;
  error: RpcErrorObject;
}

export type RpcMessage = RpcRequest | RpcResult | RpcError;

/** 标准错误码 + 本协议扩展码。 */
export const RpcErrorCode = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32000,
  /** 方法在当前平台/权限下不支持（对应能力 unsupported）。 */
  UNSUPPORTED: -32002,
  /** 绑定失效：应用重启/窗口变化后旧句柄不可用。 */
  STALE_BINDING: -32003,
  /** 系统权限不足（如 Mac 辅助功能被拒绝）。 */
  PERMISSION_DENIED: -32004,
  /** 前台模式未获准/焦点不可用，动作被拒绝。 */
  FOREGROUND_REQUIRED: -32005,
});

/** 每行最大字节数；超过即视为协议违例并终止连接（tech-stack §6）。 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

export function isRpcMessage(value: unknown): value is RpcMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== '2.0') return false;
  if ('method' in message) {
    return (
      typeof message.method === 'string' &&
      (NATIVE_METHODS as readonly string[]).includes(message.method) &&
      (message.id === undefined || typeof message.id === 'number')
    );
  }
  if ('result' in message) return typeof message.id === 'number';
  if ('error' in message) {
    const error = message.error as Record<string, unknown> | null;
    return (
      (message.id === null || typeof message.id === 'number') &&
      !!error && typeof error.code === 'number' && typeof error.message === 'string'
    );
  }
  return false;
}

/** 序列化一行 NDJSON（无 BOM、无换行注入）。 */
export function encodeLine(message: RpcMessage): string {
  const text = JSON.stringify(message);
  if (text.includes('\n')) throw new Error('RPC message must not contain newlines');
  return `${text}\n`;
}
