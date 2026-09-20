// 项目配置契约：目标、PRD 范围、A/B 绑定、停止阈值与保护性限额。
// 阈值是每次运行的用户配置；不存在默认值（PRD 7.1/FR-05）。
export type ProductId = string; // 由 AdapterRegistry 注册（如 'simulated'、'codex'、'zcode'），核心不按厂商分支

export interface SessionBinding {
  productId: ProductId;
  /** 产品内会话标识；A 与 B 不得绑定同一会话。 */
  sessionId: string;
  label: string | null;
}

export interface RunLimits {
  /** 每轮向 A 的澄清次数上限；超出暂停该项目。 */
  maxClarifyPerRound: number;
  /** 单轮（发评→回传→执行）总时限（毫秒）；超时暂停该项目。 */
  roundTimeoutMs: number;
  /** 单次模型理解调用时限（毫秒）。 */
  modelTimeoutMs: number;
  /** 单次会话发送/读取操作时限（毫秒）。 */
  adapterTimeoutMs: number;
  /** 无进展轮数上限（评估分与内容均无变化）；超出暂停。null 表示不启用。 */
  maxStalledRounds: number | null;
  /** 总轮次上限（异常保护，R9）；超出暂停。 */
  maxRounds: number;
  /** 运行总时长上限（毫秒，异常保护，R9）；超出暂停。 */
  totalBudgetMs: number;
}

export const DEFAULT_LIMITS: Readonly<RunLimits> = Object.freeze({
  maxClarifyPerRound: 2,
  roundTimeoutMs: 30 * 60_000,
  modelTimeoutMs: 120_000,
  adapterTimeoutMs: 60_000,
  maxStalledRounds: null,
  maxRounds: 20,
  totalBudgetMs: 2 * 60 * 60_000,
});

export interface ProjectConfig {
  projectId: string;
  name: string;
  /** 真实工作区路径；核心按实际文件系统语义归并别名。 */
  workspacePath: string;
  goal: string;
  /** PRD 范围引用/版本（如 docs/PRD.md@1.6 或模拟场景名）。 */
  prdRef: string;
  evaluator: SessionBinding; // A
  executor: SessionBinding; // B
  /** 停止阈值（百分数）。必须由用户提供，0 <= threshold <= 100（PRD 7.3 边界含 0 与 100）。 */
  stopThresholdPercent: number;
  limits: RunLimits;
}

export type ProjectConfigErrorCode =
  | 'PROJECT_ID_INVALID'
  | 'NAME_EMPTY'
  | 'WORKSPACE_EMPTY'
  | 'GOAL_EMPTY'
  | 'PRD_REF_EMPTY'
  | 'SESSION_FIELD_INVALID'
  | 'SESSION_SELF_LOOP'
  | 'THRESHOLD_MISSING'
  | 'THRESHOLD_OUT_OF_RANGE'
  | 'LIMITS_INVALID';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class ProjectConfigError extends Error {
  constructor(
    public readonly code: ProjectConfigErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ProjectConfigError';
  }
}

function checkBinding(binding: SessionBinding, role: string): void {
  if (!binding || typeof binding.productId !== 'string' || binding.productId.length === 0) {
    throw new ProjectConfigError('SESSION_FIELD_INVALID', `${role}.productId 必须是非空字符串`);
  }
  if (typeof binding.sessionId !== 'string' || binding.sessionId.length === 0 || binding.sessionId.length > 256) {
    throw new ProjectConfigError('SESSION_FIELD_INVALID', `${role}.sessionId 必须是 1-256 字符`);
  }
  if (binding.label !== null && typeof binding.label !== 'string') {
    throw new ProjectConfigError('SESSION_FIELD_INVALID', `${role}.label 必须是字符串或 null`);
  }
}

/**
 * 校验项目配置。规则来源 PRD 7.1/FR-01/FR-05：
 * - 阈值必须显式提供且 0 < t <= 100（80 只是示例，绝不隐含默认）；
 * - A/B 不得绑定同一会话（同产品同会话即自回路）。
 */
export function validateProjectConfig(config: unknown): ProjectConfig {
  const value = config as Partial<ProjectConfig> | null;
  if (!value || typeof value !== 'object') {
    throw new ProjectConfigError('PROJECT_ID_INVALID', '配置必须是对象');
  }
  if (typeof value.projectId !== 'string' || !ID_PATTERN.test(value.projectId)) {
    throw new ProjectConfigError('PROJECT_ID_INVALID', 'projectId 必须匹配 ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0 || value.name.length > 200) {
    throw new ProjectConfigError('NAME_EMPTY', 'name 必须是 1-200 字符（不可全空白）');
  }
  if (typeof value.workspacePath !== 'string' || value.workspacePath.trim().length === 0) {
    throw new ProjectConfigError('WORKSPACE_EMPTY', 'workspacePath 必须是非空路径');
  }
  if (typeof value.goal !== 'string' || value.goal.trim().length === 0 || value.goal.length > 20_000) {
    throw new ProjectConfigError('GOAL_EMPTY', 'goal 必须是 1-20000 字符');
  }
  if (typeof value.prdRef !== 'string' || value.prdRef.trim().length === 0 || value.prdRef.length > 2_000) {
    throw new ProjectConfigError('PRD_REF_EMPTY', 'prdRef 必须是 1-2000 字符');
  }
  if (!value.evaluator || !value.executor) {
    throw new ProjectConfigError('SESSION_FIELD_INVALID', '必须提供 evaluator(A) 与 executor(B) 绑定');
  }
  checkBinding(value.evaluator, 'evaluator');
  checkBinding(value.executor, 'executor');
  if (
    value.evaluator.productId === value.executor.productId &&
    value.evaluator.sessionId === value.executor.sessionId
  ) {
    throw new ProjectConfigError(
      'SESSION_SELF_LOOP',
      '评估会话与执行会话必须绑定不同会话，不能自回路（PRD FR-01）',
    );
  }
  const threshold = value.stopThresholdPercent;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    throw new ProjectConfigError('THRESHOLD_MISSING', 'stopThresholdPercent 必须显式提供为数字（无默认值）');
  }
  // PRD 7.3：总完成度及阈值均在 0 到 100 之间（含边界），不自行改为 (0,100]。
  if (threshold < 0 || threshold > 100) {
    throw new ProjectConfigError(
      'THRESHOLD_OUT_OF_RANGE',
      `stopThresholdPercent 必须满足 0 <= t <= 100，收到 ${threshold}`,
    );
  }
  const limits = { ...DEFAULT_LIMITS, ...(value.limits ?? {}) } as RunLimits;
  if (
    !Number.isInteger(limits.maxClarifyPerRound) ||
    limits.maxClarifyPerRound < 0 ||
    limits.maxClarifyPerRound > 10 ||
    !Number.isInteger(limits.roundTimeoutMs) ||
    limits.roundTimeoutMs < 1_000 ||
    !Number.isInteger(limits.modelTimeoutMs) ||
    limits.modelTimeoutMs < 100 ||
    !Number.isInteger(limits.adapterTimeoutMs) ||
    limits.adapterTimeoutMs < 100 ||
    (limits.maxStalledRounds !== null &&
      (!Number.isInteger(limits.maxStalledRounds as number) || (limits.maxStalledRounds as number) < 1)) ||
    !Number.isInteger(limits.maxRounds) ||
    limits.maxRounds < 1 ||
    limits.maxRounds > 1_000 ||
    !Number.isInteger(limits.totalBudgetMs) ||
    limits.totalBudgetMs < 60_000
  ) {
    throw new ProjectConfigError('LIMITS_INVALID', '保护性限额数值非法');
  }
  return {
    projectId: value.projectId,
    name: value.name,
    workspacePath: value.workspacePath,
    goal: value.goal,
    prdRef: value.prdRef,
    evaluator: { ...value.evaluator },
    executor: { ...value.executor },
    stopThresholdPercent: threshold,
    limits,
  };
}
