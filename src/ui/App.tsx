import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppStatusView, ModelStatusView, ProjectView } from '../shared/views.js';
import type { AdapterCapabilities, ProductSessionInfo } from '../adapters/types.js';
import { STATE_CLASS, STATE_LABEL, PAUSE_LABEL, PHASE_LABEL } from './labels.js';
import { NewProjectForm } from './NewProjectForm.js';
import { ProjectDetail } from './ProjectDetail.js';

export function App() {
  const [status, setStatus] = useState<AppStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [model, setModel] = useState<ModelStatusView | null>(null);

  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.lfrr.onState((next) => {
      if (!disposed) setStatus(next);
    });
    window.lfrr.getState()
      .then((initial) => {
        if (!disposed) setStatus(initial);
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      });
    window.lfrr.checkModel()
      .then((view) => {
        if (!disposed) setModel(view);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const act = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
      setStatus(await window.lfrr.getState());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const command = useCallback((run: () => Promise<{ ok: boolean; code?: string; message?: string }>) => {
    void act(async () => {
      const result = await run();
      if (!result.ok) {
        throw new Error(`${result.code}: ${result.message ?? '操作失败'}`);
      }
    });
  }, [act]);

  const selected = useMemo(
    () => status?.projects.find((project) => project.projectId === selectedId) ?? null,
    [status, selectedId],
  );

  if (error !== null && status === null) {
    return (
      <div className="app-error">
        <h1>左脚踩右脚</h1>
        <p>协调服务未就绪：{error}</p>
        <button onClick={() => { setError(null); window.location.reload(); }}>重试</button>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>左脚踩右脚</strong>
          <span className="brand-en">Left Foot on Right Foot</span>
          <span className="badge badge-mode">{status?.mode === 'simulated' ? '模拟模式' : '生产模式'}</span>
        </div>
        <div className="topbar-status">
          <span
            className={`model-dot ${model?.reachable ? 'dot-ok' : 'dot-bad'}`}
            title={model?.lastError ?? ''}
          />
          <span className="muted">
            模型 {model ? `${model.model} @ ${model.endpoint}` : '检查中…'}
          </span>
          <span className="muted">
            前台队列：{status ? (status.foreground.activeOwner ?? '空闲') : '—'}（排队 {status?.foreground.queued ?? 0}）
          </span>
          <label className="fg-toggle" title="开启后允许前台切换/输入/发送（专用自动操作模式）">
            <input
              type="checkbox"
              checked={status?.foregroundModeEnabled ?? false}
              onChange={(event) => command(() => window.lfrr.setForegroundMode(event.target.checked))}
            />
            前台模式
          </label>
          <button
            className="btn btn-danger"
            onClick={() => {
              if (window.confirm('确认全局停止？将停止所有项目的新派发与排队输入。')) {
                command(() => window.lfrr.stopAll());
              }
            }}
          >
            全局停止
          </button>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>＋ 新建项目</button>
        </div>
      </header>

      {error !== null && (
        <div className="error-banner" onClick={() => setError(null)} title="点击关闭">
          {error}
        </div>
      )}
      {status?.globalStop && (
        <div className="stop-banner">
          全局停止已生效：所有项目新派发与前台输入已关闭。
          <button className="btn btn-small" onClick={() => command(() => window.lfrr.resumeAll())}>
            解除全局停止
          </button>
          （解除不会自动复活任何项目，需逐个显式启动）
        </div>
      )}

      <div className="layout">
        <aside className="sidebar">
          {status === null && <p className="muted">加载中…</p>}
          {status !== null && status.projects.length === 0 && (
            <div className="empty-guide">
              <p>还没有项目。</p>
              <p>先创建一个<b>模拟项目</b>体验双会话循环：设置目标、PRD 与停止阈值，启动后评估会话 A、执行会话 B 与本地协调会自动接力，达到阈值停止。</p>
              <button className="btn btn-primary" onClick={() => setShowNew(true)}>创建模拟项目</button>
            </div>
          )}
          {status?.projects.map((project) => (
            <ProjectCard
              key={project.projectId}
              project={project}
              selected={project.projectId === selectedId}
              onSelect={() => setSelectedId(project.projectId)}
            />
          ))}
        </aside>
        <main className="content">
          {selected ? (
            <ProjectDetail
              project={selected}
              onCommand={command}
            />
          ) : (
            <p className="muted">从左侧选择一个项目查看详情。</p>
          )}
        </main>
      </div>

      {showNew && (
        <NewProjectForm
          onClose={() => setShowNew(false)}
          onCreated={(projectId) => {
            setShowNew(false);
            setSelectedId(projectId);
          }}
        />
      )}
    </div>
  );
}

function ProjectCard(props: { project: ProjectView; selected: boolean; onSelect: () => void }) {
  const { project } = props;
  const score = project.lastEvaluation?.totalCompleteness;
  return (
    <button className={`project-card ${props.selected ? 'selected' : ''}`} onClick={props.onSelect}>
      <div className="card-title-row">
        <span className="card-name">{project.name}</span>
        <span className={`badge ${STATE_CLASS[project.state]}`}>{STATE_LABEL[project.state]}</span>
      </div>
      <div className="card-meta muted">
        轮次 {project.roundIndex} · 阈值 {project.stopThresholdPercent}%
        {project.pauseReason ? ` · ${PAUSE_LABEL[project.pauseReason]}` : ''}
      </div>
      <div className={`card-score ${score !== undefined && score >= project.stopThresholdPercent ? 'score-ok' : 'score-pending'}`}>
        {score !== undefined ? `${score}%` : '—'}
      </div>
    </button>
  );
}
