// 展示辅助：状态/阶段/暂停原因的中文文案与样式类。
import type { ProjectView } from '../shared/views.js';
import type { ProjectRunState, CyclePhase, PauseReason } from '../core/states.js';

export const STATE_LABEL: Record<ProjectRunState, string> = {
  created: '未启动',
  running: '运行中',
  paused: '已暂停',
  stopped_threshold: '达标停止',
  stopped_user: '已停止',
  error: '错误',
};

export const STATE_CLASS: Record<ProjectRunState, string> = {
  created: 'state-idle',
  running: 'state-running',
  paused: 'state-paused',
  stopped_threshold: 'state-ok',
  stopped_user: 'state-idle',
  error: 'state-error',
};

export const PHASE_LABEL: Record<CyclePhase, string> = {
  request_evaluation: '向评估会话发送核对请求',
  await_evaluation: '等待评估会话回复',
  understanding: '本地模型理解回复',
  clarify: '向评估会话澄清',
  threshold_check: '阈值判定',
  dispatch: '派发提示词到执行会话',
  await_execution: '等待执行会话结果',
  collect_result: '回收执行结果',
};

export const PAUSE_LABEL: Record<PauseReason, string> = {
  user: '用户暂停',
  clarify_limit: '澄清次数达上限',
  stalled: '多轮无进展',
  round_timeout: '轮次超时',
  model_failure: '本地模型故障',
  adapter_failure: '会话接入故障',
  storage_failure: '存储失败',
  unknown_send: '发送回执未知',
  duplicate_reply: '重复回复',
  binding_lost: '会话绑定失效',
  recovery_pending: '等待重启核对',
  foreground_required: '前台模式未开启',
  round_limit: '总轮次上限',
  time_limit: '运行总时长上限',
};

export const RECORD_LABEL: Record<string, string> = {
  evaluation_request: '评估请求',
  evaluation_reply: '评估回复',
  clarify: '澄清',
  prompt_dispatch: '提示词派发',
  execution_result: '执行结果',
  threshold_change: '阈值变更',
  event: '事件',
};

export const INTEGRATION_LABEL: Record<string, string> = {
  simulated: '模拟',
  'pending-integration': '未联调',
  partial: '部分接入',
  verified: '已实测',
};

export function completenessClass(total: number, threshold: number): string {
  return total >= threshold ? 'score-ok' : 'score-pending';
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

export function projectControls(view: ProjectView): Array<{ action: string; label: string; danger?: boolean }> {
  switch (view.state) {
    case 'created':
      return [{ action: 'start', label: '启动' }];
    case 'running':
      return [
        { action: 'pause', label: '暂停' },
        { action: 'stop', label: '停止', danger: true },
      ];
    case 'paused':
      return [
        { action: 'resume', label: '恢复' },
        { action: 'stop', label: '停止', danger: true },
      ];
    case 'stopped_threshold':
    case 'stopped_user':
      return [
        { action: 'start', label: '重新开始' },
      ];
    case 'error':
      return [{ action: 'stop', label: '确认停止', danger: true }];
    default:
      return [];
  }
}
