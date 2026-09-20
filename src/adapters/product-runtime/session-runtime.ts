// 产品交互逻辑层（R10）：与传输无关的会话操作状态机。
// 传输（PlatformTransport）由具体接入注入：官方接口 / 原生 helper（批次B）/ 受控 fixture（本批测试）。
// 原则：不凭窗口标题绑定、不把片段当全量、不覆盖用户新剪贴板、未知布局显式失败。
import type { AdapterSendReceipt, SendPromptMeta } from '../types.js';

/** 平台传输接口：映射原生 RPC 方法（src/shared/native-rpc.ts v1.0）。 */
export interface PlatformTransport {
  locate(appHint: string, sessionHint: string): Promise<Array<{ handle: string; identityEvidence: string; requiresForeground: boolean }>>;
  readText(handle: string): Promise<{ text: string; complete: boolean }>;
  setValue(handle: string, text: string): Promise<void>;
  invoke(handle: string): Promise<void>;
  activateForeground(handle: string): Promise<void>;
  clipboardSnapshot(): Promise<{ formats: { text: string | null } }>;
  clipboardRestore(formats: { text: string }): Promise<{ restored: boolean; currentChanged?: boolean }>;
}

export interface ProductInteractionSpec {
  productId: string;
  /** 定位应用的进程/应用线索（非窗口标题匹配凭证）。 */
  appHint: string;
}

export interface BoundSession {
  sessionId: string;
  /** 身份证据摘要（AutomationId/层级等），绑定核对依据；不含标题-only 语义。 */
  identityEvidence: string;
  inputHandle: string;
  /** 回复容器句柄。 */
  transcriptHandle: string;
  requiresForeground: boolean;
}

export class InteractionError extends Error {
  constructor(
    public readonly code:
      | 'LOCATE_FAILED'
      | 'SESSION_ANCHOR_NOT_FOUND'
      | 'INCOMPLETE_READ'
      | 'SEND_UNVERIFIED'
      | 'CLIPBOARD_CHANGED',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'InteractionError';
  }
}

/**
 * 会话交互运行时：绑定 → 读取 → 发送（含回显核对）。
 * 未知布局/锚点缺失显式失败；发送成功必须经过回显核对，否则 unknown。
 */
export class ProductSessionRuntime {
  private readonly sessions = new Map<string, BoundSession>();

  constructor(
    private readonly transport: PlatformTransport,
    private readonly spec: ProductInteractionSpec,
  ) {}

  /** 绑定指定会话：按 sessionHint 锚点定位；找不到锚点显式失败（不退回窗口标题猜测）。 */
  async bind(sessionId: string, sessionHint: string): Promise<BoundSession> {
    const elements = await this.transport.locate(this.spec.appHint, sessionHint);
    if (elements.length === 0) {
      throw new InteractionError('LOCATE_FAILED', `未找到匹配 ${this.spec.appHint} 的窗口`);
    }
    // 锚点语义：transport 必须在 identityEvidence 中包含锚点证据；
    // 仅返回窗口而无锚点证据视为定位失败。
    const anchored = elements.find((element) => element.identityEvidence.includes('Anchor('));
    if (!anchored) {
      throw new InteractionError('SESSION_ANCHOR_NOT_FOUND',
        `窗口存在但缺少会话锚点证据（sessionHint='${sessionHint}'）；拒绝凭窗口标题绑定`);
    }
    // 输入框/会话区句柄由锚点派生：transport 约定返回锚点元素，宿主层读取其
    // 兄弟输入/转录控件。fixture transport 直接给出句柄族；真实接入按产品实现。
    const bound: BoundSession = {
      sessionId,
      identityEvidence: anchored.identityEvidence,
      inputHandle: `${anchored.handle}#input`,
      transcriptHandle: `${anchored.handle}#transcript`,
      requiresForeground: anchored.requiresForeground,
    };
    this.sessions.set(sessionId, bound);
    return bound;
  }

  verifyBinding(sessionId: string): { ok: boolean; detail: string } {
    const bound = this.sessions.get(sessionId);
    if (!bound) return { ok: false, detail: `会话 ${sessionId} 未绑定或已失效` };
    return { ok: true, detail: bound.identityEvidence };
  }

  /** 读取回复：complete=false 视为片段，显式失败，不当全量使用（不猜）。 */
  async readReplyText(sessionId: string): Promise<{ text: string; complete: boolean }> {
    const bound = this.requireBound(sessionId);
    const read = await this.transport.readText(bound.transcriptHandle);
    if (!read.complete) {
      throw new InteractionError('INCOMPLETE_READ', '控件树只暴露可见片段（虚拟化列表），拒绝作为全量');
    }
    return read;
  }

  /**
   * 发送提示词：前台要求时先激活；写入输入框 → 触发发送 → 回显核对。
   * 回显失败 = SEND_UNVERIFIED（调用方按 unknown 处理，不重发）。
   */
  async sendPrompt(sessionId: string, text: string, _meta: SendPromptMeta): Promise<AdapterSendReceipt> {
    const bound = this.requireBound(sessionId);
    if (bound.requiresForeground) {
      await this.transport.activateForeground(bound.inputHandle);
    }
    await this.transport.setValue(bound.inputHandle, text);
    await this.transport.invoke(bound.inputHandle);
    // 回显核对：转录区应包含本次文本首段（完整长文按前 80 字符核对）。
    const probe = text.slice(0, 80);
    const echoed = await this.transport.readText(bound.transcriptHandle);
    if (!echoed.complete || !echoed.text.includes(probe)) {
      return { status: 'unknown', detail: '发送后未在转录区核对到回显，结果未知（不重发）', messageRef: null };
    }
    return {
      status: 'confirmed',
      detail: '回显核对通过',
      messageRef: `echo-${hashOf(text)}`,
    };
  }

  /**
   * 受控剪贴板恢复：先读当前剪贴板，若已被用户修改则拒绝覆盖（不覆盖新内容）。
   */
  async restoreClipboard(snapshotText: string): Promise<{ restored: boolean; detail: string }> {
    const current = await this.transport.clipboardSnapshot();
    if (current.formats.text !== snapshotText) {
      return { restored: false, detail: '剪贴板已被用户修改，拒绝覆盖' };
    }
    const result = await this.transport.clipboardRestore({ text: snapshotText });
    return result.restored
      ? { restored: true, detail: '剪贴板已恢复' }
      : { restored: false, detail: '恢复未成功（结果未知）' };
  }

  private requireBound(sessionId: string): BoundSession {
    const bound = this.sessions.get(sessionId);
    if (!bound) throw new InteractionError('SESSION_ANCHOR_NOT_FOUND', `会话 ${sessionId} 未绑定`);
    return bound;
  }
}

function hashOf(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}
