// 协调服务装配（W5/W6 共用）：Coordinator + Adapter 注册表 + 模型 的进程内实例。
// simulated 模式：SimulatedAdapter + 内置假模型服务（真实 HTTP 链路）；
// production 模式：SimulatedAdapter 不可用，Codex/ZCODE 待批次B联调，模型为用户配置的 Ollama。
// 装配本身与 Electron 无关，可在 node:test 中直连（服务协议契约测试即走本模块）。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, type Store } from '../storage/database.js';
import { RecordStore } from '../storage/records.js';
import { Coordinator } from '../core/coordinator.js';
import { ForegroundQueue, SerialQueue } from '../core/queues.js';
import { WorkspaceRegistry } from '../core/workspace-lock.js';
import { SessionRegistry } from '../core/session-lock.js';
import { SimulatedAdapter } from '../adapters/simulated/simulated-adapter.js';
import { createCodexAdapter, createZcodeAdapter } from '../adapters/pending-integration.js';
import { OllamaCoordinationModel, type CoordinationModel } from '../ollama/model-service.js';
import { startFakeModelServer, type FakeModelServer } from '../fake-model/fake-ollama-server.js';
import type { ServiceCommand, ServiceResult } from '../shared/service-protocol.js';
import type { AdapterCapabilities, ProductAdapter } from '../adapters/types.js';
import type { ProductSessionInfo } from '../adapters/types.js';
import type { AppStatusView, ModelStatusView, RecordItem } from '../shared/views.js';

export interface CoordinationServiceOptions {
  mode: 'simulated' | 'production';
  dbDir?: string;
  modelEndpoint?: string;
  modelName?: string;
  pollIntervalMs?: number;
  /** 状态变化回调（事件驱动推送；entry 注入后宿主不再需要轮询）。 */
  onStatusChanged?: ((status: AppStatusView) => void) | undefined;
}

export class CoordinationService {
  readonly coordinator: Coordinator;
  readonly adapters: Map<string, ProductAdapter>;
  private readonly store: RecordStore;
  private readonly db: Store;
  private fakeModel: FakeModelServer | null = null;
  private simulatedAdapter: SimulatedAdapter | null = null;
  private disposed = false;

  private constructor(
    private readonly options: CoordinationServiceOptions,
    private readonly model: CoordinationModel,
    adapters: Map<string, ProductAdapter>,
    db: Store,
    store: RecordStore,
  ) {
    this.adapters = adapters;
    this.db = db;
    this.store = store;
    this.coordinator = new Coordinator({
      store,
      model,
      adapters,
      modelQueue: new SerialQueue(),
      foregroundQueue: new ForegroundQueue(),
      workspaces: new WorkspaceRegistry(),
      sessions: new SessionRegistry(),
      mode: options.mode,
      pollIntervalMs: options.pollIntervalMs,
      onStatus: options.onStatusChanged
        ? () => options.onStatusChanged?.(this.coordinator.getStatus())
        : undefined,
    });
    this.coordinator.loadPersisted();
  }

  static async create(options: CoordinationServiceOptions): Promise<CoordinationService> {
    const dbDir = options.dbDir ?? mkdtempSync(join(tmpdir(), 'lfrr-app-'));
    const db = createStore(dbDir);
    const store = new RecordStore(db.db);
    const adapters = new Map<string, ProductAdapter>();
    // R10：生产模式不注册可启动的模拟 Adapter（模拟只是测试依赖，不进入生产兜底）。
    const simulatedAdapter = options.mode === 'simulated'
      ? new SimulatedAdapter(undefined, { replyDelayMs: 60 })
      : null;
    if (simulatedAdapter) adapters.set('simulated', simulatedAdapter);
    adapters.set('codex', createCodexAdapter());
    adapters.set('zcode', createZcodeAdapter());
    let model: CoordinationModel;
    if (options.mode === 'simulated') {
      // 模拟模式：内置假模型服务（真实 HTTP/Ollama 协议链路），仅本机回环、随服务生命周期关闭。
      const fake = await startFakeModelServer('fake-qwen3:8b');
      model = new OllamaCoordinationModel(fake.url, 'fake-qwen3:8b');
      const service = new CoordinationService(options, model, adapters, db, store);
      service.fakeModel = fake;
      service.simulatedAdapter = simulatedAdapter;
      return service;
    }
    const endpoint = options.modelEndpoint ?? 'http://127.0.0.1:11434';
    const name = options.modelName ?? 'qwen3:8b';
    model = new OllamaCoordinationModel(endpoint, name);
    return new CoordinationService(options, model, adapters, db, store);
  }

  listProducts(): AdapterCapabilities[] {
    return [...this.adapters.values()].map((adapter) => adapter.capabilities());
  }

  async listSessions(productId: string): Promise<ProductSessionInfo[]> {
    const adapter = this.adapters.get(productId);
    if (!adapter) return [];
    return adapter.listSessions();
  }

  async checkModel(): Promise<ModelStatusView> {
    return this.coordinator.checkModel();
  }

  listRecords(projectId: string, limit: number): RecordItem[] {
    return this.coordinator.listRecords(projectId, limit);
  }

  async handleCommand(command: ServiceCommand): Promise<ServiceResult> {
    if (this.disposed) return { ok: false, code: 'SERVICE_DISPOSED', message: '服务已关闭' };
    switch (command.kind) {
      case 'init':
        return { ok: true };
      case 'getState':
        return { ok: true, status: this.coordinator.getStatus() };
      case 'createProject':
        return this.coordinator.createProject(command.input);
      case 'updateProject':
        return this.coordinator.updateProject(command.projectId, command.patch);
      case 'setThreshold':
        return this.coordinator.setThreshold(command.projectId, command.threshold);
      case 'startProject':
        return this.coordinator.startProject(command.projectId);
      case 'pauseProject':
        return this.coordinator.pauseProject(command.projectId);
      case 'resumeProject':
        return this.coordinator.resumeProject(command.projectId);
      case 'stopProject':
        return this.coordinator.stopProject(command.projectId);
      case 'abandonIntent':
        return this.coordinator.abandonIntent(command.projectId, command.intentId);
      case 'stopAll':
        return this.coordinator.stopAll();
      case 'resumeAll':
        return this.coordinator.resumeAll();
      case 'setForegroundMode':
        return this.coordinator.setForegroundMode(command.enabled);
      case 'listProducts':
        return { ok: true, products: this.listProducts() };
      case 'listSessions':
        return { ok: true, sessions: await this.listSessions(command.productId) };
      case 'checkModel':
        return { ok: true, model: await this.checkModel() };
      case 'listRecords':
        return { ok: true, records: this.listRecords(command.projectId, command.limit) };
      case 'listEvents':
        return { ok: true, events: this.coordinator.listEvents(command.projectId, command.limit) };
      case 'testInjectFault':
        return this.injectTestFault(command.scope, command.sessionId);
      case 'shutdown':
        return { ok: true };
      default:
        return { ok: false, code: 'UNKNOWN_COMMAND', message: '未知命令' };
    }
  }

  /** 测试基础设施：仅模拟模式可注入故障；生产模式明确拒绝。 */
  private injectTestFault(scope: 'send-unknown' | 'clear', sessionId: string): ServiceResult {
    if (this.options.mode !== 'simulated') {
      return { ok: false, code: 'TEST_FAULT_UNSUPPORTED', message: '故障注入仅模拟模式可用，生产模式拒绝' };
    }
    if (!this.simulatedAdapter) {
      return { ok: false, code: 'TEST_FAULT_UNSUPPORTED', message: '模拟 Adapter 未注册' };
    }
    this.simulatedAdapter.setFaults(sessionId, scope === 'clear' ? null : { sendReceipt: 'unknown' });
    return { ok: true };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.coordinator.dispose();
    if (this.fakeModel) await this.fakeModel.close();
    this.db.close();
  }
}
