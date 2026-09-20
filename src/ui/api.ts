// 渲染层 API 契约：preload(contextBridge) 暴露 window.lfrr，与本文件类型一一对应。
// renderer 无 Node 权限；所有调用经 main 校验后转发协调服务（W5 实现两侧）。
import type { AppStatusView, AuditEventItem, ModelStatusView, RecordItem } from '../shared/views.js';
import type { CreateProjectInput, ServiceResult } from '../shared/service-protocol.js';
import type { AdapterCapabilities, ProductSessionInfo } from '../adapters/types.js';

export interface LfrrApi {
  getState(): Promise<AppStatusView>;
  checkModel(): Promise<ModelStatusView>;
  listProducts(): Promise<AdapterCapabilities[]>;
  listSessions(productId: string): Promise<ProductSessionInfo[]>;
  createProject(input: CreateProjectInput): Promise<ServiceResult>;
  updateProject(projectId: string, patch: { name?: string; goal?: string; prdRef?: string }): Promise<ServiceResult>;
  setThreshold(projectId: string, threshold: number): Promise<ServiceResult>;
  startProject(projectId: string): Promise<ServiceResult>;
  pauseProject(projectId: string): Promise<ServiceResult>;
  resumeProject(projectId: string): Promise<ServiceResult>;
  stopProject(projectId: string): Promise<ServiceResult>;
  abandonIntent(projectId: string, intentId: number): Promise<ServiceResult>;
  stopAll(): Promise<ServiceResult>;
  /** 解除全局停止（不自动复活任何项目）。 */
  resumeAll(): Promise<ServiceResult>;
  /** 专用前台自动操作模式开关（显式开启/撤销）。 */
  setForegroundMode(enabled: boolean): Promise<ServiceResult>;
  listRecords(projectId: string, limit: number): Promise<RecordItem[]>;
  listEvents(projectId: string | null, limit: number): Promise<AuditEventItem[]>;
  /** 订阅状态推送；返回取消订阅函数。 */
  onState(callback: (status: AppStatusView) => void): () => void;
}

declare global {
  interface Window {
    lfrr: LfrrApi;
  }
}

export const LFRR_API_KEY = 'lfrr' as const;
