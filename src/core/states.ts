// 项目运行状态与轮内阶段（PRD 7.2/7.4）。与旧 workflow 0.2 的差异：
// 无独立审计状态（SUPERVISE_*）；达标停止 stopped_threshold 是终态，
// 不等同旧 COMPLETED 的完整验收含义。
export type ProjectRunState =
  | 'created'
  | 'running'
  | 'paused'
  | 'stopped_threshold'
  | 'stopped_user'
  | 'error';

export type CyclePhase =
  | 'request_evaluation'
  | 'await_evaluation'
  | 'understanding'
  | 'clarify'
  | 'threshold_check'
  | 'dispatch'
  | 'await_execution'
  | 'collect_result';

export type PauseReason =
  | 'user'
  | 'clarify_limit'
  | 'stalled'
  | 'round_timeout'
  | 'model_failure'
  | 'adapter_failure'
  | 'storage_failure'
  | 'unknown_send'
  | 'duplicate_reply'
  | 'binding_lost'
  | 'recovery_pending'
  | 'foreground_required'
  | 'round_limit'
  | 'time_limit';

/** 从任意活跃状态保护性退出（用户暂停/全局停止/异常）。 */
const EXIT_FROM_ANY = new Set<ProjectRunState>(['created', 'running', 'paused']);

/** legalTransitions[from] = 允许的 to 集合。 */
export const legalTransitions: Readonly<Record<ProjectRunState, ReadonlySet<ProjectRunState>>> = {
  created: new Set(['running', 'paused', 'error']),
  running: new Set(['paused', 'stopped_threshold', 'stopped_user', 'error']),
  // 恢复必须由用户触发；stopped_threshold 调高阈值后不自动复活（PRD 15）。
  paused: new Set(['running', 'stopped_user', 'error']),
  stopped_threshold: new Set(['stopped_user']),
  stopped_user: new Set(['created', 'running']),
  error: new Set(['paused']),
};

export function transitionAllowed(from: ProjectRunState, to: ProjectRunState): boolean {
  if (to === 'paused' || to === 'stopped_user' || to === 'error') {
    return EXIT_FROM_ANY.has(from) || from === 'error';
  }
  return legalTransitions[from].has(to);
}

export function assertTransition(from: ProjectRunState, to: ProjectRunState): void {
  if (!transitionAllowed(from, to)) {
    throw new Error(`illegal project state transition: ${from} -> ${to}`);
  }
}

/** 轮内阶段顺序（clarify 后回到 await_evaluation；collect_result 后进入下一轮 request_evaluation）。 */
export const PHASE_ORDER: readonly CyclePhase[] = Object.freeze([
  'request_evaluation',
  'await_evaluation',
  'understanding',
  'clarify',
  'threshold_check',
  'dispatch',
  'await_execution',
  'collect_result',
]);

export interface RunStatusSnapshot {
  state: ProjectRunState;
  phase: CyclePhase | null;
  pauseReason: PauseReason | null;
  roundIndex: number;
}
