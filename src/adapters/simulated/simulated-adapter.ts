// 模拟产品 Adapter（测试/桌面模拟模式专用）：脚本化 A/B 会话，支持故障注入。
// 不代表 Codex/ZCODE 真实兼容；integration 固定为 'simulated'。
import type {
  AdapterCapabilities, AdapterHealth, AdapterSendReceipt, ProductAdapter,
  ProductSessionInfo, SessionReply, SendPromptMeta,
} from '../types.js';
import { AdapterError } from '../types.js';

export interface ScriptedRound {
  total: number;
  basis: string;
  missing: string[];
  prompt: string | null;
}

export interface SimSessionSpec {
  sessionId: string;
  label: string;
  role: 'evaluator' | 'executor';
  /** 评估会话的脚本轮次；执行会话忽略。 */
  script?: ScriptedRound[];
}

export interface SimFaults {
  /** 发送回执注入：confirmed(默认) | unknown | failed。 */
  sendReceipt?: 'confirmed' | 'unknown' | 'failed';
  /** 回复读取注入：normal | incomplete(片段) | duplicate(重复旧回复)。 */
  replyMode?: 'normal' | 'incomplete' | 'duplicate';
  /** 回复延迟（毫秒）。 */
  replyDelayMs?: number;
  /** 绑定失效注入。 */
  bindingLost?: boolean;
}

export const CATALOG: SimSessionSpec[] = [
  {
    sessionId: 'sim-eval-progress',
    label: '模拟A · 65→77→80',
    role: 'evaluator',
    script: [
      { total: 65, basis: '核心循环完成，剩余收尾', missing: ['安装包', '文档'], prompt: '请继续完成收尾项' },
      { total: 77, basis: '收尾推进中', missing: ['安装包'], prompt: '请完成安装包构建' },
      { total: 80, basis: '范围目标已达成', missing: [], prompt: '请做最终回归并汇报' },
      { total: 80, basis: '维持评估', missing: [], prompt: '无进一步任务' },
    ],
  },
  {
    sessionId: 'sim-eval-fast',
    label: '模拟A · 首评83',
    role: 'evaluator',
    script: [
      { total: 83, basis: '首轮即达标', missing: ['发布检查'], prompt: '附加任务：不要发送' },
    ],
  },
  {
    sessionId: 'sim-eval-stall',
    label: '模拟A · 55→55→55',
    role: 'evaluator',
    script: [
      { total: 55, basis: '推进缓慢', missing: ['核心功能'], prompt: '请继续实现核心功能' },
      { total: 55, basis: '推进缓慢', missing: ['核心功能'], prompt: '请继续实现核心功能' },
      { total: 55, basis: '推进缓慢', missing: ['核心功能'], prompt: '请继续实现核心功能' },
    ],
  },
  {
    sessionId: 'sim-eval-vague',
    label: '模拟A · 首轮缺总分',
    role: 'evaluator',
    script: [
      { total: -1, basis: '回复缺总体完成度（触发澄清）', missing: [], prompt: null },
      { total: 68, basis: '澄清后给出总分', missing: ['测试'], prompt: '请补齐测试' },
    ],
  },
  {
    sessionId: 'sim-exec',
    label: '模拟B · 执行会话',
    role: 'executor',
  },
  {
    sessionId: 'sim-eval-progress-b',
    label: '模拟A · 65→77→80（独立副本，多项目隔离测试用）',
    role: 'evaluator',
    script: [
      { total: 65, basis: '核心循环完成，剩余收尾', missing: ['安装包', '文档'], prompt: '请继续完成收尾项' },
      { total: 77, basis: '收尾推进中', missing: ['安装包'], prompt: '请完成安装包构建' },
      { total: 80, basis: '范围目标已达成', missing: [], prompt: '请做最终回归并汇报' },
      { total: 80, basis: '维持评估', missing: [], prompt: '无进一步任务' },
    ],
  },
  {
    sessionId: 'sim-exec-b',
    label: '模拟B · 执行会话（独立副本）',
    role: 'executor',
  },
];

interface PendingReply {
  at: number;
  reply: SessionReply;
}

export class SimulatedAdapter implements ProductAdapter {
  readonly productId = 'simulated';
  private readonly sessions = new Map<string, SimSessionSpec>();
  /** 状态键 = `${ownerId}::${sessionId}`（R9：不同项目互不共享游标与回复）。 */
  private readonly scriptCursor = new Map<string, number>();
  private readonly messageCursor = new Map<string, number>();
  private readonly lastReply = new Map<string, PendingReply>();
  private readonly faults = new Map<string, SimFaults>();
  private readonly defaultFaults: SimFaults;

  constructor(
    specs: SimSessionSpec[] = CATALOG,
    options: { replyDelayMs?: number } = {},
  ) {
    this.defaultFaults = { replyDelayMs: options.replyDelayMs ?? 40 };
    for (const spec of specs) this.sessions.set(spec.sessionId, spec);
  }

  capabilities(): AdapterCapabilities {
    return {
      productId: this.productId,
      readReply: 'background',
      sendPrompt: 'background',
      cancelRunningTask: 'unsupported',
      integration: 'simulated',
      notes: ['模拟会话仅用于本地开发与测试，不代表任何真实产品兼容性'],
    };
  }

  async health(): Promise<AdapterHealth> {
    return { productId: this.productId, status: 'ready', detail: '模拟会话服务可用' };
  }

  async listSessions(): Promise<ProductSessionInfo[]> {
    return [...this.sessions.values()].map((spec) => ({
      productId: this.productId,
      sessionId: spec.sessionId,
      label: spec.label,
    }));
  }

  async verifyBinding(sessionId: string): Promise<{ ok: boolean; detail: string }> {
    if (this.faults.get(sessionId)?.bindingLost) {
      return { ok: false, detail: '注入故障：绑定失效' };
    }
    if (!this.sessions.has(sessionId)) {
      return { ok: false, detail: `未知模拟会话 ${sessionId}` };
    }
    return { ok: true, detail: '模拟会话绑定有效' };
  }

  async sendPrompt(sessionId: string, text: string, meta: SendPromptMeta): Promise<AdapterSendReceipt> {
    const spec = this.sessions.get(sessionId);
    if (!spec) {
      throw new AdapterError('ADAPTER_BINDING_LOST', `未知模拟会话 ${sessionId}`);
    }
    const faults = this.faults.get(meta.ownerId) ?? this.faults.get(sessionId) ?? this.defaultFaults;
    if (faults.bindingLost) {
      throw new AdapterError('ADAPTER_BINDING_LOST', '注入故障：绑定失效');
    }
    // 发送成功后按角色排队一条脚本化回复（ownerId 隔离，R9）。
    const ref = this.nextRef(meta.ownerId, sessionId);
    let reply: SessionReply;
    if (spec.role === 'evaluator') {
      reply = { sessionId, text: this.renderEvaluation(spec, meta.ownerId, sessionId), complete: true, messageRef: ref, receivedAt: new Date().toISOString() };
    } else {
      reply = {
        sessionId,
        text: `执行会话已收到第 ${meta.roundIndex} 轮任务并执行完成。\n任务：${text.slice(0, 120)}\n结果：本轮改动已实现，npm test 通过，无阻塞。`,
        complete: true,
        messageRef: ref,
        receivedAt: new Date().toISOString(),
      };
    }
    const delay = faults.replyDelayMs ?? this.defaultFaults.replyDelayMs ?? 40;
    this.lastReply.set(this.stateKey(meta.ownerId, sessionId), { at: Date.now() + delay, reply });
    const receipt = faults.sendReceipt ?? 'confirmed';
    return {
      status: receipt,
      detail: receipt === 'confirmed' ? '模拟发送已确认' : `注入回执 ${receipt}`,
      messageRef: ref,
    };
  }

  async readReply(sessionId: string, afterMessageRef: string | null, timeoutMs: number, ownerId = ''): Promise<SessionReply | null> {
    const spec = this.sessions.get(sessionId);
    if (!spec) {
      throw new AdapterError('ADAPTER_BINDING_LOST', `未知模拟会话 ${sessionId}`);
    }
    const key = this.stateKey(ownerId, sessionId);
    const faults = this.faults.get(ownerId) ?? this.faults.get(sessionId) ?? this.defaultFaults;
    const deadline = Date.now() + timeoutMs;
    // 等待排队的回复就绪（模拟生成耗时）。
    for (;;) {
      const pending = this.lastReply.get(key);
      if ((pending && Date.now() >= pending.at) || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pending = this.lastReply.get(key);
    if (!pending || Date.now() < pending.at) {
      return null;
    }
    if (pending.reply.messageRef === afterMessageRef) {
      return null; // 没有新回复
    }
    if (faults.replyMode === 'duplicate' && afterMessageRef) {
      // 注入重复：返回上一条已见回复的引用（计数回退一格），供协调端触发去重检测。
      return { ...pending.reply, messageRef: backRef(pending.reply.messageRef) };
    }
    if (faults.replyMode === 'incomplete') {
      return { ...pending.reply, text: pending.reply.text.slice(0, 20), complete: false };
    }
    return pending.reply;
  }

  // ---- 测试辅助（仅测试与模拟模式调用）----

  private stateKey(ownerId: string, sessionId: string): string {
    return `${ownerId}::${sessionId}`;
  }

  setFaults(sessionId: string, faults: SimFaults | null): void {
    if (faults === null) this.faults.delete(sessionId);
    else this.faults.set(sessionId, { ...this.defaultFaults, ...faults });
  }

  resetScript(sessionId: string): void {
    for (const key of this.scriptCursor.keys()) {
      if (key.endsWith(`::${sessionId}`)) this.scriptCursor.delete(key);
    }
  }

  private renderEvaluation(spec: SimSessionSpec, ownerId: string, sessionId: string): string {
    const script = spec.script ?? [];
    const cursorKey = this.stateKey(ownerId, sessionId);
    const cursor = this.scriptCursor.get(cursorKey) ?? 0;
    const round = script[Math.min(cursor, Math.max(script.length - 1, 0))] as ScriptedRound | undefined;
    if (round && cursor < script.length) {
      this.scriptCursor.set(cursorKey, cursor + 1);
    }
    const current = round ?? { total: 50, basis: '（脚本耗尽）', missing: [], prompt: null };
    if (current.total < 0) {
      // 缺总分的模糊回复：触发模型澄清路径。
      return [
        '我核对了当前进展与 PRD 范围。',
        '分项看：核心模块 100%，文档 40%。',
        '缺项：',
        '- 总体完成度未给出',
      ].join('\n');
    }
    const lines = [
      `本轮总体完成度：${current.total}%`,
      `评估依据：${current.basis}`,
      '缺项：',
      ...(current.missing.length > 0 ? current.missing.map((item) => `- ${item}`) : ['- 无']),
    ];
    if (current.prompt !== null) {
      lines.push(`下一轮提示词：「${current.prompt}」`);
    }
    return lines.join('\n');
  }

  private nextRef(ownerId: string, sessionId: string): string {
    const key = this.stateKey(ownerId, sessionId);
    const next = (this.messageCursor.get(key) ?? 0) + 1;
    this.messageCursor.set(key, next);
    return `sim-${sessionId}-${next}`;
  }
}

/** sim-<sessionId>-<n> -> sim-<sessionId>-<n-1>（重复注入用）。 */
function backRef(ref: string): string {
  const match = ref.match(/^(.*)-(\d+)$/);
  if (!match) return ref;
  const n = Math.max(Number(match[2]) - 1, 1);
  return `${match[1]}-${n}`;
}
