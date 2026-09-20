// 渲染层可见的只读视图（DTO）。renderer 无 Node 权限，只通过 preload 收发这些结构。
import type { ProjectRunState, CyclePhase, PauseReason } from '../core/states.js';
import type { SessionBinding } from './project-config.js';

export interface EvaluationView {
  roundIndex: number;
  totalCompleteness: number;
  basis: string;
  missingItems: string[];
  /** A 给出的下一轮提示词原文（达标停止时保留展示，但不发送）。 */
  nextPrompt: string | null;
  /** A 本轮回复原文（截断到展示上限由 UI 决定）。 */
  replyExcerpt: string;
  understoodAt: string;
}

export interface DispatchView {
  roundIndex: number;
  target: 'executor';
  promptExcerpt: string;
  state: 'pending' | 'sent' | 'confirmed' | 'unknown' | 'aborted';
  at: string;
}

export interface ProjectView {
  projectId: string;
  name: string;
  workspacePath: string;
  goalExcerpt: string;
  prdRef: string;
  evaluator: SessionBinding;
  executor: SessionBinding;
  stopThresholdPercent: number;
  state: ProjectRunState;
  phase: CyclePhase | null;
  pauseReason: PauseReason | null;
  roundIndex: number;
  startedAt: string | null;
  stoppedAt: string | null;
  /** 最近一次评估；无则为 null。 */
  lastEvaluation: EvaluationView | null;
  /** 最近一次派发状态；无则为 null。 */
  lastDispatch: DispatchView | null;
  /** 停止/暂停原因说明（人类可读，含证据指向）。 */
  statusDetail: string | null;
}

export type RunMode = 'simulated' | 'production';

export interface ModelStatusView {
  mode: RunMode;
  /** 模拟模式下为内置假模型服务地址；生产模式下为用户配置的 Ollama 地址。 */
  endpoint: string;
  reachable: boolean;
  model: string;
  lastError: string | null;
}

export interface AppStatusView {
  mode: RunMode;
  model: ModelStatusView;
  projects: ProjectView[];
  /** 前台操作队列可见状态（当前拥有者与排队数）。 */
  foreground: { activeOwner: string | null; queued: number };
  /** 专用前台自动操作模式开关（显式开启/撤销，PRD FR-20）。 */
  foregroundModeEnabled: boolean;
  globalStop: boolean;
}

export interface RecordItem {
  kind: 'evaluation_request' | 'evaluation_reply' | 'clarify' | 'prompt_dispatch' | 'execution_result' | 'threshold_change' | 'event';
  roundIndex: number | null;
  at: string;
  excerpt: string;
  meta: Record<string, unknown>;
}

export interface AuditEventItem {
  at: string;
  type: string;
  projectId: string | null;
  data: Record<string, unknown>;
}
