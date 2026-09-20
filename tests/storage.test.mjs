// W3 存储层测试：迁移、参数化写入、意图生命周期、去重查询、阈值变更记录。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../dist/storage/database.js';
import { RecordStore } from '../dist/storage/records.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'lfrr-store-'));
}

function validConfig(id = 'store-1') {
  return {
    projectId: id,
    name: '存储测试',
    workspacePath: 'C:\\tmp\\store-demo',
    goal: '目标',
    prdRef: 'prd@1',
    evaluator: { productId: 'simulated', sessionId: 'a1', label: null },
    executor: { productId: 'simulated', sessionId: 'b1', label: null },
    stopThresholdPercent: 75,
    limits: {
      maxClarifyPerRound: 2, roundTimeoutMs: 60_000, modelTimeoutMs: 30_000,
      adapterTimeoutMs: 30_000, maxStalledRounds: null,
    },
  };
}


function tryBestEffortRemove(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // Windows 句柄释放延迟导致的 EPERM：尽力清理即可，不影响断言。
  }
}

test('database creates schema, reopens at same version without remigration', () => {
  const dir = tempDir();
  try {
    const db = openDatabase(dir);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
    for (const expected of ['projects', 'messages', 'evaluations', 'dispatch_intents', 'threshold_changes', 'events', 'schema_meta']) {
      assert.ok(tables.includes(expected), `missing table ${expected}`);
    }
    db.close();
    const reopened = openDatabase(dir);
    assert.equal((reopened.prepare('SELECT version FROM schema_meta').get()).version, 1);
    reopened.close();
    assert.ok(existsSync(join(dir, 'lfrr.sqlite')));
  } finally {
    tryBestEffortRemove(dir);
  }
});

test('project insert and workspace conflict query use parameterized statements', () => {
  const dir = tempDir();
  try {
    const db = openDatabase(dir);
    const store = new RecordStore(db);
    store.insertProject(validConfig('one'), 'ws:/tmp/demo');
    store.insertProject(validConfig('two'), 'ws:/tmp/other');
    const conflict = store.findWorkspaceConflict('ws:/tmp/demo', 'two');
    assert.equal(conflict.project_id, 'one', '其他项目占用时应返回占用者');
    const self = store.findWorkspaceConflict('ws:/tmp/demo', 'one');
    assert.equal(self, undefined, '查询自身不算冲突');
    const none = store.findWorkspaceConflict('ws:/tmp/free', 'one');
    assert.equal(none, undefined);
    db.close();
  } finally {
    tryBestEffortRemove(dir);
  }
});

test('intent lifecycle persists pending -> unknown and survives reopen', () => {
  const dir = tempDir();
  try {
    let intentId;
    {
      const db = openDatabase(dir);
      const store = new RecordStore(db);
      store.insertProject(validConfig(), 'ws:/x');
      intentId = store.createIntent({ projectId: 'store-1', roundIndex: 1, prompt: '请继续完成剩余项' });
      assert.equal(store.getIntent(intentId).state, 'pending');
      store.resolveIntent(intentId, 'unknown', '回执未知');
      db.close();
    }
    {
      const db = openDatabase(dir);
      const store = new RecordStore(db);
      const intent = store.getIntent(intentId);
      assert.equal(intent.state, 'unknown');
      assert.equal(store.unresolvedIntents('store-1').length, 1);
      store.resolveIntent(intentId, 'aborted', '人工放弃');
      assert.equal(store.unresolvedIntents('store-1').length, 0);
      db.close();
    }
  } finally {
    tryBestEffortRemove(dir);
  }
});

test('message dedup by message_ref and threshold change rows', () => {
  const dir = tempDir();
  try {
    const db = openDatabase(dir);
    const store = new RecordStore(db);
    store.insertProject(validConfig(), 'ws:/y');
    const ref = 'sim-a-1';
    store.insertMessage({
      projectId: 'store-1', runId: null, roundIndex: 1, direction: 'from_a',
      kind: 'evaluation_reply', content: '回复', messageRef: ref,
    });
    assert.ok(store.findMessageByRef('store-1', 'from_a', ref));
    assert.equal(store.findMessageByRef('store-1', 'from_b', ref), undefined);
    store.setThreshold('store-1', 90, 'user');
    const changes = store.listThresholdChanges('store-1', 10);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].old_value, 75);
    assert.equal(changes[0].new_value, 90);
    db.close();
  } finally {
    tryBestEffortRemove(dir);
  }
});

test('evaluation row stores missing items json and verbatim prompt', () => {
  const dir = tempDir();
  try {
    const db = openDatabase(dir);
    const store = new RecordStore(db);
    store.insertProject(validConfig(), 'ws:/z');
    store.insertEvaluation({
      projectId: 'store-1', roundIndex: 2, replyMessageId: 1,
      totalCompleteness: 77.5, basis: '依据', missingItems: ['x', 'y'],
      nextPrompt: '原提示词', modelUsed: 'fake',
    });
    const row = store.latestEvaluation('store-1');
    assert.equal(row.total_completeness, 77.5);
    assert.deepEqual(JSON.parse(row.missing_json), ['x', 'y']);
    assert.equal(row.next_prompt, '原提示词');
    db.close();
  } finally {
    tryBestEffortRemove(dir);
  }
});
