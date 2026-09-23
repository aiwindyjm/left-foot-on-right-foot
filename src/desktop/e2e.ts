// R11 桌面 E2E 驱动（仅 LFRR_E2E=1 时激活）：
// 在真实 renderer 中经 window.lfrr（preload 桥）完成 创建→启动→阈值停止→
// 暂停/恢复/停止→全局停止/解除→记录/事件 全流程，并采集 preload-error /
// pageerror / 渲染层异常。结果以 LFRR_E2E_RESULT:{json} 输出到 stdout 供测试断言。
import type { BrowserWindow } from 'electron';

const E2E_SCRIPT = `
(async () => {
  const results = { steps: [], rendererErrors: [] };
  window.addEventListener('error', (event) => {
    results.rendererErrors.push(String(event.message || event.error));
  });
  const step = async (name, fn) => {
    try {
      const detail = await fn();
      results.steps.push({ name, ok: true, detail: detail === undefined ? null : detail });
    } catch (error) {
      results.steps.push({ name, ok: false, error: String((error && error.message) || error) });
    }
  };
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const poll = async (fn, timeoutMs = 20000) => {
    const started = Date.now();
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() - started > timeoutMs) throw new Error('poll timeout');
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  };
  const unique = 'e2e-' + Date.now().toString(36);

  await step('getState', async () => {
    const status = await window.lfrr.getState();
    expect(status && Array.isArray(status.projects), 'getState 必须返回项目数组');
    expect(typeof status.globalStop === 'boolean', '缺少 globalStop');
    expect(typeof status.foregroundModeEnabled === 'boolean', '缺少 foregroundModeEnabled');
    return status.mode;
  });

  await step('checkModel', async () => {
    const model = await window.lfrr.checkModel();
    expect(typeof model.reachable === 'boolean', '模型状态缺少 reachable');
    return model.reachable;
  });

  await step('listProducts', async () => {
    const products = await window.lfrr.listProducts();
    const simulated = products.find((p) => p.productId === 'simulated');
    expect(simulated, '模拟模式必须提供 simulated 产品');
    expect(simulated.integration === 'simulated', 'simulated 集成标记错误');
    return products.length;
  });

  await step('createProject', async () => {
    const result = await window.lfrr.createProject({
      config: {
        projectId: unique + '-main',
        name: 'E2E 主项目',
        workspacePath: 'C:\\\\e2e-not-real\\\\' + unique,
        goal: 'E2E 验证目标',
        prdRef: 'e2e@1',
        evaluator: { productId: 'simulated', sessionId: 'sim-eval-progress', label: null },
        executor: { productId: 'simulated', sessionId: 'sim-exec', label: null },
        stopThresholdPercent: 80,
      },
    });
    expect(result.ok === true, 'createProject 应成功: ' + JSON.stringify(result));
    return result.ok;
  });

  await step('createProject rejects invalid threshold without side effects', async () => {
    const before = (await window.lfrr.getState()).projects.length;
    const result = await window.lfrr.createProject({
      config: {
        projectId: unique + '-bad',
        name: 'bad', workspacePath: 'C:\\\\x\\\\' + unique, goal: 'g', prdRef: 'p',
        evaluator: { productId: 'simulated', sessionId: 'sim-eval-progress', label: null },
        executor: { productId: 'simulated', sessionId: 'sim-exec', label: null },
        stopThresholdPercent: 150,
      },
    });
    expect(result.ok === false, '越界阈值必须被拒绝');
    const after = (await window.lfrr.getState()).projects.length;
    expect(before === after, '被拒请求不得产生副作用');
    return result.code;
  });

  await step('startProject and reach threshold stop', async () => {
    const started = await window.lfrr.startProject(unique + '-main');
    expect(started.ok === true, 'startProject 应成功: ' + JSON.stringify(started));
    const project = await poll(async () => {
      const status = await window.lfrr.getState();
      return status.projects.find((p) => p.projectId === unique + '-main' && p.state === 'stopped_threshold');
    });
    expect(project.lastEvaluation && project.lastEvaluation.totalCompleteness === 80, '最终评估应为 80%');
    return { rounds: project.roundIndex, score: project.lastEvaluation.totalCompleteness };
  });

  await step('records contain full chain', async () => {
    const records = await window.lfrr.listRecords(unique + '-main', 100);
    const kinds = new Set(records.map((r) => r.kind));
    for (const expected of ['evaluation_request', 'evaluation_reply', 'prompt_dispatch', 'execution_result']) {
      expect(kinds.has(expected), '记录缺少 ' + expected);
    }
    return records.length;
  });

  await step('second project: pause -> resume -> stop', async () => {
    const created = await window.lfrr.createProject({
      config: {
        projectId: unique + '-flow',
        name: 'E2E 流程项目',
        workspacePath: 'C:\\\\e2e-not-real\\\\flow-' + unique,
        goal: 'E2E 验证目标2',
        prdRef: 'e2e@1',
        evaluator: { productId: 'simulated', sessionId: 'sim-eval-progress-b', label: null },
        executor: { productId: 'simulated', sessionId: 'sim-exec-b', label: null },
        stopThresholdPercent: 95,
      },
    });
    expect(created.ok === true, '第二个项目创建失败: ' + JSON.stringify(created));
    const started = await window.lfrr.startProject(unique + '-flow');
    expect(started.ok === true, '第二个项目启动失败: ' + JSON.stringify(started));
    await poll(async () => {
      const status = await window.lfrr.getState();
      return status.projects.find((p) => p.projectId === unique + '-flow' && p.state === 'running' && p.roundIndex >= 1);
    });
    const paused = await window.lfrr.pauseProject(unique + '-flow');
    expect(paused.ok === true, '暂停失败: ' + JSON.stringify(paused));
    const resumed = await window.lfrr.resumeProject(unique + '-flow');
    expect(resumed.ok === true, '恢复失败: ' + JSON.stringify(resumed));
    const stopped = await window.lfrr.stopProject(unique + '-flow');
    expect(stopped.ok === true, '停止失败: ' + JSON.stringify(stopped));
    const view = (await window.lfrr.getState()).projects.find((p) => p.projectId === unique + '-flow');
    expect(view.state === 'stopped_user', '停止后状态应为 stopped_user');
    return view.state;
  });

  await step('threshold change is recorded', async () => {
    const changed = await window.lfrr.setThreshold(unique + '-flow', 95);
    expect(changed.ok === true, '阈值修改失败: ' + JSON.stringify(changed));
    const events = await window.lfrr.listEvents(unique + '-flow', 50);
    expect(events.some((e) => e.type === 'threshold_changed'), '缺少阈值变更事件');
    return true;
  });

  await step('global stop blocks start; resumeAll lifts without auto-revive', async () => {
    const stopAll = await window.lfrr.stopAll();
    expect(stopAll.ok === true, 'stopAll 失败');
    const blocked = await window.lfrr.startProject(unique + '-flow');
    expect(blocked.ok === false && blocked.code === 'GLOBAL_STOPPED', '全局停止后启动必须被拒');
    const lifted = await window.lfrr.resumeAll();
    expect(lifted.ok === true, 'resumeAll 失败');
    const revived = await window.lfrr.startProject(unique + '-flow');
    expect(revived.ok === true, '解除后显式启动应可行: ' + JSON.stringify(revived));
    await window.lfrr.stopProject(unique + '-flow');
    return true;
  });

  await step('invalid command returns structured error', async () => {
    const result = await window.lfrr.setThreshold('no-such-project', 50);
    expect(result.ok === false && result.code === 'PROJECT_NOT_FOUND', '未知项目应返回 PROJECT_NOT_FOUND');
    return result.code;
  });

  await step('foreground mode toggle is visible and reversible', async () => {
    const enabled = await window.lfrr.setForegroundMode(true);
    expect(enabled.ok === true, '开启前台模式失败: ' + JSON.stringify(enabled));
    const statusOn = await window.lfrr.getState();
    expect(statusOn.foregroundModeEnabled === true, '开启后状态应显示前台模式已开启');
    const disabled = await window.lfrr.setForegroundMode(false);
    expect(disabled.ok === true, '撤销前台模式失败');
    const statusOff = await window.lfrr.getState();
    expect(statusOff.foregroundModeEnabled === false, '撤销后状态应显示前台模式已关闭');
    return true;
  });

  await step('unknown send: recovery gate, abandon, then resume works end-to-end', async () => {
    const injected = await window.lfrr.testInjectFault('send-unknown', 'sim-eval-progress');
    expect(injected.ok === true, '故障注入失败（仅模拟模式可用）: ' + JSON.stringify(injected));
    try {
      const created = await window.lfrr.createProject({
        config: {
          projectId: unique + '-fault',
          name: 'E2E 恢复核对项目',
          workspacePath: 'C:\\\\e2e-not-real\\\\fault-' + unique,
          goal: 'E2E 验证目标3',
          prdRef: 'e2e@1',
          evaluator: { productId: 'simulated', sessionId: 'sim-eval-progress', label: null },
          executor: { productId: 'simulated', sessionId: 'sim-exec', label: null },
          stopThresholdPercent: 80,
        },
      });
      expect(created.ok === true, '故障项目创建失败: ' + JSON.stringify(created));
      const started = await window.lfrr.startProject(unique + '-fault');
      expect(started.ok === true, '故障项目启动失败: ' + JSON.stringify(started));
      const paused = await poll(async () => {
        const status = await window.lfrr.getState();
        return status.projects.find((p) => p.projectId === unique + '-fault'
          && p.state === 'paused' && p.pauseReason === 'unknown_send');
      });
      expect(paused.state === 'paused', '评估请求回执未知必须暂停');
      const blocked = await window.lfrr.resumeProject(unique + '-fault');
      expect(blocked.ok === false && blocked.code === 'RECOVERY_PENDING', '未核对前恢复必须被阻断: ' + JSON.stringify(blocked));
      // 从记录里定位未决意图（evaluator 侧 unknown）。
      const records = await window.lfrr.listRecords(unique + '-fault', 100);
      const unknownIntent = records.find((r) => r.kind === 'prompt_dispatch'
        && r.meta && r.meta.target === 'evaluator' && r.meta.state === 'unknown');
      expect(unknownIntent, '应能从记录定位未决意图');
      const abandoned = await window.lfrr.abandonIntent(unique + '-fault', unknownIntent.meta.intentId);
      expect(abandoned.ok === true, '人工放弃失败: ' + JSON.stringify(abandoned));
      const cleared = await window.lfrr.testInjectFault('clear', 'sim-eval-progress');
      expect(cleared.ok === true, '清除注入失败');
      const resumed = await window.lfrr.resumeProject(unique + '-fault');
      expect(resumed.ok === true, '核对放弃后恢复应成功: ' + JSON.stringify(resumed));
      const stopped = await window.lfrr.stopProject(unique + '-fault');
      expect(stopped.ok === true, '停止失败');
      const view = (await window.lfrr.getState()).projects.find((p) => p.projectId === unique + '-fault');
      expect(view.state === 'stopped_user', '最终状态应为 stopped_user');
      return view.state;
    } finally {
      await window.lfrr.testInjectFault('clear', 'sim-eval-progress');
    }
  });

  return results;
})()
`;

export interface E2EOutcome {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; error?: string; detail?: unknown }>;
  preloadErrors: string[];
  pageErrors: string[];
}

/** 在窗口加载完成后执行 E2E；输出结果并退出应用。 */
export function runDesktopE2E(window: BrowserWindow): void {
  const preloadErrors: string[] = [];
  const pageErrors: string[] = [];
  window.webContents.on('preload-error', (_event, _path, error) => {
    preloadErrors.push(String(error));
  });
  // Electron 无 page-error：用 console-message（error 级）+ 脚本内 window.onerror 覆盖。
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) {
      pageErrors.push(message.slice(0, 300));
    }
  });
  window.webContents.once('did-finish-load', () => {
    void (async () => {
      let outcome: E2EOutcome;
      try {
        const results = (await window.webContents.executeJavaScript(E2E_SCRIPT, false)) as {
          steps: Array<{ name: string; ok: boolean; error?: string }>;
          rendererErrors: string[];
        };
        outcome = {
          ok: results.steps.every((step) => step.ok) && results.rendererErrors.length === 0 && preloadErrors.length === 0,
          steps: results.steps,
          preloadErrors,
          pageErrors: [...pageErrors, ...results.rendererErrors],
        };
      } catch (error) {
        outcome = {
          ok: false,
          steps: [{ name: 'executeJavaScript', ok: false, error: String(error) }],
          preloadErrors,
          pageErrors,
        };
      }
      process.stdout.write(`LFRR_E2E_RESULT:${JSON.stringify(outcome)}\n`);
      window.close();
    })();
  });
}
