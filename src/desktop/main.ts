// Electron 主进程（W5）：安全窗口 + 受限 IPC + 协调服务生命周期。
// 安全基线（tech-stack §3）：contextIsolation、sandbox、无 Node 权限 renderer、
// 仅本地资源、导航锁定、有限 IPC（无任意 shell/文件入口）。
import { app, BrowserWindow, ipcMain, shell, utilityProcess, type UtilityProcess } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import {
  isServiceEnvelope, makeResultEnvelope, type ServiceCommand, type ServiceResult,
} from '../shared/service-protocol.js';
import { ServiceProcessManager, type ServiceProcessHandle } from './service-process.js';

// tsc NodeNext 输出 ESM：无 __dirname，用 import.meta.url 推导。
const currentDir = dirname(fileURLToPath(import.meta.url));

app.commandLine.appendSwitch('disable-http-cache');

const isDev = process.env.LFRR_DEV === '1';

// 临时启动诊断（打包问题定位用；正常用户数据目录下 main-boot.log）。
function bootLog(stage: string, detail: string): void {
  try {
    mkdirSync(userDataDir(), { recursive: true });
    appendFileSync(join(userDataDir(), 'main-boot.log'), `${new Date().toISOString()} [${stage}] ${detail}
`);
  } catch { /* 忽略 */ }
}

process.on('uncaughtException', (error) => bootLog('uncaughtException', String(error?.stack ?? error)));
process.on('unhandledRejection', (reason) => bootLog('unhandledRejection', String(reason)));
let mainWindow: BrowserWindow | null = null;
let serviceManager: ServiceProcessManager | null = null;

function userDataDir(): string {
  const dir = process.env.LFRR_USER_DATA ?? app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function bootService(): Promise<void> {
  // 协调核心、SQLite 和模型请求在 Electron utility 进程中运行，主进程只负责
  // 窗口、受限 IPC 和生命周期。默认模拟模式仍只用于本地开发与桌面 E2E。
  const mode = process.env.LFRR_MODE === 'production' ? 'production' : 'simulated';
  const child = utilityProcess.fork(join(currentDir, 'service-entry.cjs'), [], {
    serviceName: 'lfrr-coordination',
    stdio: 'ignore',
  });
  const manager = new ServiceProcessManager(asServiceProcessHandle(child), {
    commandTimeoutMs: 15_000,
    onExit: (code) => bootLog('service', `utility process exited code=${String(code)}`),
  });
  manager.bind();
  serviceManager = manager;
  bootLog('service', `utility forked pid=${String(child.pid)}`);
  const init = await manager.command({
    kind: 'init',
    mode,
    dbDir: join(userDataDir(), 'coordination'),
    modelEndpoint: process.env.LFRR_MODEL_ENDPOINT ?? 'http://127.0.0.1:11434',
    modelName: process.env.LFRR_MODEL_NAME ?? 'qwen3:8b',
  }, 30_000);
  bootLog('service-init', JSON.stringify(init));
  if (!init.ok) {
    child.kill();
    throw new Error(`协调 utility 进程初始化失败：${init.code} ${init.message}`);
  }
  // 状态变化推送到窗口（节流：同 tick 合并）。
  let pushTimer: NodeJS.Timeout | null = null;
  const pushStatus = async () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void serviceCommand({ kind: 'getState' }, 5_000).then((result) => {
        if (mainWindow && !mainWindow.isDestroyed() && result.ok && result.status) {
          mainWindow.webContents.send('lfrr:status', result.status);
        }
      });
    }, 80);
  };
  const interval = setInterval(() => void pushStatus(), 400);
  app.on('before-quit', () => clearInterval(interval));
}

function asServiceProcessHandle(child: UtilityProcess): ServiceProcessHandle {
  return {
    send(message, callback) {
      try {
        child.postMessage(message);
        callback?.(null);
      } catch (error) {
        callback?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    on(event, listener) {
      if (event === 'message') {
        child.on('message', (eventMessage: unknown) => {
          // Electron utilityProcess emits MessageEvent; unwrap its data payload.
          const payload = (eventMessage as { data?: unknown } | null)?.data ?? eventMessage;
          (listener as (message: unknown) => void)(payload);
        });
      } else {
        child.on('exit', (code) => listener(typeof code === 'number' ? code : null));
      }
      return child;
    },
    kill() {
      child.kill();
    },
  };
}

async function serviceCommand(command: ServiceCommand, timeoutMs?: number): Promise<ServiceResult> {
  const manager = serviceManager;
  if (!manager) return { ok: false, code: 'SERVICE_UNAVAILABLE', message: '服务未就绪' };
  return manager.command(command, timeoutMs);
}

/** R2：逐命令参数校验（不只 kind 白名单）；返回错误码或 null。 */
function validateCommand(command: ServiceCommand): string | null {
  const isNonEmpty = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256;
  switch (command.kind) {
    case 'init':
    case 'getState':
    case 'stopAll':
    case 'resumeAll':
    case 'shutdown':
      return null;
    case 'setForegroundMode':
      return typeof command.enabled === 'boolean' ? null : 'enabled 必须是布尔值';
    case 'listProducts':
    case 'checkModel':
      return null;
    case 'listSessions':
      return isNonEmpty(command.productId) ? null : 'productId 非法';
    case 'createProject':
      if (!command.input || typeof command.input !== 'object' || !command.input.config
        || typeof command.input.config !== 'object') {
        return 'input.config 必须是对象';
      }
      return null;
    case 'updateProject': {
      if (!isNonEmpty(command.projectId)) return 'projectId 非法';
      const patch = command.patch ?? {};
      for (const key of ['name', 'goal', 'prdRef'] as const) {
        if (patch[key] !== undefined && (typeof patch[key] !== 'string' || patch[key].length > 20_000)) {
          return `patch.${key} 非法`;
        }
      }
      return null;
    }
    case 'setThreshold':
      if (!isNonEmpty(command.projectId)) return 'projectId 非法';
      if (typeof command.threshold !== 'number' || !Number.isFinite(command.threshold)) return 'threshold 必须是数字';
      return null;
    case 'startProject':
    case 'pauseProject':
    case 'resumeProject':
    case 'stopProject':
      return isNonEmpty(command.projectId) ? null : 'projectId 非法';
    case 'abandonIntent':
      if (!isNonEmpty(command.projectId)) return 'projectId 非法';
      if (!Number.isInteger(command.intentId) || command.intentId < 1) return 'intentId 必须是正整数';
      return null;
    case 'listRecords':
    case 'listEvents':
      if (command.kind === 'listRecords' && !isNonEmpty(command.projectId)) return 'projectId 非法';
      if (command.kind === 'listEvents' && command.projectId !== null && !isNonEmpty(command.projectId)) return 'projectId 非法';
      if (!Number.isInteger(command.limit) || command.limit < 1 || command.limit > 500) return 'limit 必须是 1-500 整数';
      return null;
    default:
      return '未知命令';
  }
}

function registerIpc(): void {
  ipcMain.handle('lfrr:getState', async () => {
    const result = await serviceCommand({ kind: 'getState' });
    return result?.ok ? result.status ?? null : null;
  });
  ipcMain.handle('lfrr:command', async (_event, envelope: unknown) => {
    if (!isServiceEnvelope(envelope) || envelope.id === null || typeof envelope.id !== 'number') {
      return makeResultEnvelope(-1, { ok: false, code: 'INVALID_ENVELOPE', message: '非法服务信封' });
    }
    const command = envelope.payload as ServiceCommand;
    if (!command || typeof command !== 'object' || !('kind' in command)) {
      return makeResultEnvelope(envelope.id, { ok: false, code: 'UNKNOWN_COMMAND', message: '未知或非法命令' });
    }
    const invalidReason = validateCommand(command);
    if (invalidReason !== null) {
      return makeResultEnvelope(envelope.id, { ok: false, code: 'INVALID_COMMAND', message: invalidReason });
    }
    const result = await serviceCommand(command);
    return makeResultEnvelope(envelope.id, result);
  });
  ipcMain.handle('lfrr:listProducts', async () => {
    const result = await serviceCommand({ kind: 'listProducts' });
    return result?.ok ? result.products ?? [] : [];
  });
  ipcMain.handle('lfrr:listSessions', async (_event, productId: unknown) => {
    if (typeof productId !== 'string') return [];
    const result = await serviceCommand({ kind: 'listSessions', productId });
    return result?.ok ? result.sessions ?? [] : [];
  });
  ipcMain.handle('lfrr:checkModel', async () => {
    const result = await serviceCommand({ kind: 'checkModel' });
    return result?.ok ? result.model ?? null : null;
  });
  ipcMain.handle('lfrr:listRecords', async (_event, projectId: unknown, limit: unknown) => {
    if (typeof projectId !== 'string' || typeof limit !== 'number') return [];
    const result = await serviceCommand({ kind: 'listRecords', projectId, limit: Math.min(Math.max(limit, 1), 500) });
    return result?.ok ? result.records ?? [] : [];
  });
  ipcMain.handle('lfrr:listEvents', async (_event, projectId: unknown, limit: unknown) => {
    if (!serviceManager) return [];
    const normalized = typeof projectId === 'string' ? projectId : null;
    const count = typeof limit === 'number' ? Math.min(Math.max(limit, 1), 500) : 100;
    const result = await serviceCommand({ kind: 'listEvents', projectId: normalized, limit: count });
    return result.ok ? result.events ?? [] : [];
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: '左脚踩右脚 / Left Foot on Right Foot',
    backgroundColor: '#f6f7f8',
    webPreferences: {
      // R1：沙箱 preload 必须是单文件 CommonJS（esbuild 产物），保持 sandbox+contextIsolation。
      preload: join(currentDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  // 导航锁定：只允许本地文件；外部链接交给系统浏览器（且默认无外部链接）。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') && !url.includes('localhost')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? 'http://127.0.0.1:5183' : undefined;
    if (allowed ? !url.startsWith(allowed) : !url.startsWith('file://')) {
      event.preventDefault();
    }
  });
  if (isDev) {
    void mainWindow.loadURL('http://127.0.0.1:5183');
  } else {
    // dist/desktop/main.js -> 仓库根 dist-ui/
    const uiPath = join(currentDir, '../../dist-ui/index.html');
    void mainWindow.loadFile(uiPath).catch((error) => {
      try {
        bootLog('loadFile', `${uiPath}: ${String(error)}`);
      } catch { /* 诊断失败不阻塞 */ }
    });
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // R11：E2E 模式（LFRR_E2E=1）——renderer 全流程验证后输出结果并退出。
  if (process.env.LFRR_E2E === '1') {
    const { runDesktopE2E } = await import('./e2e.js');
    runDesktopE2E(mainWindow);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  void app.whenReady().then(async () => {
    bootLog('ready', `app ready; userData=${userDataDir()}`);
    registerIpc();
    try {
      await bootService();
      bootLog('service', 'booted ok');
    } catch (error) {
      bootLog('service', `boot FAILED: ${error instanceof Error ? error.stack : String(error)}`);
      console.error('[lfrr] service boot failed:', error);
    }
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });
  app.on('window-all-closed', () => {
    app.quit();
  });
  app.on('before-quit', (event) => {
    if (serviceManager) {
      event.preventDefault();
      const closing = serviceManager;
      serviceManager = null;
      void closing.shutdown().finally(() => app.exit(0));
    }
  });
}
