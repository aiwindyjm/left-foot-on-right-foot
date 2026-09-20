// SQLite 存储层（W3）：单写入者、参数化 SQL、WAL、外键、迁移版本。
// 所有表操作参数绑定，无字符串拼接 SQL（ Mimosa 约束 + tech-stack §6）。
// 意图先落库、回执后更新；存储失败时调用方必须停止新派发（PRD FR-11）。
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA_VERSION = 1;

export interface ProjectRow {
  project_id: string;
  name: string;
  workspace_path: string;
  workspace_key: string;
  goal: string;
  prd_ref: string;
  evaluator_json: string;
  executor_json: string;
  stop_threshold_percent: number;
  limits_json: string;
  created_at: string;
}

export interface MessageRow {
  message_id: number;
  project_id: string;
  run_id: number | null;
  round_index: number | null;
  direction: 'to_a' | 'from_a' | 'to_b' | 'from_b' | 'system';
  kind: string;
  content: string;
  message_ref: string | null;
  created_at: string;
}

export interface EvaluationRow {
  evaluation_id: number;
  project_id: string;
  round_index: number;
  reply_message_id: number;
  total_completeness: number;
  basis: string;
  missing_json: string;
  next_prompt: string | null;
  model_used: string;
  created_at: string;
}

export interface IntentRow {
  intent_id: number;
  project_id: string;
  round_index: number;
  target: 'evaluator' | 'executor';
  payload_hash: string;
  payload_excerpt: string;
  state: 'pending' | 'sent' | 'confirmed' | 'unknown' | 'aborted';
  receipt_detail: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface EventRow {
  event_id: number;
  project_id: string | null;
  type: string;
  data_json: string;
  created_at: string;
}

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: `
  CREATE TABLE projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    workspace_key TEXT NOT NULL,
    goal TEXT NOT NULL,
    prd_ref TEXT NOT NULL,
    evaluator_json TEXT NOT NULL,
    executor_json TEXT NOT NULL,
    stop_threshold_percent REAL NOT NULL,
    limits_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_projects_workspace ON projects(workspace_key);
  CREATE TABLE messages (
    message_id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    run_id INTEGER,
    round_index INTEGER,
    direction TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    message_ref TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_messages_project ON messages(project_id, message_id);
  CREATE TABLE evaluations (
    evaluation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    round_index INTEGER NOT NULL,
    reply_message_id INTEGER NOT NULL,
    total_completeness REAL NOT NULL,
    basis TEXT NOT NULL,
    missing_json TEXT NOT NULL,
    next_prompt TEXT,
    model_used TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_evaluations_project ON evaluations(project_id, evaluation_id);
  CREATE TABLE dispatch_intents (
    intent_id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    round_index INTEGER NOT NULL,
    target TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    payload_excerpt TEXT NOT NULL,
    state TEXT NOT NULL,
    receipt_detail TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX idx_intents_project ON dispatch_intents(project_id, intent_id);
  CREATE INDEX idx_intents_state ON dispatch_intents(state);
  CREATE TABLE threshold_changes (
    change_id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    old_value REAL NOT NULL,
    new_value REAL NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    type TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_events_project ON events(project_id, event_id);
  ` },
];

/** 打开（或创建）数据库并迁移到目标版本。目录不存在时创建。 */
export function openDatabase(dbDir: string): Database.Database {
  mkdirSync(dbDir, { recursive: true });
  const db = new Database(join(dbDir, 'lfrr.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_meta').get() as { version: number } | undefined;
  const current = row?.version ?? 0;
  if (current > SCHEMA_VERSION) {
    db.close();
    throw new Error(`database schema version ${current} is newer than supported ${SCHEMA_VERSION}`);
  }
  if (current < SCHEMA_VERSION) {
    const apply = db.transaction(() => {
      for (const migration of MIGRATIONS) {
        if (migration.version > current && migration.version <= SCHEMA_VERSION) {
          db.exec(migration.sql);
        }
      }
      if (current === 0) {
        db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(SCHEMA_VERSION);
      } else {
        db.prepare('UPDATE schema_meta SET version = ?').run(SCHEMA_VERSION);
      }
    });
    apply();
  }
  return db;
}

export interface Store {
  db: Database.Database;
  close(): void;
}

export function createStore(dbDir: string): Store {
  const db = openDatabase(dbDir);
  return {
    db,
    close() {
      db.close();
    },
  };
}
