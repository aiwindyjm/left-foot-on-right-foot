import { useEffect, useState } from 'react';
import type { AdapterCapabilities, ProductSessionInfo } from '../adapters/types.js';
import { INTEGRATION_LABEL } from './labels.js';

interface FormState {
  name: string;
  goal: string;
  prdRef: string;
  workspacePath: string;
  evaluatorProductId: string;
  evaluatorSessionId: string;
  executorProductId: string;
  executorSessionId: string;
  threshold: string;
}

const INITIAL: FormState = {
  name: '',
  goal: '',
  prdRef: '',
  workspacePath: '',
  evaluatorProductId: 'simulated',
  evaluatorSessionId: '',
  executorProductId: 'simulated',
  executorSessionId: '',
  threshold: '',
};

export function NewProjectForm(props: { onClose: () => void; onCreated: (projectId: string) => void }) {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [products, setProducts] = useState<AdapterCapabilities[]>([]);
  const [sessions, setSessions] = useState<Record<string, ProductSessionInfo[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const list = await window.lfrr.listProducts();
        setProducts(list);
        const map: Record<string, ProductSessionInfo[]> = {};
        for (const product of list) {
          map[product.productId] = await window.lfrr.listSessions(product.productId);
        }
        setSessions(map);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const patch = (next: Partial<FormState>) => setForm((current) => ({ ...current, ...next }));

  const thresholdNumber = Number(form.threshold);
  const thresholdValid = form.threshold.trim().length > 0
    && Number.isFinite(thresholdNumber) && thresholdNumber > 0 && thresholdNumber <= 100;
  const selfLoop = form.evaluatorProductId === form.executorProductId
    && form.evaluatorSessionId.length > 0
    && form.evaluatorSessionId === form.executorSessionId;
  const fieldsValid = form.name.trim().length > 0
    && form.goal.trim().length > 0
    && form.prdRef.trim().length > 0
    && form.workspacePath.trim().length > 0
    && form.evaluatorSessionId.length > 0
    && form.executorSessionId.length > 0
    && thresholdValid
    && !selfLoop;

  const submitWithId = async () => {
    const id = `proj-${Date.now().toString(36)}`;
    setSubmitting(true);
    setError(null);
    try {
      const result = await window.lfrr.createProject({
        config: {
          projectId: id,
          name: form.name.trim(),
          workspacePath: form.workspacePath.trim(),
          goal: form.goal.trim(),
          prdRef: form.prdRef.trim(),
          evaluator: { productId: form.evaluatorProductId, sessionId: form.evaluatorSessionId, label: null },
          executor: { productId: form.executorProductId, sessionId: form.executorSessionId, label: null },
          stopThresholdPercent: thresholdNumber,
        },
      });
      if (!result.ok) {
        throw new Error(`${result.code}: ${result.message ?? '创建失败'}`);
      }
      props.onCreated(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2>新建项目</h2>
        <div className="form-grid">
          <label>项目名称
            <input value={form.name} onChange={(event) => patch({ name: event.target.value })}
              placeholder="例如：登录模块重构" />
          </label>
          <label>目标（goal）
            <textarea rows={3} value={form.goal} onChange={(event) => patch({ goal: event.target.value })}
              placeholder="描述这个项目要完成什么" />
          </label>
          <label>PRD 范围引用
            <input value={form.prdRef} onChange={(event) => patch({ prdRef: event.target.value })}
              placeholder="例如 docs/PRD.md@1.6 或模拟场景说明" />
          </label>
          <label>工作区路径
            <input value={form.workspacePath} onChange={(event) => patch({ workspacePath: event.target.value })}
              placeholder="例如 C:\\work\\demo（模拟项目可不存在的路径）" />
          </label>
          <SessionPicker
            caption="评估会话 A"
            products={products}
            sessions={sessions}
            productId={form.evaluatorProductId}
            sessionId={form.evaluatorSessionId}
            onProduct={(value) => patch({ evaluatorProductId: value, evaluatorSessionId: '' })}
            onSession={(value) => patch({ evaluatorSessionId: value })}
          />
          <SessionPicker
            caption="执行会话 B"
            products={products}
            sessions={sessions}
            productId={form.executorProductId}
            sessionId={form.executorSessionId}
            onProduct={(value) => patch({ executorProductId: value, executorSessionId: '' })}
            onSession={(value) => patch({ executorSessionId: value })}
          />
          {selfLoop && <p className="field-error">评估与执行不能绑定同一会话（自回路拒绝）。</p>}
          <label>停止阈值（%）
            <input
              value={form.threshold}
              onChange={(event) => patch({ threshold: event.target.value })}
              placeholder="请设置 0-100 的停止阈值（例如 80）"
              inputMode="decimal"
            />
            <span className="hint">阈值是每次运行的用户配置，无默认值；达到阈值即停止新派发，80 仅为示例。</span>
          </label>
          {!thresholdValid && form.threshold.trim().length > 0 && (
            <p className="field-error">阈值必须大于 0 且不超过 100。</p>
          )}
        </div>
        {error && <p className="field-error">{error}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn btn-primary" disabled={!fieldsValid || submitting} onClick={() => void submitWithId()}>
            {submitting ? '创建中…' : '创建项目'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionPicker(props: {
  caption: string;
  products: AdapterCapabilities[];
  sessions: Record<string, ProductSessionInfo[]>;
  productId: string;
  sessionId: string;
  onProduct: (value: string) => void;
  onSession: (value: string) => void;
}) {
  const list = props.sessions[props.productId] ?? [];
  return (
    <div className="session-picker">
      <div className="picker-row">
        <label>产品（{props.caption}）
          <select value={props.productId} onChange={(event) => props.onProduct(event.target.value)}>
            {props.products.map((product) => (
              <option key={product.productId} value={product.productId}>
                {product.productId} · {INTEGRATION_LABEL[product.integration] ?? product.integration}
              </option>
            ))}
          </select>
        </label>
        <label>会话
          <select value={props.sessionId} onChange={(event) => props.onSession(event.target.value)}>
            <option value="">请选择…</option>
            {list.map((session) => (
              <option key={session.sessionId} value={session.sessionId}>
                {session.label ?? session.sessionId}
              </option>
            ))}
          </select>
        </label>
      </div>
      {list.length === 0 && (
        <p className="hint">该产品暂无可用会话（未联调产品需批次B接入后列出真实会话）。</p>
      )}
    </div>
  );
}
