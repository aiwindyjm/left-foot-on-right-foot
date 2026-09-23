// 受限 preload（W5）：contextBridge 只暴露结构化 API，无 Node 权限、无任意参数透传。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppStatusView, ModelStatusView, RecordItem } from '../shared/views.js';
import type { AdapterCapabilities, ProductSessionInfo } from '../adapters/types.js';
import {
  SERVICE_PROTOCOL_VERSION, isServiceEnvelope,
  type CreateProjectInput, type ServiceCommand, type ServiceEnvelope, type ServiceResult,
} from '../shared/service-protocol.js';
import type { LfrrApi } from '../ui/api.js';

let envelopeId = 1;
let statusHandler: ((status: AppStatusView) => void) | null = null;

ipcRenderer.on('lfrr:status', (_event: IpcRendererEvent, status: unknown) => {
  if (statusHandler && status && typeof status === 'object' && 'projects' in status) {
    statusHandler(status as AppStatusView);
  }
});

/**
 * R2：发送命令并解包应答信封——校验协议版本、关联 ID 与 payload 形状后
 * 才把 ServiceResult 交给 UI；任何不匹配都按错误抛出（不得把信封强转结果）。
 */
async function sendCommand(command: ServiceCommand): Promise<ServiceResult> {
  const id = envelopeId;
  envelopeId += 1;
  const envelope: ServiceEnvelope<ServiceCommand> = {
    v: SERVICE_PROTOCOL_VERSION,
    id,
    payload: command,
  };
  const reply: unknown = await ipcRenderer.invoke('lfrr:command', envelope);
  if (!isServiceEnvelope(reply)) {
    throw new Error('SERVICE_PROTOCOL: 应答不是合法服务信封');
  }
  if (reply.id !== id) {
    throw new Error(`SERVICE_PROTOCOL: 应答 ID 不匹配（期望 ${id}，收到 ${String(reply.id)}）`);
  }
  const payload = reply.payload as ServiceResult | null;
  if (!payload || typeof payload !== 'object' || typeof (payload as ServiceResult).ok !== 'boolean') {
    throw new Error('SERVICE_PROTOCOL: 应答缺少结果载荷');
  }
  return payload;
}

const api: LfrrApi = {
  async getState() {
    const status = (await ipcRenderer.invoke('lfrr:getState')) as AppStatusView | null;
    if (!status) {
      throw new Error('SERVICE_UNAVAILABLE: 协调服务未就绪');
    }
    return status;
  },
  async checkModel(): Promise<ModelStatusView> {
    const status = (await ipcRenderer.invoke('lfrr:checkModel')) as ModelStatusView | null;
    if (!status) throw new Error('SERVICE_UNAVAILABLE: 协调服务未就绪');
    return status;
  },
  async listProducts() {
    return (await ipcRenderer.invoke('lfrr:listProducts')) as AdapterCapabilities[];
  },
  async listSessions(productId: string) {
    return (await ipcRenderer.invoke('lfrr:listSessions', String(productId))) as ProductSessionInfo[];
  },
  createProject(input: CreateProjectInput) {
    return sendCommand({ kind: 'createProject', input });
  },
  updateProject(projectId: string, patch: { name?: string; goal?: string; prdRef?: string }) {
    return sendCommand({ kind: 'updateProject', projectId: String(projectId), patch });
  },
  setThreshold(projectId: string, threshold: number) {
    return sendCommand({ kind: 'setThreshold', projectId: String(projectId), threshold: Number(threshold) });
  },
  startProject(projectId: string) {
    return sendCommand({ kind: 'startProject', projectId: String(projectId) });
  },
  pauseProject(projectId: string) {
    return sendCommand({ kind: 'pauseProject', projectId: String(projectId) });
  },
  resumeProject(projectId: string) {
    return sendCommand({ kind: 'resumeProject', projectId: String(projectId) });
  },
  stopProject(projectId: string) {
    return sendCommand({ kind: 'stopProject', projectId: String(projectId) });
  },
  abandonIntent(projectId: string, intentId: number) {
    return sendCommand({ kind: 'abandonIntent', projectId: String(projectId), intentId: Number(intentId) });
  },
  stopAll() {
    return sendCommand({ kind: 'stopAll' });
  },
  resumeAll() {
    return sendCommand({ kind: 'resumeAll' });
  },
  setForegroundMode(enabled: boolean) {
    return sendCommand({ kind: 'setForegroundMode', enabled: enabled === true });
  },
  testInjectFault(scope: 'send-unknown' | 'clear', sessionId: string) {
    return sendCommand({ kind: 'testInjectFault', scope, sessionId: String(sessionId) });
  },
  async listRecords(projectId: string, limit: number) {
    return (await ipcRenderer.invoke('lfrr:listRecords', String(projectId), Number(limit))) as RecordItem[];
  },
  async listEvents(projectId: string | null, limit: number) {
    return (await ipcRenderer.invoke('lfrr:listEvents', projectId, Number(limit))) as Awaited<ReturnType<LfrrApi['listEvents']>>;
  },
  onState(callback: (status: AppStatusView) => void) {
    statusHandler = callback;
    return () => {
      if (statusHandler === callback) statusHandler = null;
    };
  },
};

contextBridge.exposeInMainWorld('lfrr', api);
