// 记录操作层：所有写入经参数化语句；派发意图先落库（pending），回执后更新状态。
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  EvaluationRow, EventRow, IntentRow, MessageRow, ProjectRow,
} from './database.js';
import type { ProjectConfig, SessionBinding, RunLimits } from '../shared/project-config.js';

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface IntentWrite {
  projectId: string;
  roundIndex: number;
  prompt: string;
}

export class RecordStore {
  constructor(private readonly db: Database.Database) {}

  // ---- 项目 ----

  insertProject(config: ProjectConfig, workspaceKey: string): void {
    this.db
      .prepare(
        `INSERT INTO projects (project_id, name, workspace_path, workspace_key, goal, prd_ref,
           evaluator_json, executor_json, stop_threshold_percent, limits_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        config.projectId,
        config.name,
        config.workspacePath,
        workspaceKey,
        config.goal,
        config.prdRef,
        JSON.stringify(config.evaluator),
        JSON.stringify(config.executor),
        config.stopThresholdPercent,
        JSON.stringify(config.limits),
        nowIso(),
      );
  }

  getProject(projectId: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as ProjectRow | undefined;
  }

  listProjects(): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at, project_id').all() as ProjectRow[];
  }

  /** 返回占用该工作区键的其他项目（工作区互斥，FR-21）。 */
  findWorkspaceConflict(workspaceKey: string, excludeProjectId: string): ProjectRow | undefined {
    return this.db
      .prepare('SELECT * FROM projects WHERE workspace_key = ? AND project_id != ?')
      .get(workspaceKey, excludeProjectId) as ProjectRow | undefined;
  }

  updateProjectText(projectId: string, patch: { name?: string; goal?: string; prdRef?: string }): void {
    const current = this.getProject(projectId);
    if (!current) throw new Error(`project not found: ${projectId}`);
    this.db
      .prepare('UPDATE projects SET name = ?, goal = ?, prd_ref = ? WHERE project_id = ?')
      .run(patch.name ?? current.name, patch.goal ?? current.goal, patch.prdRef ?? current.prd_ref, projectId);
  }

  setThreshold(projectId: string, threshold: number, reason: string): { oldValue: number } {
    const current = this.getProject(projectId);
    if (!current) throw new Error(`project not found: ${projectId}`);
    const apply = this.db.transaction(() => {
      this.db
        .prepare('UPDATE projects SET stop_threshold_percent = ? WHERE project_id = ?')
        .run(threshold, projectId);
      this.db
        .prepare('INSERT INTO threshold_changes (project_id, old_value, new_value, reason, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(projectId, current.stop_threshold_percent, threshold, reason, nowIso());
    });
    apply();
    return { oldValue: current.stop_threshold_percent };
  }

  // ---- 消息 ----

  insertMessage(input: {
    projectId: string;
    runId: number | null;
    roundIndex: number | null;
    direction: MessageRow['direction'];
    kind: string;
    content: string;
    messageRef: string | null;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO messages (project_id, run_id, round_index, direction, kind, content, message_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.runId,
        input.roundIndex,
        input.direction,
        input.kind,
        input.content,
        input.messageRef,
        nowIso(),
      );
    return Number(result.lastInsertRowid);
  }

  /** 相同 message_ref 的重复回复去重检测（PRD FR-10）。 */
  findMessageByRef(projectId: string, direction: MessageRow['direction'], messageRef: string): MessageRow | undefined {
    return this.db
      .prepare('SELECT * FROM messages WHERE project_id = ? AND direction = ? AND message_ref = ? ORDER BY message_id LIMIT 1')
      .get(projectId, direction, messageRef) as MessageRow | undefined;
  }

  listMessages(projectId: string, limit: number): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE project_id = ? ORDER BY message_id DESC LIMIT ?')
      .all(projectId, limit) as MessageRow[];
  }

  // ---- 评估 ----

  insertEvaluation(input: {
    projectId: string;
    roundIndex: number;
    replyMessageId: number;
    totalCompleteness: number;
    basis: string;
    missingItems: string[];
    nextPrompt: string | null;
    modelUsed: string;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO evaluations (project_id, round_index, reply_message_id, total_completeness, basis,
           missing_json, next_prompt, model_used, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.roundIndex,
        input.replyMessageId,
        input.totalCompleteness,
        input.basis,
        JSON.stringify(input.missingItems),
        input.nextPrompt,
        input.modelUsed,
        nowIso(),
      );
    return Number(result.lastInsertRowid);
  }

  latestEvaluation(projectId: string): EvaluationRow | undefined {
    return this.db
      .prepare('SELECT * FROM evaluations WHERE project_id = ? ORDER BY evaluation_id DESC LIMIT 1')
      .get(projectId) as EvaluationRow | undefined;
  }

  // ---- 派发意图（先落库后发送；unknown 状态重启后保持阻断）----

  createIntent(input: IntentWrite & { target?: 'evaluator' | 'executor' }): number {
    const result = this.db
      .prepare(
        `INSERT INTO dispatch_intents (project_id, round_index, target, payload_hash, payload_excerpt, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(input.projectId, input.roundIndex, input.target ?? 'executor', sha256(input.prompt), input.prompt.slice(0, 500), nowIso());
    return Number(result.lastInsertRowid);
  }

  getIntent(intentId: number): IntentRow | undefined {
    return this.db.prepare('SELECT * FROM dispatch_intents WHERE intent_id = ?').get(intentId) as IntentRow | undefined;
  }

  /** 回执落库：sent=已发出未确认；confirmed=产品确认；unknown=无法确认（保持阻断）；aborted=未发出即中止。 */
  resolveIntent(intentId: number, state: IntentRow['state'], detail: string): void {
    this.db
      .prepare('UPDATE dispatch_intents SET state = ?, receipt_detail = ?, resolved_at = ? WHERE intent_id = ?')
      .run(state, detail, nowIso(), intentId);
  }

  listIntents(projectId: string, limit: number): IntentRow[] {
    return this.db
      .prepare('SELECT * FROM dispatch_intents WHERE project_id = ? ORDER BY intent_id DESC LIMIT ?')
      .all(projectId, limit) as IntentRow[];
  }

  listThresholdChanges(projectId: string, limit: number): Array<{ change_id: number; old_value: number; new_value: number; reason: string; created_at: string }> {
    return this.db
      .prepare('SELECT * FROM threshold_changes WHERE project_id = ? ORDER BY change_id DESC LIMIT ?')
      .all(projectId, limit) as Array<{ change_id: number; old_value: number; new_value: number; reason: string; created_at: string }>;
  }

  /** 未决/未知意图（重启核对用，PRD FR-11/12）。 */
  unresolvedIntents(projectId?: string): IntentRow[] {
    if (projectId) {
      return this.db
        .prepare("SELECT * FROM dispatch_intents WHERE project_id = ? AND state IN ('pending','sent','unknown')")
        .all(projectId) as IntentRow[];
    }
    return this.db
      .prepare("SELECT * FROM dispatch_intents WHERE state IN ('pending','sent','unknown')")
      .all() as IntentRow[];
  }

  /**
   * 在途外部任务判定（R5）：最后一条非 aborted 意图为 confirmed 且同轮尚无
   * 之后到达的执行结果时，任务可能仍在外部执行，需要人工核对。
   * A 侧 confirmed 意图（评估请求/澄清）同理：尚无对应轮次的评估回复即视为在途。
   */
  hasUnresolvedExternalTask(projectId: string): { unresolved: boolean; intentId: number | null; detail: string; evaluatorInFlight: boolean } {
    const rows = this.db
      .prepare(
        "SELECT * FROM dispatch_intents WHERE project_id = ? AND state IN ('pending','sent','unknown','confirmed') ORDER BY intent_id DESC LIMIT 1",
      )
      .all(projectId) as IntentRow[];
    const last = rows[0];
    if (!last) return { unresolved: false, intentId: null, detail: '', evaluatorInFlight: false };
    if (last.state !== 'confirmed') {
      return {
        unresolved: true,
        intentId: last.intent_id,
        detail: `存在未确认派发（意图 #${last.intent_id}，状态 ${last.state}），不能自动重发`,
        evaluatorInFlight: false,
      };
    }
    if (last.target === 'executor') {
      const result = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM messages WHERE project_id = ? AND direction = 'from_b' AND round_index = ? AND message_id > (SELECT COALESCE(MAX(message_id),0) FROM messages WHERE project_id = ? AND direction = 'to_b' AND round_index = ?)",
        )
        .get(projectId, last.round_index, projectId, last.round_index) as { n: number };
      if (result.n === 0) {
        return {
          unresolved: true,
          intentId: last.intent_id,
          detail: `执行意图 #${last.intent_id}（第 ${last.round_index} 轮）已确认发送但未回收到结果，外部任务可能仍在运行`,
          evaluatorInFlight: false,
        };
      }
      return { unresolved: false, intentId: null, detail: '', evaluatorInFlight: false };
    }
    // evaluator：确认发送后尚无本会话更新的评估回复即视为在途。
    const reply = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE project_id = ? AND direction = 'from_a' AND round_index = ? AND created_at > ?",
      )
      .get(projectId, last.round_index, last.created_at) as { n: number };
    if (reply.n === 0) {
      return {
        unresolved: true,
        intentId: last.intent_id,
        detail: `评估请求 #${last.intent_id}（第 ${last.round_index} 轮）已确认发送但尚未收到回复`,
        evaluatorInFlight: true,
      };
    }
    return { unresolved: false, intentId: null, detail: '', evaluatorInFlight: false };
  }

  /** 最近已完成的轮次（重启后恢复 roundIndex 用）。 */
  lastRoundIndex(projectId: string): number {
    const row = this.db
      .prepare('SELECT MAX(round_index) AS m FROM evaluations WHERE project_id = ?')
      .get(projectId) as { m: number | null };
    const fromMessages = this.db
      .prepare('SELECT MAX(round_index) AS m FROM messages WHERE project_id = ?')
      .get(projectId) as { m: number | null };
    return Math.max(row.m ?? 0, fromMessages.m ?? 0);
  }

  /** 最近一条执行结果全文（重启后恢复 B 结果上下文用，不截断）。 */
  lastExecutionResult(projectId: string): { content: string; messageRef: string | null } | null {
    const row = this.db
      .prepare(
        "SELECT content, message_ref FROM messages WHERE project_id = ? AND direction = 'from_b' AND kind = 'execution_result' ORDER BY message_id DESC LIMIT 1",
      )
      .get(projectId) as { content: string; message_ref: string | null } | undefined;
    return row ? { content: row.content, messageRef: row.message_ref } : null;
  }

  // ---- 事件 ----

  addEvent(projectId: string | null, type: string, data: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO events (project_id, type, data_json, created_at) VALUES (?, ?, ?, ?)')
      .run(projectId, type, JSON.stringify(data), nowIso());
  }

  listEvents(projectId: string | null, limit: number): EventRow[] {
    if (projectId) {
      return this.db
        .prepare('SELECT * FROM events WHERE project_id = ? ORDER BY event_id DESC LIMIT ?')
        .all(projectId, limit) as EventRow[];
    }
    return this.db.prepare('SELECT * FROM events ORDER BY event_id DESC LIMIT ?').all(limit) as EventRow[];
  }

  // ---- 反序列化辅助 ----

  static parseBinding(row: ProjectRow, column: 'evaluator_json' | 'executor_json'): SessionBinding {
    return JSON.parse(row[column]) as SessionBinding;
  }

  static parseLimits(row: ProjectRow): RunLimits {
    return JSON.parse(row.limits_json) as RunLimits;
  }
}
