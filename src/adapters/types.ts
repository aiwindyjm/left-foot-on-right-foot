// 产品会话 Adapter 契约（三层中的产品层）。核心不感知厂商；
// Codex/ZCODE 各自实现，模拟 Adapter 用于本地开发与测试。
// 能力缺失必须显式报告（unsupported / not-integrated），禁止假成功回执。
export type CapabilityLevel = 'background' | 'foreground' | 'unsupported' | 'permission-denied' | 'unknown';

export interface AdapterCapabilities {
  productId: string;
  /** 读取回复的能力。 */
  readReply: CapabilityLevel;
  /** 发送提示词的能力。 */
  sendPrompt: CapabilityLevel;
  /** 外部任务停止/取消能力（仅展示，不把“不再发送”冒充“已停止”）。 */
  cancelRunningTask: CapabilityLevel;
  /** 实施状态：真实产品接入以联调证据为准（批次B），模拟器仅用于测试。 */
  integration: 'simulated' | 'pending-integration' | 'partial' | 'verified';
  notes: string[];
}

export interface ProductSessionInfo {
  productId: string;
  sessionId: string;
  label: string | null;
}

/** 发送回执：unknown 表示无法确认（项目须暂停，不得重发）；failed 表示明确失败。 */
export interface AdapterSendReceipt {
  status: 'confirmed' | 'unknown' | 'failed';
  detail: string;
  /** 产品侧消息标识（有则提供，用于关联与去重）。 */
  messageRef: string | null;
}

export interface SessionReply {
  sessionId: string;
  /** 回复完整文本。complete=false 表示只读到片段（虚拟列表等），调用方不得当全量使用。 */
  text: string;
  complete: boolean;
  /** 会话内消息引用（用于增量读取与去重）。 */
  messageRef: string;
  receivedAt: string;
}

export interface AdapterHealth {
  productId: string;
  status: 'ready' | 'degraded' | 'unavailable' | 'not-integrated';
  detail: string;
}

export interface SendPromptMeta {
  /** 派发意图 id（核心已先行持久化）。 */
  intentId: string;
  /** 目标轮次。 */
  roundIndex: number;
  timeoutMs: number;
  /** 发起项目（R9：模拟层按项目隔离状态；核心层用于会话互斥归属）。 */
  ownerId: string;
}

/** 产品会话适配器接口。实现不得在 unknown/failed 时抛出异常以外再吞掉结果。 */
export interface ProductAdapter {
  readonly productId: string;
  capabilities(): AdapterCapabilities;
  health(): Promise<AdapterHealth>;
  listSessions(): Promise<ProductSessionInfo[]>;
  /** 核对绑定会话仍可定位且身份一致；失配返回 false 而不是换一个会话。 */
  verifyBinding(sessionId: string): Promise<{ ok: boolean; detail: string }>;
  sendPrompt(sessionId: string, text: string, meta: SendPromptMeta): Promise<AdapterSendReceipt>;
  /**
   * 读取会话内指定消息引用之后的最新回复；无新回复返回 null。
   * ownerId 标识发起项目（模拟层按项目隔离状态；实现必须核对 reply.sessionId）。
   */
  readReply(sessionId: string, afterMessageRef: string | null, timeoutMs: number, ownerId: string): Promise<SessionReply | null>;
}

/** Adapter 层统一错误码（核心按 code 决定暂停原因）。 */
export type AdapterErrorCode =
  | 'ADAPTER_TIMEOUT'
  | 'ADAPTER_UNAVAILABLE'
  | 'ADAPTER_NOT_INTEGRATED'
  | 'ADAPTER_BINDING_LOST'
  | 'ADAPTER_INVALID_STATE'
  | 'ADAPTER_FAULT_INJECTED';

export class AdapterError extends Error {
  constructor(
    public readonly code: AdapterErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'AdapterError';
  }
}
