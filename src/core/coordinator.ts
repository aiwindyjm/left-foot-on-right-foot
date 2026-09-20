// 协调核心（W3，A-R1 重构）：每项目一条循环；模型只理解，A 评分，程序守卫与阈值。
// R4 取消令牌：运行代数(gen)贯穿绑定/排队/发送/读取每个 await 边界；
//   发送统一经超时包装（超时=unknown，不标"未发出"）；取消发生在 sendPrompt 调用前
//   才允许把 pending 意图标 aborted，飞行中的按真实回执落库。
// R5 恢复判定：一律依据持久化意图与执行结果（不依赖可被清空的 UI 原因字段）；
//   confirmed 但未回收结果的执行任务同样视为在途需人工核对。
// R6 统一理解循环：A 的每条完整新回复（含澄清后）都进入同一模型理解→评估落库→
//   最新阈值判定路径；澄清达标即停，不直接正则抓取发送。
// R7 前台路由：能力驱动——sendPrompt/readReply 声明 foreground 的 Adapter 操作
//   进入统一前台队列；专用前台模式未开启时显式暂停（foreground_required）。
// R9 上下文：B 结果完整回传给 A（不静默截断）；回复核对 sessionId；
//   会话绑定互斥；总轮次/总时长预算；模拟层按项目隔离。
import type { ProductAdapter } from '../adapters/types.js';
import { AdapterError } from '../adapters/types.js';
import { ModelError, type UnderstandOutcome } from '../shared/ai-contract.js';
import {
  DEFAULT_LIMITS, validateProjectConfig,
  type ProjectConfig,
} from '../shared/project-config.js';
import type {
  AppStatusView, DispatchView, EvaluationView, ModelStatusView, ProjectView, RecordItem,
} from '../shared/views.js';
import type { CyclePhase, PauseReason, ProjectRunState } from './states.js';
import { assertTransition } from './states.js';
import { ForegroundQueue, SerialQueue } from './queues.js';
import { WorkspaceRegistry, resolveWorkspace } from './workspace-lock.js';
import { SessionRegistry } from './session-lock.js';
import type { RecordStore } from '../storage/records.js';
import type { IntentRow } from '../storage/database.js';
import type { CoordinationModel } from '../ollama/model-service.js';

export interface CoordinatorDeps {
  store: RecordStore;
  model: CoordinationModel;
  adapters: Map<string, ProductAdapter>;
  modelQueue: SerialQueue;
  foregroundQueue: ForegroundQueue;
  workspaces: WorkspaceRegistry;
  sessions: SessionRegistry;
  mode: 'simulated' | 'production';
  emitLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  onStatus?: (() => void) | undefined;
  pollIntervalMs?: number | undefined;
}

interface ProjectRuntime {
  config: ProjectConfig;
  workspaceKey: string;
  /** 运行代数：start/pause/stop 递增；loop 持有启动时代数，await 边界核对。 */
  gen: number;
  state: ProjectRunState;
  phase: CyclePhase | null;
  pauseReason: PauseReason | null;
  statusDetail: string | null;
  roundIndex: number;
  startedAtMs: number | null;
  stoppedAt: string | null;
  lastEvaluation: EvaluationView | null;
  lastDispatch: DispatchView | null;
  /** B 最近完整结果（完整回传给 A，不截断）。 */
  lastResultFull: string | null;
  lastASessionRef: string | null;
  lastBSessionRef: string | null;
  lastRoundSignature: string | null;
  stalledRounds: number;
  loop: AbortController | null;
  /** 正在飞行的发送意图（sendPrompt 已调用未返回）。 */
  inFlightIntent: number | null;
  heldSessions: Array<{ productId: string; sessionId: string }>;
  /** 工作区锁是否仍被本项目占用（未决外部任务时保留）。 */
  holdsWorkspace: boolean;
}

export type CoordResult = { ok: true } | { ok: false; code: string; message: string };

const EVAL_REQUEST_TEMPLATE = (goal: string, prdRef: string, resultFull: string | null) => [
  '请根据既定目标和本次 PRD 范围，核对以下执行结果与项目进展。',
  '给出本轮总体完成度（0 到 100%）及简要评估依据，列出缺损项目，',
  '再给出收口计划和一段可直接发给执行会话的提示词（用「」完整引用）。',
  '请区分整个约定范围的完成度与单个任务的完成度，不要改变目标或扩大范围。',
  `项目目标：${goal}`,
  `PRD 范围：${prdRef}`,
  resultFull ? `执行会话 B 的最近完整结果：\n${resultFull}` : '本轮为初始回归评估（尚无执行结果）。',
].join('\n');

const CLARIFY_TOTAL = '请明确给出本轮总体完成度（0-100% 的单一数字），不要只给分项或区间。';
const CLARIFY_PROMPT = '尚未达到停止阈值。请给出下一轮可直接发送给执行会话的提示词（用「」完整引用）。';

export class Coordinator {
  private readonly projects = new Map<string, ProjectRuntime>();
  private globalStop = false;
  /** 专用前台自动操作模式（PRD FR-20）：显式开启后才允许前台副作用。 */
  private foregroundModeEnabled = false;

  constructor(private readonly deps: CoordinatorDeps) {}

  // ---- 生命周期 ----

  /** 服务启动：载入持久化项目；恢复 roundIndex/上下文；未决任务（含确认在途）要求人工核对。 */
  loadPersisted(): void {
    for (const row of this.deps.store.listProjects()) {
      const config = rowToConfig(row);
      const external = this.deps.store.hasUnresolvedExternalTask(config.projectId);
      const lastResult = this.deps.store.lastExecutionResult(config.projectId);
      const roundIndex = this.deps.store.lastRoundIndex(config.projectId);
      this.projects.set(config.projectId, {
        config,
        workspaceKey: row.workspace_key,
        gen: 0,
        state: 'paused',
        phase: null,
        pauseReason: external.unresolved ? 'recovery_pending' : null,
        statusDetail: external.unresolved
          ? `重启核对：${external.detail}；人工核对（放弃或确认不再等待）后方可恢复`
          : '服务重启后默认暂停，可手动恢复运行',
        roundIndex,
        startedAtMs: null,
        stoppedAt: null,
        lastEvaluation: null,
        lastDispatch: null,
        lastResultFull: lastResult?.content ?? null,
        lastASessionRef: null,
        lastBSessionRef: lastResult?.messageRef ?? null,
        lastRoundSignature: null,
        stalledRounds: 0,
        loop: null,
        inFlightIntent: null,
        heldSessions: [],
        holdsWorkspace: false,
      });
    }
  }

  dispose(): void {
    for (const runtime of this.projects.values()) {
      runtime.gen += 1;
      runtime.loop?.abort(new Error('coordinator dispose'));
    }
  }

  // ---- 前台模式与全局停止 ----

  setForegroundMode(enabled: boolean): CoordResult {
    this.foregroundModeEnabled = enabled === true;
    this.deps.store.addEvent(null, 'foreground_mode_changed', { enabled: this.foregroundModeEnabled });
    if (!this.foregroundModeEnabled) {
      for (const runtime of this.projects.values()) {
        if (runtime.state === 'running') {
          this.pause(runtime, 'foreground_required', '前台模式已撤销：需前台操作的项目停止新动作');
        }
      }
    }
    this.notifyStatus();
    return { ok: true };
  }

  resumeAll(): CoordResult {
    // 解除全局停止（不自动复活任何项目；项目仍需显式启动）。
    this.globalStop = false;
    this.deps.store.addEvent(null, 'global_stop_lifted', {});
    this.notifyStatus();
    return { ok: true };
  }

  // ---- 项目管理命令 ----

  createProject(input: { config: unknown }): CoordResult {
    let config: ProjectConfig;
    try {
      config = validateProjectConfig(input.config);
    } catch (error) {
      return { ok: false, code: 'CONFIG_INVALID', message: error instanceof Error ? error.message : String(error) };
    }
    if (this.projects.has(config.projectId)) {
      return { ok: false, code: 'PROJECT_EXISTS', message: `项目 ${config.projectId} 已存在` };
    }
    if (!this.deps.adapters.has(config.evaluator.productId) || !this.deps.adapters.has(config.executor.productId)) {
      return { ok: false, code: 'PRODUCT_UNKNOWN', message: '评估或执行产品未注册' };
    }
    const resolved = resolveWorkspace(config.workspacePath);
    const conflict = this.deps.store.findWorkspaceConflict(resolved.workspaceKey, config.projectId);
    if (conflict) {
      return {
        ok: false,
        code: 'WORKSPACE_CONFLICT',
        message: `工作区已被项目 ${conflict.name}（${conflict.project_id}）占用：${resolved.normalizedPath}`,
      };
    }
    // R9：父子目录重叠视为同一写入域，拒绝配置。
    for (const existing of this.deps.store.listProjects()) {
      if (overlapsPath(existing.workspace_path, config.workspacePath)) {
        return {
          ok: false,
          code: 'WORKSPACE_CONFLICT',
          message: `工作区与项目 ${existing.project_id} 的目录存在父子重叠：${resolved.normalizedPath}`,
        };
      }
    }
    try {
      this.deps.store.insertProject(config, resolved.workspaceKey);
    } catch (error) {
      return { ok: false, code: 'STORAGE_FAILURE', message: error instanceof Error ? error.message : String(error) };
    }
    this.deps.store.addEvent(config.projectId, 'project_created', { name: config.name, threshold: config.stopThresholdPercent });
    this.projects.set(config.projectId, {
      config,
      workspaceKey: resolved.workspaceKey,
      gen: 0,
      state: 'created',
      phase: null,
      pauseReason: null,
      statusDetail: null,
      roundIndex: 0,
      startedAtMs: null,
      stoppedAt: null,
      lastEvaluation: null,
      lastDispatch: null,
      lastResultFull: null,
      lastASessionRef: null,
      lastBSessionRef: null,
      lastRoundSignature: null,
      stalledRounds: 0,
      loop: null,
      inFlightIntent: null,
      heldSessions: [],
      holdsWorkspace: false,
    });
    this.notifyStatus();
    return { ok: true };
  }

  updateProject(projectId: string, patch: { name?: string; goal?: string; prdRef?: string }): CoordResult {
    const runtime = this.projects.get(projectId);
    if (!runtime) return { ok: false, code: 'PROJECT_NOT_FOUND', message: `项目不存在：${projectId}` };
    if (runtime.state === 'running') {
      return { ok: false, code: 'PROJECT_RUNNING', message: '运行中的项目不允许修改文本配置，请先暂停' };
    }
    try {
      this.deps.store.updateProjectText(projectId, patch);
    } catch (error) {
      return { ok: false, code: 'STORAGE_FAILURE', message: error instanceof Error ? error.message : String(error) };
    }
    if (patch.name !== undefined) runtime.config.name = patch.name;
    if (patch.goal !== undefined) runtime.config.goal = patch.goal;
    if (patch.prdRef !== undefined) runtime.config.prdRef = patch.prdRef;
    this.deps.store.addEvent(projectId, 'project_updated', { fields: Object.keys(patch) });
    this.notifyStatus();
    return { ok: true };
  }

  setThreshold(projectId: string, threshold: number): CoordResult {
    const runtime = this.projects.get(projectId);
    if (!runtime) return { ok: false, code: 'PROJECT_NOT_FOUND', message: `项目不存在：${projectId}` };
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      return { ok: false, code: 'THRESHOLD_INVALID', message: '阈值必须满足 0 <= t <= 100' };
    }
    try {
      const { oldValue } = this.deps.store.setThreshold(projectId, threshold, 'user');
      runtime.config.stopThresholdPercent = threshold;
      this.deps.store.addEvent(projectId, 'threshold_changed', { from: oldValue, to: threshold });
    } catch (error) {
      return { ok: false, code: 'STORAGE_FAILURE', message: error instanceof Error ? error.message : String(error) };
    }
    this.notifyStatus();
    return { ok: true };
  }

  /** 启动/恢复判定依据持久化状态（R5）：存在未决意图或在途外部任务即要求人工核对。 */
  startProject(projectId: string): CoordResult {
    const runtime = this.projects.get(projectId);
    if (!runtime) return { ok: false, code: 'PROJECT_NOT_FOUND', message: `项目不存在：${projectId}` };
    if (this.globalStop) {
      return {
        ok: false,
        code: 'GLOBAL_STOPPED',
        message: '全局停止已生效；请先显式解除全局停止（不会自动复活任何项目）',
      };
    }
    if (runtime.state === 'stopped_threshold' || runtime.state === 'stopped_user') {
      if (runtime.state === 'stopped_threshold') {
        assertTransition(runtime.state, 'stopped_user');
        runtime.state = 'stopped_user';
        this.deps.store.addEvent(projectId, 'restart_after_threshold_stop', {});
      }
      assertTransition(runtime.state, 'created');
      runtime.state = 'created';
      runtime.roundIndex = 0;
      runtime.lastEvaluation = null;
      runtime.lastDispatch = null;
      runtime.lastRoundSignature = null;
      runtime.stalledRounds = 0;
      // 重新开始保留 B 的最近结果作为上下文（lastResultFull）。
    }
    if (runtime.state !== 'created' && runtime.state !== 'paused') {
      return { ok: false, code: 'STATE_INVALID', message: `当前状态 ${runtime.state} 不可启动` };
    }
    const external = this.deps.store.hasUnresolvedExternalTask(projectId);
    if (external.unresolved) {
      // R5 分级：executor 在途/任何 unknown/pending/sent 必须人工核对；
      // 仅 evaluator confirmed 在途（评估请求无执行副作用）时放行并作废旧请求。
      if (!external.evaluatorInFlight) {
        runtime.pauseReason = 'recovery_pending';
        runtime.statusDetail = `${external.detail}；人工核对（放弃该派发或确认不再等待）后方可恢复`;
        this.notifyStatus();
        return {
          ok: false,
          code: 'RECOVERY_PENDING',
          message: runtime.statusDetail,
        };
      }
      this.deps.store.addEvent(projectId, 'stale_evaluator_request_discarded', {
        intentId: external.intentId, detail: external.detail,
      });
      const stale = external.intentId !== null ? this.deps.store.getIntent(external.intentId) : undefined;
      if (stale) {
        this.deps.store.resolveIntent(stale.intent_id, 'aborted', '恢复时作废在途评估请求（重新发起，无执行副作用）');
      }
    }
    const holder = this.deps.workspaces.tryAcquire(runtime.workspaceKey, projectId);
    if (holder !== null) {
      return {
        ok: false,
        code: 'WORKSPACE_CONFLICT',
        message: `工作区正被项目 ${holder} 执行占用（每目录最多一个在途执行）`,
      };
    }
    runtime.holdsWorkspace = true;
    // 会话互斥（R9）：评估与执行绑定都不得与其他项目并发复用。
    for (const binding of [runtime.config.evaluator, runtime.config.executor]) {
      const sessionHolder = this.deps.sessions.tryAcquire(binding.productId, binding.sessionId, projectId);
      if (sessionHolder !== null) {
        this.releaseHeldSessions(runtime);
        this.deps.workspaces.release(runtime.workspaceKey, projectId);
        runtime.holdsWorkspace = false;
        return {
          ok: false,
          code: 'SESSION_CONFLICT',
          message: `${binding.productId} 会话 ${binding.sessionId} 正被项目 ${sessionHolder} 使用（同一会话不能并发服务两个项目）`,
        };
      }
      runtime.heldSessions.push({ productId: binding.productId, sessionId: binding.sessionId });
    }
    assertTransition(runtime.state, 'running');
    runtime.state = 'running';
    runtime.pauseReason = null;
    runtime.statusDetail = null;
    runtime.startedAtMs = Date.now();
    runtime.gen += 1;
    this.deps.store.addEvent(projectId, 'project_started', { roundIndex: runtime.roundIndex });
    this.launchLoop(runtime);
    this.notifyStatus();
    return { ok: true };
  }

  pauseProject(projectId: string, reason: PauseReason = 'user'): CoordResult {
    const runtime = this.projects.get(projectId);
    if (!runtime) return { ok: false, code: 'PROJECT_NOT_FOUND', message: `项目不存在：${projectId}` };
    if (runtime.state !== 'running' && runtime.state !== 'created') {
      return { ok: false, code: 'STATE_INVALID', message: `当前状态 ${runtime.state} 不可暂停` };
    }
    runtime.gen += 1;
    runtime.loop?.abort(new Error('pause'));
    assertTransition(runtime.state, 'paused');
    runtime.state = 'paused';
    runtime.pauseReason = reason;
    runtime.phase = null;
    runtime.statusDetail = `已暂停（${reason}）；当前轮次 ${runtime.roundIndex} 保留，恢复后重新发起本轮评估`;
    this.releaseHeldSessions(runtime);
    this.deps.store.addEvent(projectId, 'project_paused', { reason });
    this.notifyStatus();
    return { ok: true };
  }

  resumeProject(projectId: string): CoordResult {
    return this.startProject(projectId);
  }

  stopProject(projectId: string, detail = '用户停止'): CoordResult {
    const runtime = this.projects.get(projectId);
    if (!runtime) return { ok: false, code: 'PROJECT_NOT_FOUND', message: `项目不存在：${projectId}` };
    runtime.gen += 1;
    runtime.loop?.abort(new Error('stop'));
    if (runtime.state !== 'stopped_user') {
      assertTransition(runtime.state, 'stopped_user');
      runtime.state = 'stopped_user';
    }
    runtime.phase = null;
    runtime.pauseReason = null;
    runtime.stoppedAt = new Date().toISOString();
    this.releaseHeldSessions(runtime);
    // R4：停止≠外部已停止。存在未决意图或确认在途任务时保留工作区锁，
    // 状态说明外部可能仍在运行；人工核对（abandonIntent）后释放。
    const external = this.deps.store.hasUnresolvedExternalTask(projectId);
    if (external.unresolved) {
      runtime.statusDetail = `${detail}。${external.detail}；系统已停止新派发，工作区保护保留。`;
    } else {
      runtime.statusDetail = `${detail}；外部会话是否仍在运行未确认（系统已停止新派发）。`;
      if (runtime.holdsWorkspace) {
        this.deps.workspaces.release(runtime.workspaceKey, projectId);
        runtime.holdsWorkspace = false;
      }
    }
    // 飞行中的发送由 runRound 收尾按真实回执落库；这里不猜测"未发出"。
    this.deps.store.addEvent(projectId, 'project_stopped', { detail });
    this.notifyStatus();
    return { ok: true };
  }

  stopAll(): CoordResult {
    this.globalStop = true;
    for (const runtime of this.projects.values()) {
      if (runtime.state === 'running' || runtime.state === 'paused' || runtime.state === 'created') {
        this.stopProject(runtime.config.projectId, '全局停止');
      }
    }
    this.deps.store.addEvent(null, 'global_stop', {});
    this.notifyStatus();
    return { ok: true };
  }

  abandonIntent(projectId: string, intentId: number): CoordResult {
    const runtime = this.projects.get(projectId);
    if (!runtime) return { ok: false, code: 'PROJECT_NOT_FOUND', message: `项目不存在：${projectId}` };
    const intent = this.deps.store.getIntent(intentId);
    if (!intent || intent.project_id !== projectId) {
      return { ok: false, code: 'INTENT_NOT_FOUND', message: `意图 ${intentId} 不属于项目 ${projectId}` };
    }
    if (intent.state === 'aborted') {
      return { ok: false, code: 'INTENT_RESOLVED', message: `意图 ${intentId} 已放弃` };
    }
    // R5：confirmed（含在途执行）也允许人工放弃等待；unknown/pending/sent 放弃=不重发。
    this.deps.store.resolveIntent(intentId, 'aborted',
      intent.state === 'confirmed' ? '人工确认放弃等待在途任务（不代表外部已停止）' : '人工核对后放弃（不重发）');
    this.deps.store.addEvent(projectId, 'intent_abandoned', { intentId, previousState: intent.state });
    const external = this.deps.store.hasUnresolvedExternalTask(projectId);
    if (!external.unresolved) {
      if (runtime.pauseReason === 'recovery_pending') {
        runtime.pauseReason = null;
        runtime.statusDetail = '未确认派发已人工核对放弃；可手动恢复运行';
      }
      // 未决清空后释放保留的工作区保护。
      if (runtime.state !== 'running' && runtime.holdsWorkspace) {
        this.deps.workspaces.release(runtime.workspaceKey, projectId);
        runtime.holdsWorkspace = false;
      }
    }
    this.notifyStatus();
    return { ok: true };
  }

  // ---- 查询 ----

  getStatus(): AppStatusView {
    const foreground = this.deps.foregroundQueue.active;
    return {
      mode: this.deps.mode,
      model: {
        mode: this.deps.mode,
        endpoint: this.deps.model.endpoint,
        reachable: true,
        model: this.deps.model.name,
        lastError: null,
      },
      projects: [...this.projects.values()].map((runtime) => this.toView(runtime)),
      foreground: { activeOwner: foreground.owner, queued: foreground.queued },
      foregroundModeEnabled: this.foregroundModeEnabled,
      globalStop: this.globalStop,
    };
  }

  async checkModel(): Promise<ModelStatusView> {
    const base = {
      mode: this.deps.mode,
      endpoint: this.deps.model.endpoint,
      model: this.deps.model.name,
    };
    if (typeof this.deps.model.health !== 'function') {
      return { ...base, reachable: false, lastError: '模型客户端不支持健康检查' };
    }
    try {
      await this.deps.model.health(3_000);
      return { ...base, reachable: true, lastError: null };
    } catch (error) {
      return { ...base, reachable: false, lastError: error instanceof Error ? error.message : String(error) };
    }
  }

  listRecords(projectId: string, limit: number): RecordItem[] {
    const records: RecordItem[] = [];
    for (const message of this.deps.store.listMessages(projectId, limit)) {
      records.push({
        kind: message.kind as RecordItem['kind'],
        roundIndex: message.round_index,
        at: message.created_at,
        excerpt: message.content.slice(0, 2_000),
        meta: { direction: message.direction, messageRef: message.message_ref },
      });
    }
    for (const intent of this.deps.store.listIntents(projectId, limit)) {
      records.push({
        kind: 'prompt_dispatch',
        roundIndex: intent.round_index,
        at: intent.created_at,
        excerpt: intent.payload_excerpt.slice(0, 2_000),
        meta: {
          intentId: intent.intent_id,
          state: intent.state,
          detail: intent.receipt_detail,
          target: intent.target,
        },
      });
    }
    for (const change of this.deps.store.listThresholdChanges(projectId, limit)) {
      records.push({
        kind: 'threshold_change',
        roundIndex: null,
        at: change.created_at,
        excerpt: `阈值 ${change.old_value} -> ${change.new_value}`,
        meta: { reason: change.reason },
      });
    }
    return records.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
  }

  listEvents(projectId: string | null, limit: number) {
    return this.deps.store.listEvents(projectId, limit).map((row) => ({
      at: row.created_at,
      type: row.type,
      projectId: row.project_id,
      data: JSON.parse(row.data_json) as Record<string, unknown>,
    }));
  }

  // ---- 循环实现 ----

  private launchLoop(runtime: ProjectRuntime): void {
    const controller = new AbortController();
    runtime.loop = controller;
    const gen = runtime.gen;
    const projectId = runtime.config.projectId;
    void this.runLoop(runtime, gen)
      .catch((error) => {
        this.deps.emitLog?.('error', `项目 ${projectId} 循环异常退出：${error instanceof Error ? error.message : String(error)}`);
        if (runtime.state === 'running' && runtime.gen === gen) {
          runtime.state = 'error';
          runtime.statusDetail = `循环异常：${error instanceof Error ? error.message : String(error)}`;
          this.releaseHeldSessions(runtime);
          if (runtime.holdsWorkspace) {
            this.deps.workspaces.release(runtime.workspaceKey, projectId);
            runtime.holdsWorkspace = false;
          }
        }
        this.notifyStatus();
      })
      .finally(() => {
        if (runtime.loop === controller) runtime.loop = null;
      });
  }

  private async runLoop(runtime: ProjectRuntime, gen: number): Promise<void> {
    const pollMs = this.deps.pollIntervalMs ?? 100;
    while (
      runtime.state === 'running'
      && runtime.gen === gen
      && !this.globalStop
      && !this.abortSignalFired(runtime, gen)
    ) {
      const limits = runtime.config.limits;
      if (runtime.roundIndex >= limits.maxRounds) {
        this.pause(runtime, 'round_limit', `已达总轮次上限 ${limits.maxRounds}，暂停（异常保护）`);
        break;
      }
      const elapsed = runtime.startedAtMs !== null ? Date.now() - runtime.startedAtMs : 0;
      if (elapsed >= limits.totalBudgetMs) {
        this.pause(runtime, 'time_limit', `已达运行总时长上限，暂停（异常保护）`);
        break;
      }
      runtime.roundIndex += 1;
      const roundDeadline = Math.min(
        Date.now() + limits.roundTimeoutMs,
        runtime.startedAtMs !== null ? runtime.startedAtMs + limits.totalBudgetMs : Number.MAX_SAFE_INTEGER,
      );
      this.setPhase(runtime, 'request_evaluation');
      const outcome = await this.runRound(runtime, gen, roundDeadline, pollMs);
      if (outcome !== 'continue') break;
    }
  }

  private abortSignalFired(_runtime: ProjectRuntime, _gen: number): boolean {
    return false; // 保留扩展点：当前取消经 AbortController 与 gen 核对实现。
  }

  /** 运行代数与状态核对：每个 await 边界之后必须调用。 */
  private ensureActive(runtime: ProjectRuntime, gen: number): boolean {
    return runtime.gen === gen && runtime.state === 'running' && !this.globalStop;
  }

  /**
   * 单轮循环（R6 统一理解循环）：
   * 评估请求 → [收到 A 新回复 → 模型理解 → (澄清:发送后回到等待) → 评估落库 →
   * 最新阈值判定 → 达标停 / 缺提示词且预算未耗尽发澄清后回环 / 有提示词派发 B →
   * 回收结果]。
   * 返回 'continue' 进入下一轮；'stop' 结束循环（状态已由 pause/stop 设置）。
   */
  private async runRound(
    runtime: ProjectRuntime, gen: number, deadline: number, pollMs: number,
  ): Promise<'continue' | 'stop'> {
    const { config } = runtime;
    const projectId = config.projectId;
    const limits = config.limits;
    let clarifyCount = 0;

    const evaluator = this.requireAdapter(config.evaluator.productId);
    const executor = this.requireAdapter(config.executor.productId);

    // 1) 评估请求（统一意图：先落库，发送统一超时包装）
    this.setPhase(runtime, 'request_evaluation');
    const requestText = EVAL_REQUEST_TEMPLATE(config.goal, config.prdRef, runtime.lastResultFull);
    const evalDispatch = await this.dispatch(
      runtime, gen, evaluator, config.evaluator.sessionId, requestText,
      { roundIndex: runtime.roundIndex, target: 'evaluator', label: 'eval-request' },
    );
    if (typeof evalDispatch !== 'object') return 'stop';
    if (evalDispatch.receipt.status !== 'confirmed') {
      return this.pause(runtime,
        evalDispatch.receipt.status === 'unknown' ? 'unknown_send' : 'adapter_failure',
        `评估请求${evalDispatch.receipt.status === 'unknown' ? '回执未知' : '发送失败'}：${evalDispatch.receipt.detail}`);
    }
    this.deps.store.insertMessage({
      projectId, runId: null, roundIndex: runtime.roundIndex, direction: 'to_a',
      kind: 'evaluation_request', content: requestText, messageRef: evalDispatch.receipt.messageRef,
    });
    this.deps.store.addEvent(projectId, 'evaluation_request_sent', { roundIndex: runtime.roundIndex });

    // 2) 统一理解循环：A 的每条完整新回复都走同一理解/评估/阈值路径。
    for (;;) {
      if (!this.ensureActive(runtime, gen)) return 'stop';
      this.setPhase(runtime, 'await_evaluation');
      const budget = deadline - Date.now();
      const reply = await this.awaitReply(
        runtime, gen, evaluator, config.evaluator.sessionId, runtime.lastASessionRef, budget, pollMs,
      );
      if (reply === 'aborted' || reply === 'paused') return 'stop';
      if (reply === 'timeout') {
        return this.pause(runtime, 'round_timeout', '等待评估回复超时');
      }
      if (reply.complete !== true) {
        return this.pause(runtime, 'adapter_failure', '评估回复读取不完整（虚拟列表片段），拒绝作为全量处理');
      }
      const duplicate = reply.messageRef !== null
        && this.deps.store.findMessageByRef(projectId, 'from_a', reply.messageRef);
      if (duplicate) {
        this.deps.store.addEvent(projectId, 'duplicate_reply_ignored', {
          roundIndex: runtime.roundIndex, messageRef: reply.messageRef,
        });
        if (Date.now() >= deadline) {
          return this.pause(runtime, 'round_timeout', '等待评估回复超时（重复回复未产生新进展）');
        }
        continue; // 重复回复不算新进展，继续等待。
      }
      const messageId = this.deps.store.insertMessage({
        projectId, runId: null, roundIndex: runtime.roundIndex,
        direction: 'from_a', kind: 'evaluation_reply', content: reply.text, messageRef: reply.messageRef,
      });
      runtime.lastASessionRef = reply.messageRef;

      // 本地模型理解（串行队列；取消令牌传入 signal）。
      this.setPhase(runtime, 'understanding');
      let outcome: UnderstandOutcome;
      try {
        outcome = await this.deps.modelQueue.submit({
          label: `${projectId}#understand-r${runtime.roundIndex}`,
          timeoutMs: limits.modelTimeoutMs,
          run: async (signal) => {
            if (!this.ensureActive(runtime, gen)) {
              throw new ModelError('MODEL_TIMEOUT', 'cancelled before model call');
            }
            return this.deps.model.understand(
              { goal: config.goal, prdRef: config.prdRef, roundIndex: runtime.roundIndex, reply: reply.text },
              limits.modelTimeoutMs, signal,
            );
          },
        });
      } catch (error) {
        if (error instanceof ModelError) {
          return this.pause(runtime, 'model_failure', `本地模型失败（${error.code}）：${error.message}`);
        }
        return this.pause(runtime, 'model_failure', `本地模型队列失败：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!this.ensureActive(runtime, gen)) return 'stop';

      if (outcome.kind === 'clarify') {
        if (clarifyCount >= limits.maxClarifyPerRound) {
          return this.pause(runtime, 'clarify_limit', `澄清次数达上限（${limits.maxClarifyPerRound}）仍无法明确评估`);
        }
        clarifyCount += 1;
        this.setPhase(runtime, 'clarify');
        this.deps.store.insertMessage({
          projectId, runId: null, roundIndex: runtime.roundIndex, direction: 'to_a',
          kind: 'clarify', content: outcome.question, messageRef: null,
        });
        this.deps.store.addEvent(projectId, 'clarify_sent', { roundIndex: runtime.roundIndex, count: clarifyCount });
        const clarifyDispatch = await this.dispatch(
          runtime, gen, evaluator, config.evaluator.sessionId, outcome.question,
          { roundIndex: runtime.roundIndex, target: 'evaluator', label: `clarify-${clarifyCount}` },
        );
        if (typeof clarifyDispatch !== 'object') return 'stop';
        if (clarifyDispatch.receipt.status !== 'confirmed') {
          return this.pause(runtime,
            clarifyDispatch.receipt.status === 'unknown' ? 'unknown_send' : 'adapter_failure',
            `澄清发送${clarifyDispatch.receipt.status}：${clarifyDispatch.receipt.detail}`);
        }
        continue; // 澄清后的新回复回到同一理解路径。
      }

      // 3) 评估落库 + 最新阈值判定。
      this.deps.store.insertEvaluation({
        projectId,
        roundIndex: runtime.roundIndex,
        replyMessageId: messageId,
        totalCompleteness: outcome.totalCompleteness,
        basis: outcome.basis,
        missingItems: outcome.missingItems,
        nextPrompt: outcome.nextPrompt,
        modelUsed: this.deps.model.name,
      });
      runtime.lastEvaluation = {
        roundIndex: runtime.roundIndex,
        totalCompleteness: outcome.totalCompleteness,
        basis: outcome.basis,
        missingItems: outcome.missingItems,
        nextPrompt: outcome.nextPrompt,
        replyExcerpt: reply.text.slice(0, 500),
        understoodAt: new Date().toISOString(),
      };
      this.notifyStatus();

      this.setPhase(runtime, 'threshold_check');
      // 发送前再读当前配置（等待期间用户可能已修改阈值/目标）。
      const currentThreshold = runtime.config.stopThresholdPercent;
      const reached = outcome.totalCompleteness >= currentThreshold;
      const signature = `${outcome.totalCompleteness}|${outcome.missingItems.join(',')}|${outcome.nextPrompt ?? ''}`;
      if (signature === runtime.lastRoundSignature) {
        runtime.stalledRounds += 1;
        const cap = limits.maxStalledRounds;
        if (cap !== null && runtime.stalledRounds >= cap) {
          return this.pause(runtime, 'stalled', `连续 ${runtime.stalledRounds} 轮评估无进展`);
        }
      } else {
        runtime.stalledRounds = 0;
        runtime.lastRoundSignature = signature;
      }
      if (reached) {
        runtime.state = 'stopped_threshold';
        runtime.phase = null;
        runtime.statusDetail = `达到停止阈值 ${currentThreshold}%（本轮 ${outcome.totalCompleteness}%），停止新派发`;
        if (outcome.nextPrompt !== null) {
          this.deps.store.addEvent(projectId, 'threshold_stop_suppressed_prompt', {
            roundIndex: runtime.roundIndex, total: outcome.totalCompleteness, threshold: currentThreshold,
          });
        }
        this.deps.store.addEvent(projectId, 'threshold_stop', {
          roundIndex: runtime.roundIndex, total: outcome.totalCompleteness, threshold: currentThreshold,
          missingItems: outcome.missingItems,
        });
        this.finishRun(runtime);
        this.notifyStatus();
        return 'stop';
      }

      // 4) 未达标：有提示词派发；缺提示词且澄清预算未耗尽 → 发澄清后回环（统一理解）。
      let prompt = outcome.nextPrompt;
      if (prompt === null) {
        if (clarifyCount >= limits.maxClarifyPerRound) {
          return this.pause(runtime, 'clarify_limit', '未达标但 A 未提供提示词，澄清后仍缺失，暂停');
        }
        clarifyCount += 1;
        this.setPhase(runtime, 'clarify');
        this.deps.store.insertMessage({
          projectId, runId: null, roundIndex: runtime.roundIndex, direction: 'to_a',
          kind: 'clarify', content: CLARIFY_PROMPT, messageRef: null,
        });
        const clarifyDispatch = await this.dispatch(
          runtime, gen, evaluator, config.evaluator.sessionId, CLARIFY_PROMPT,
          { roundIndex: runtime.roundIndex, target: 'evaluator', label: `prompt-clarify-${clarifyCount}` },
        );
        if (typeof clarifyDispatch !== 'object') return 'stop';
        if (clarifyDispatch.receipt.status !== 'confirmed') {
          return this.pause(runtime,
            clarifyDispatch.receipt.status === 'unknown' ? 'unknown_send' : 'adapter_failure',
            `补充提示词请求${clarifyDispatch.receipt.status}`);
        }
        this.deps.store.addEvent(projectId, 'prompt_clarify_sent', { roundIndex: runtime.roundIndex });
        continue; // 澄清回复经同一理解路径（R6：不得绕过模型与阈值）。
      }

      // 5) 派发 B（统一意图 + 前台路由 + 超时）。
      this.setPhase(runtime, 'dispatch');
      const dispatch = await this.dispatch(
        runtime, gen, executor, config.executor.sessionId, prompt,
        { roundIndex: runtime.roundIndex, target: 'executor', label: 'task' },
      );
      if (typeof dispatch !== 'object') return 'stop';
      const { receipt, intentId } = dispatch;
      if (receipt.status === 'confirmed') {
        runtime.lastDispatch = { roundIndex: runtime.roundIndex, target: 'executor', promptExcerpt: prompt.slice(0, 200), state: 'confirmed', at: new Date().toISOString() };
      } else if (receipt.status === 'unknown') {
        runtime.lastDispatch = { roundIndex: runtime.roundIndex, target: 'executor', promptExcerpt: prompt.slice(0, 200), state: 'unknown', at: new Date().toISOString() };
        return this.pause(runtime, 'unknown_send', `执行派发回执未知（意图 #${intentId}），暂停且不重发`);
      } else {
        runtime.lastDispatch = { roundIndex: runtime.roundIndex, target: 'executor', promptExcerpt: prompt.slice(0, 200), state: 'aborted', at: new Date().toISOString() };
        return this.pause(runtime, 'adapter_failure', `执行派发失败：${receipt.detail}`);
      }
      this.deps.store.insertMessage({
        projectId, runId: null, roundIndex: runtime.roundIndex, direction: 'to_b',
        kind: 'prompt_dispatch', content: prompt, messageRef: receipt.messageRef,
      });
      this.deps.store.addEvent(projectId, 'prompt_dispatched', { roundIndex: runtime.roundIndex, intentId });

      // 6) 等待执行结果（B 确认发送 ≠ 任务完成；超时/暂停进入相应路径）。
      this.setPhase(runtime, 'await_execution');
      const result = await this.awaitReply(
        runtime, gen, executor, config.executor.sessionId, runtime.lastBSessionRef,
        deadline - Date.now(), pollMs,
      );
      if (result === 'aborted' || result === 'paused') return 'stop';
      if (result === 'timeout') {
        return this.pause(runtime, 'round_timeout', '等待执行结果超时（B 已确认收到任务，结果可能仍在生成）');
      }
      if (result.complete !== true) {
        return this.pause(runtime, 'adapter_failure', '执行结果读取不完整');
      }
      const dupResult = result.messageRef !== null
        && this.deps.store.findMessageByRef(projectId, 'from_b', result.messageRef);
      if (dupResult) {
        return this.pause(runtime, 'duplicate_reply', '收到重复执行结果引用，暂停核对');
      }
      this.setPhase(runtime, 'collect_result');
      this.deps.store.insertMessage({
        projectId, runId: null, roundIndex: runtime.roundIndex, direction: 'from_b',
        kind: 'execution_result', content: result.text, messageRef: result.messageRef,
      });
      runtime.lastBSessionRef = result.messageRef;
      runtime.lastResultFull = result.text;
      this.deps.store.addEvent(projectId, 'execution_result_received', { roundIndex: runtime.roundIndex });
      this.setPhase(runtime, 'request_evaluation');
      return 'continue';
    }
  }

  /**
   * 统一发送路径（R4/R5/R7）：意图先落库 → 前台路由（能力驱动 + 模式授权）→
   * 发送前取消核对 → 超时包装发送（超时=unknown）→ 按真实回执落库。
   * 返回 {receipt,intentId}；'aborted'（调用前取消）；'paused'（前台未授权等）。
   */
  private async dispatch(
    runtime: ProjectRuntime, gen: number, adapter: ProductAdapter, sessionId: string,
    text: string, meta: { roundIndex: number; target: 'evaluator' | 'executor'; label: string },
  ): Promise<{ receipt: { status: 'confirmed' | 'unknown' | 'failed'; detail: string; messageRef: string | null }; intentId: number } | 'aborted' | 'paused'> {
    if (!this.ensureActive(runtime, gen)) return 'aborted';
    const needsForeground = adapter.capabilities().sendPrompt === 'foreground';
    if (needsForeground && !this.foregroundModeEnabled) {
      this.pause(runtime, 'foreground_required',
        `操作「send:${meta.label}」需要前台控制，但专用前台模式未开启；请在界面上显式开启后再恢复运行`);
      return 'paused';
    }

    let receipt: { status: 'confirmed' | 'unknown' | 'failed'; detail: string; messageRef: string | null };
    let intentId: number;
    if (needsForeground) {
      // 发送意图先落库，再把绑定核对、输入、发送和回显确认作为一个前台单元执行。
      // 队列超时或外部操作异常一律保守地按未知处理，禁止盲目重发。
      intentId = this.deps.store.createIntent({
        projectId: runtime.config.projectId,
        roundIndex: meta.roundIndex,
        prompt: text,
        target: meta.target,
      });
      runtime.inFlightIntent = intentId;
      const operation = await this.runForegroundUnit(runtime, gen, `send:${meta.label}`, async () => {
        const binding = await adapter.verifyBinding(sessionId);
        if (!binding.ok) {
          throw new AdapterError('ADAPTER_BINDING_LOST', binding.detail);
        }
        if (!this.ensureActive(runtime, gen)) {
          throw new AdapterError('ADAPTER_INVALID_STATE', '停止/暂停发生在前台发送开始前');
        }
        return this.sendWithTimeout(
          adapter, sessionId, text,
          {
            intentId: `intent-${intentId}`, roundIndex: meta.roundIndex,
            timeoutMs: runtime.config.limits.adapterTimeoutMs, ownerId: runtime.config.projectId,
          },
        );
      });
      runtime.inFlightIntent = null;
      if (operation.status !== 'ok') {
        if (operation.status === 'blocked' || !this.ensureActive(runtime, gen)) {
          this.deps.store.resolveIntent(intentId, 'aborted', '停止/暂停发生在前台发送开始前，未发出');
          return 'aborted';
        }
        const detail = operation.error instanceof Error ? operation.error.message : String(operation.error);
        const bindingLost = operation.error instanceof AdapterError && operation.error.code === 'ADAPTER_BINDING_LOST';
        this.deps.store.resolveIntent(intentId, 'unknown', `前台发送结果未知：${detail}`);
        this.pause(runtime, bindingLost ? 'binding_lost' : 'adapter_failure',
          `前台发送未能确认（${meta.label}）：${detail}`);
        return 'paused';
      }
      receipt = operation.value;
    } else {
      // 后台 Adapter 的绑定核对不占用前台队列，但发送前仍需重新检查取消代数。
      let binding: { ok: boolean; detail: string };
      try {
        binding = await adapter.verifyBinding(sessionId);
      } catch (error) {
        this.pause(runtime, 'adapter_failure',
          `绑定核对失败（${meta.label}）：${error instanceof Error ? error.message : String(error)}`);
        return 'paused';
      }
      if (!this.ensureActive(runtime, gen)) return 'aborted';
      if (!binding.ok) {
        this.pause(runtime, 'binding_lost', `会话绑定失效（${meta.label}）：${binding.detail}`);
        return 'paused';
      }
      intentId = this.deps.store.createIntent({
        projectId: runtime.config.projectId,
        roundIndex: meta.roundIndex,
        prompt: text,
        target: meta.target,
      });
      if (!this.ensureActive(runtime, gen)) {
        this.deps.store.resolveIntent(intentId, 'aborted', '停止/暂停发生在发送开始前，未发出');
        return 'aborted';
      }
      runtime.inFlightIntent = intentId;
      try {
        receipt = await this.sendWithTimeout(
          adapter, sessionId, text,
          {
            intentId: `intent-${intentId}`, roundIndex: meta.roundIndex,
            timeoutMs: runtime.config.limits.adapterTimeoutMs, ownerId: runtime.config.projectId,
          },
        );
      } finally {
        runtime.inFlightIntent = null;
      }
    }
    // 飞行结束：无论期间是否发生停止/暂停，都按真实回执落库（不猜测未发出）。
    this.deps.store.resolveIntent(
      intentId,
      receipt.status === 'confirmed' ? 'confirmed' : receipt.status === 'unknown' ? 'unknown' : 'aborted',
      receipt.detail,
    );
    return { receipt, intentId };
  }

  /** 前台操作必须以完整单元持有队列：切换/核对/读写/确认均在 run 内完成。 */
  private async runForegroundUnit<T>(
    runtime: ProjectRuntime, gen: number, label: string, run: () => Promise<T>,
  ): Promise<{ status: 'ok'; value: T } | { status: 'blocked' } | { status: 'error'; error: unknown }> {
    if (this.globalStop || !this.ensureActive(runtime, gen)) return { status: 'blocked' };
    try {
      const value = await this.deps.foregroundQueue.submit({
        owner: runtime.config.projectId,
        label,
        // 覆盖绑定核对、控件动作和发送回执；超时后队列仍等待底层 Promise 收敛，
        // 期间不会让第二个项目抢占同一前台。
        timeoutMs: Math.max(runtime.config.limits.adapterTimeoutMs * 2, 2_000),
        run: async () => {
          if (!this.ensureActive(runtime, gen)) {
            throw new AdapterError('ADAPTER_INVALID_STATE', 'cancelled while waiting for foreground queue');
          }
          return run();
        },
      });
      return { status: 'ok', value };
    } catch (error) {
      return { status: 'error', error };
    }
  }

  private async sendWithTimeout(
    adapter: ProductAdapter, sessionId: string, text: string,
    meta: { intentId: string; roundIndex: number; timeoutMs: number; ownerId: string },
  ): Promise<{ status: 'confirmed' | 'unknown' | 'failed'; detail: string; messageRef: string | null }> {
    // 超时=回执未知（请求可能已到达外部会话）；明确异常=failed；不猜测"未发出"。
    const timeout = new Promise<{ status: 'unknown'; detail: string; messageRef: string | null }>((resolve) => {
      setTimeout(() => resolve({
        status: 'unknown',
        detail: `发送在 ${meta.timeoutMs}ms 内未返回回执，结果未知`,
        messageRef: null,
      }), meta.timeoutMs);
    });
    try {
      return await Promise.race([
        adapter.sendPrompt(sessionId, text, {
          intentId: meta.intentId, roundIndex: meta.roundIndex, timeoutMs: meta.timeoutMs, ownerId: meta.ownerId,
        }),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof AdapterError) {
        return { status: 'failed', detail: `${error.code}: ${error.message}`, messageRef: null };
      }
      return { status: 'failed', detail: error instanceof Error ? error.message : String(error), messageRef: null };
    }
  }

  /**
   * 等待回复（R4/R9）：poll 循环内核对取消；前台读取同样经能力路由；
   * 核对 reply.sessionId 与期望一致，不一致按绑定丢失暂停（不猜来源）。
   */
  private async awaitReply(
    runtime: ProjectRuntime, gen: number, adapter: ProductAdapter, sessionId: string,
    afterRef: string | null, budgetMs: number, pollMs: number,
  ): Promise<{ text: string; complete: boolean; messageRef: string | null } | 'timeout' | 'aborted' | 'paused'> {
    const deadline = Date.now() + Math.max(budgetMs, 0);
    const ownerId = runtime.config.projectId;
    for (;;) {
      if (!this.ensureActive(runtime, gen)) return 'aborted';
      let reply;
      try {
        if (adapter.capabilities().readReply === 'foreground') {
          if (!this.foregroundModeEnabled) {
            return this.pause(runtime, 'foreground_required',
              `操作「read:${sessionId}」需要前台控制，但专用前台模式未开启；请在界面上显式开启后再恢复运行`) as 'paused';
          }
          const operation = await this.runForegroundUnit(runtime, gen, `read:${sessionId}`, async () => {
            const binding = await adapter.verifyBinding(sessionId);
            if (!binding.ok) throw new AdapterError('ADAPTER_BINDING_LOST', binding.detail);
            if (!this.ensureActive(runtime, gen)) {
              throw new AdapterError('ADAPTER_INVALID_STATE', '停止/暂停发生在前台读取开始前');
            }
            return adapter.readReply(sessionId, afterRef, Math.min(pollMs * 2, 2_000), ownerId);
          });
          if (operation.status === 'blocked') return 'aborted';
          if (operation.status === 'error') throw operation.error;
          reply = operation.value;
        } else {
          reply = await adapter.readReply(sessionId, afterRef, Math.min(pollMs * 2, 2_000), ownerId);
        }
      } catch (error) {
        if (error instanceof AdapterError) {
          const reason = error.code === 'ADAPTER_BINDING_LOST' ? 'binding_lost' : 'adapter_failure';
          return this.pause(runtime, reason, `读取失败（${error.code}）：${error.message}`) as 'paused';
        }
        return this.pause(runtime, 'adapter_failure', error instanceof Error ? error.message : String(error)) as 'paused';
      }
      if (reply && reply.sessionId !== sessionId) {
        return this.pause(runtime, 'binding_lost', `回复来源会话 ${reply.sessionId} 与绑定 ${sessionId} 不一致`) as 'paused';
      }
      if (reply && reply.messageRef !== afterRef) {
        return { text: reply.text, complete: reply.complete, messageRef: reply.messageRef };
      }
      if (Date.now() >= deadline) return 'timeout';
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** 停止/达标：仅在无未决外部任务时释放工作区保护（R4/R5）。 */
  private finishRun(runtime: ProjectRuntime): void {
    this.releaseHeldSessions(runtime);
    const external = this.deps.store.hasUnresolvedExternalTask(runtime.config.projectId);
    if (!external.unresolved && runtime.holdsWorkspace) {
      this.deps.workspaces.release(runtime.workspaceKey, runtime.config.projectId);
      runtime.holdsWorkspace = false;
    }
    runtime.stoppedAt = new Date().toISOString();
  }

  private releaseHeldSessions(runtime: ProjectRuntime): void {
    for (const held of runtime.heldSessions) {
      this.deps.sessions.release(held.productId, held.sessionId, runtime.config.projectId);
    }
    runtime.heldSessions = [];
  }

  private pause(runtime: ProjectRuntime, reason: PauseReason, detail: string): 'stop' {
    if (runtime.state === 'running') {
      assertTransition(runtime.state, 'paused');
      runtime.state = 'paused';
    }
    runtime.pauseReason = reason;
    runtime.phase = null;
    runtime.statusDetail = detail;
    this.releaseHeldSessions(runtime);
    this.deps.emitLog?.(reason === 'user' ? 'info' : 'warn', `项目 ${runtime.config.projectId} 暂停：${detail}`);
    this.deps.store.addEvent(runtime.config.projectId, 'project_paused', { reason, detail });
    this.notifyStatus();
    return 'stop';
  }

  private setPhase(runtime: ProjectRuntime, phase: CyclePhase): void {
    runtime.phase = phase;
    this.notifyStatus();
  }

  private requireAdapter(productId: string): ProductAdapter {
    const adapter = this.deps.adapters.get(productId);
    if (!adapter) throw new Error(`产品适配器未注册：${productId}`);
    return adapter;
  }

  private notifyStatus(): void {
    this.deps.onStatus?.();
  }

  private toView(runtime: ProjectRuntime): ProjectView {
    const { config } = runtime;
    return {
      projectId: config.projectId,
      name: config.name,
      workspacePath: config.workspacePath,
      goalExcerpt: config.goal.slice(0, 200),
      prdRef: config.prdRef,
      evaluator: config.evaluator,
      executor: config.executor,
      stopThresholdPercent: config.stopThresholdPercent,
      state: runtime.state,
      phase: runtime.phase,
      pauseReason: runtime.pauseReason,
      roundIndex: runtime.roundIndex,
      startedAt: runtime.startedAtMs !== null ? new Date(runtime.startedAtMs).toISOString() : null,
      stoppedAt: runtime.stoppedAt,
      lastEvaluation: runtime.lastEvaluation,
      lastDispatch: runtime.lastDispatch,
      statusDetail: runtime.statusDetail,
    };
  }
}

/** R9：父子目录重叠检测（win32 大小写不敏感，分隔符归一）。 */
function overlapsPath(pathA: string, pathB: string): boolean {
  const norm = (input: string) => {
    const unified = input.split(/[\\/]+/).filter((segment) => segment.length > 0).join('/');
    return process.platform === 'win32' ? unified.toLowerCase() : unified;
  };
  const a = norm(pathA);
  const b = norm(pathB);
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function rowToConfig(row: {
  project_id: string; name: string; workspace_path: string; goal: string; prd_ref: string;
  evaluator_json: string; executor_json: string; stop_threshold_percent: number; limits_json: string;
}): ProjectConfig {
  return validateProjectConfig({
    projectId: row.project_id,
    name: row.name,
    workspacePath: row.workspace_path,
    goal: row.goal,
    prdRef: row.prd_ref,
    evaluator: JSON.parse(row.evaluator_json),
    executor: JSON.parse(row.executor_json),
    stopThresholdPercent: row.stop_threshold_percent,
    limits: { ...DEFAULT_LIMITS, ...JSON.parse(row.limits_json) },
  });
}
