// Codex/ZCODE 产品 Adapter：批次A仅注册与能力申报，真实接入属批次B联调（W1）。
// 原则：不杜撰会话标识、不伪造回执、不猜测选择器；任何操作调用都显式失败
// （ADAPTER_NOT_INTEGRATED），由核心按 adapter_failure 暂停对应项目。
// 官方接口（Codex app-server / ZCODE Hooks）与 UIA 控件路径的取舍在批次B按实测决定，
// 本文件不预设具体连接实现。
import type {
  AdapterCapabilities, AdapterHealth, AdapterSendReceipt, ProductAdapter,
  ProductSessionInfo, SessionReply, SendPromptMeta,
} from './types.js';
import { AdapterError } from './types.js';

export class PendingIntegrationAdapter implements ProductAdapter {
  constructor(
    readonly productId: 'codex' | 'zcode',
    private readonly notes: string[],
  ) {}

  capabilities(): AdapterCapabilities {
    return {
      productId: this.productId,
      readReply: 'unknown',
      sendPrompt: 'unknown',
      cancelRunningTask: 'unknown',
      integration: 'pending-integration',
      notes: this.notes,
    };
  }

  async health(): Promise<AdapterHealth> {
    return {
      productId: this.productId,
      status: 'not-integrated',
      detail: `${this.productId} 真实接入尚未联调（批次B/W1）；绑定、读取与发送均不可用`,
    };
  }

  async listSessions(): Promise<ProductSessionInfo[]> {
    // 不枚举、不猜测真实会话：真实会话发现属联调后能力。
    return [];
  }

  async verifyBinding(): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: `${this.productId} 未联调：无法核对绑定` };
  }

  async sendPrompt(): Promise<AdapterSendReceipt> {
    throw new AdapterError('ADAPTER_NOT_INTEGRATED', `${this.productId} 发送不可用：等待批次B真实联调`);
  }

  async readReply(): Promise<SessionReply | null> {
    throw new AdapterError('ADAPTER_NOT_INTEGRATED', `${this.productId} 读取不可用：等待批次B真实联调`);
  }
}

export function createCodexAdapter(): PendingIntegrationAdapter {
  return new PendingIntegrationAdapter('codex', [
    '官方 app-server（thread/read、turn/start）对已有桌面会话的可见性与竞争关系待实测',
    '控件路径需 Windows helper（native/windows）联调后验证',
    '不读取应用私有数据库，不创建替代会话',
  ]);
}

export function createZcodeAdapter(): PendingIntegrationAdapter {
  return new PendingIntegrationAdapter('zcode', [
    'Hooks 提供 session_id/cwd 线索，不等于完整异步发送接口',
    '项目级 Hook 忽略、变更须新会话等官方约束使已有会话观察待实测',
    '不修改用户配置以迁就事件采集',
  ]);
}
