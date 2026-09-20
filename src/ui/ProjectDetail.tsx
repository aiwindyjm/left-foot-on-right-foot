import { useEffect, useState } from 'react';
import type { AuditEventItem, ProjectView, RecordItem } from '../shared/views.js';
import type { ProjectRunState } from '../core/states.js';
import {
  PAUSE_LABEL, PHASE_LABEL, RECORD_LABEL, STATE_LABEL,
  completenessClass, formatTime, projectControls,
} from './labels.js';

type Command = (run: () => Promise<{ ok: boolean; code?: string; message?: string }>) => void;

export function ProjectDetail(props: { project: ProjectView; onCommand: Command }) {
  const { project } = props;
  const [tab, setTab] = useState<'records' | 'events'>('records');
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [events, setEvents] = useState<AuditEventItem[]>([]);
  const [thresholdDraft, setThresholdDraft] = useState(String(project.stopThresholdPercent));
  const [recoveryIntents, setRecoveryIntents] = useState<Array<{ intentId: number; state: string }>>([]);

  useEffect(() => {
    setThresholdDraft(String(project.stopThresholdPercent));
  }, [project.projectId, project.stopThresholdPercent]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const nextRecords = await window.lfrr.listRecords(project.projectId, 80);
        const nextEvents = await window.lfrr.listEvents(project.projectId, 80);
        if (!cancelled) {
          setRecords(nextRecords);
          setEvents(nextEvents);
        }
      } catch {
        // 记录加载失败不阻塞主视图；下次状态推送会重试。
      }
    };
    void load();
    const timer = setInterval(load, 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [project.projectId, project.roundIndex, project.state]);

  // 恢复阻断时列出未确认派发意图（读取记录里的 prompt_dispatch 条目）。
  useEffect(() => {
    if (project.pauseReason !== 'recovery_pending') {
      setRecoveryIntents([]);
      return;
    }
    void (async () => {
      const nextRecords = await window.lfrr.listRecords(project.projectId, 100);
      const pending = nextRecords
        .filter((record) => record.kind === 'prompt_dispatch'
          && (record.meta.state === 'unknown' || record.meta.state === 'pending' || record.meta.state === 'sent'))
        .map((record) => ({
          intentId: Number(record.meta.intentId ?? 0),
          state: String(record.meta.state ?? ''),
        }))
        .filter((intent) => intent.intentId > 0);
      setRecoveryIntents(pending);
    })();
  }, [project.pauseReason, project.projectId]);

  const evaluation = project.lastEvaluation;
  const controls = projectControls(project);

  return (
    <section className="detail">
      <header className="detail-header">
        <h2>{project.name}</h2>
        <span className={`badge ${stateClass(project.state)}`}>{STATE_LABEL[project.state]}</span>
        {project.phase && <span className="phase">{PHASE_LABEL[project.phase]}</span>}
      </header>

      {project.statusDetail && (
        <div className={`status-line ${project.pauseReason ? `pause-${project.pauseReason}` : ''}`}>
          {project.pauseReason ? `暂停原因：${PAUSE_LABEL[project.pauseReason]}。` : ''}
          {project.statusDetail}
        </div>
      )}

      <div className="control-row">
        {controls.map((control) => (
          <button
            key={control.action}
            className={`btn ${control.danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => {
              if (control.action === 'start') props.onCommand(() => window.lfrr.startProject(project.projectId));
              if (control.action === 'pause') props.onCommand(() => window.lfrr.pauseProject(project.projectId));
              if (control.action === 'resume') props.onCommand(() => window.lfrr.resumeProject(project.projectId));
              if (control.action === 'stop') {
                if (window.confirm(`确认停止项目「${project.name}」？系统将停止新派发；外部会话是否停止将另行显示。`)) {
                  props.onCommand(() => window.lfrr.stopProject(project.projectId));
                }
              }
            }}
          >
            {control.label}
          </button>
        ))}
        <span className="threshold-editor">
          阈值：
          <input
            value={thresholdDraft}
            onChange={(event) => setThresholdDraft(event.target.value)}
            inputMode="decimal"
            className="threshold-input"
          />
          %
          <button
            className="btn"
            onClick={() => props.onCommand(() => window.lfrr.setThreshold(project.projectId, Number(thresholdDraft)))}
          >
            修改
          </button>
          <span className="hint">修改会记录并按新阈值判断（不自动复活已停止项目）。</span>
        </span>
      </div>

      {recoveryIntents.length > 0 && (
        <div className="recovery-box">
          <p>重启核对：以下派发意图未确认（未知发送不重发）。人工核对后可选择放弃，然后恢复运行。</p>
          <ul>
            {recoveryIntents.map((intent) => (
              <li key={intent.intentId}>
                意图 #{intent.intentId}（{intent.state}）
                <button
                  className="btn btn-small"
                  onClick={() => props.onCommand(() => window.lfrr.abandonIntent(project.projectId, intent.intentId))}
                >
                  放弃
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="meta-grid">
        <div><span className="muted">目标：</span>{project.goalExcerpt}</div>
        <div><span className="muted">PRD 范围：</span>{project.prdRef}</div>
        <div><span className="muted">工作区：</span><code>{project.workspacePath}</code></div>
        <div>
          <span className="muted">评估 A：</span>
          {project.evaluator.productId} / <code>{project.evaluator.sessionId}</code>
          <span className="muted"> 　执行 B：</span>
          {project.executor.productId} / <code>{project.executor.sessionId}</code>
        </div>
      </div>

      {evaluation && (
        <div className="evaluation-card">
          <div className="evaluation-score">
            <span className={`big-score ${completenessClass(evaluation.totalCompleteness, project.stopThresholdPercent)}`}>
              {evaluation.totalCompleteness}%
            </span>
            <span className="muted">
              {evaluation.totalCompleteness >= project.stopThresholdPercent
                ? `≥ 阈值 ${project.stopThresholdPercent}%：达标停止`
                : `< 阈值 ${project.stopThresholdPercent}%：继续`}
            </span>
          </div>
          <div className="evaluation-body">
            <p><span className="muted">评估依据：</span>{evaluation.basis}</p>
            <p><span className="muted">缺项：</span>
              {evaluation.missingItems.length === 0 ? '无' : (
                <ul>{evaluation.missingItems.map((item) => <li key={item}>{item}</li>)}</ul>
              )}
            </p>
            {evaluation.nextPrompt && (
              <>
                <p className="muted">下一轮提示词{evaluation.totalCompleteness >= project.stopThresholdPercent ? '（已达标停止：未发送）' : ''}：</p>
                <pre className="prompt-block">{evaluation.nextPrompt}</pre>
              </>
            )}
            <p className="hint">第 {evaluation.roundIndex} 轮 · 提取时间 {formatTime(evaluation.understoodAt)} · 完整回复见记录</p>
          </div>
        </div>
      )}

      <nav className="tabs">
        <button className={tab === 'records' ? 'tab active' : 'tab'} onClick={() => setTab('records')}>记录</button>
        <button className={tab === 'events' ? 'tab active' : 'tab'} onClick={() => setTab('events')}>事件</button>
      </nav>
      {tab === 'records' && (
        <ul className="timeline">
          {records.length === 0 && <li className="muted">暂无记录。</li>}
          {records.map((record, index) => (
            <li key={`${record.at}-${index}`} className="timeline-item">
              <span className="timeline-kind">{RECORD_LABEL[record.kind] ?? record.kind}</span>
              <span className="muted">第 {record.roundIndex ?? '—'} 轮 · {formatTime(record.at)}</span>
              {record.kind === 'prompt_dispatch' && record.meta && (
                <span className={`badge ${String(record.meta.state) === 'confirmed' ? 'state-ok' : String(record.meta.state) === 'unknown' ? 'state-error' : 'state-idle'}`}>
                  {String(record.meta.state ?? '')}
                </span>
              )}
              <pre className="excerpt">{record.excerpt}</pre>
            </li>
          ))}
        </ul>
      )}
      {tab === 'events' && (
        <ul className="timeline">
          {events.length === 0 && <li className="muted">暂无事件。</li>}
          {events.map((event, index) => (
            <li key={`${event.at}-${index}`} className="timeline-item">
              <span className="timeline-kind">{event.type}</span>
              <span className="muted">{formatTime(event.at)}</span>
              <pre className="excerpt">{JSON.stringify(event.data)}</pre>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function stateClass(state: ProjectRunState): string {
  switch (state) {
    case 'running': return 'state-running';
    case 'paused': return 'state-paused';
    case 'stopped_threshold': return 'state-ok';
    case 'error': return 'state-error';
    default: return 'state-idle';
  }
}
