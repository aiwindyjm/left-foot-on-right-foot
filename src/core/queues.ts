// 本地推理队列：全机共享、串行、每请求有期限（PRD 7.5、架构"并发与前台模式"）。
// 一个项目的模型调用失败只暂停该项目，队列继续服务其他项目。
export interface QueueTask<T> {
  label: string;
  run: (signal: AbortSignal) => Promise<T>;
  timeoutMs: number;
}

export interface QueueOutcome<T> {
  ok: boolean;
  value?: T;
  error?: Error;
}

export class SerialQueue {
  private pending: Array<{ task: QueueTask<unknown>; resolve: (outcome: QueueOutcome<unknown>) => void }> = [];
  private busy = false;

  constructor(private readonly onError?: (label: string, error: Error) => void) {}

  get queued(): number {
    return this.pending.length;
  }

  get running(): boolean {
    return this.busy;
  }

  submit<T>(task: QueueTask<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        task: task as QueueTask<unknown>,
        resolve: (outcome) => {
          if (outcome.ok) {
            resolve(outcome.value as T);
          } else {
            reject(outcome.error ?? new Error('queue task failed'));
          }
        },
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift();
        if (!next) break;
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new Error(`queue timeout after ${next.task.timeoutMs}ms`)),
          next.task.timeoutMs,
        );
        try {
          const value = await next.task.run(controller.signal);
          next.resolve({ ok: true, value });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.onError?.(next.task.label, err);
          next.resolve({ ok: false, error: err });
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

/**
 * 前台操作队列：同一桌面仅一个拥有者。完整单元（切换→核对→输入→发送→确认）
 * 作为一项入队，期间持有、完成即释放，不等待整段模型生成。
 * 单元必须自带期限并在超时时让 run() 自行 settle；
 * 若单元超时仍未 settle，队列进入 stalled（拒绝新提交，保持单拥有者语义），
 * 待失控单元结束后自动恢复——绝不悄悄让第二个单元并行持有前台。
 */
export interface ForegroundUnit<T> {
  owner: string;
  label: string;
  timeoutMs: number;
  run: () => Promise<T>;
}

export class ForegroundQueue {
  private activeOwner: string | null = null;
  private activeLabel: string | null = null;
  private stalled = false;
  private readonly pending: Array<{
    unit: ForegroundUnit<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];

  get active(): { owner: string | null; label: string | null; queued: number; stalled: boolean } {
    return { owner: this.activeOwner, label: this.activeLabel, queued: this.pending.length, stalled: this.stalled };
  }

  submit<T>(unit: ForegroundUnit<T>): Promise<T> {
    if (this.stalled) {
      return Promise.reject(new Error('foreground queue stalled by overrun unit; refusing new submissions'));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        unit: unit as ForegroundUnit<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.activeOwner !== null) return;
    while (this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) break;
      this.activeOwner = next.unit.owner;
      this.activeLabel = next.unit.label;
      let overrun = false;
      const guard = setTimeout(() => {
        // 期限到而单元未结束：拒绝该单元、置 stalled，等它自然 settle 后恢复队列。
        overrun = true;
        this.stalled = true;
        next.reject(new Error(`foreground unit timeout: ${next.unit.label}`));
      }, next.unit.timeoutMs);
      try {
        const value = await next.unit.run();
        if (!overrun) next.resolve(value);
      } catch (error) {
        if (!overrun) next.reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        clearTimeout(guard);
        this.activeOwner = null;
        this.activeLabel = null;
        if (overrun) {
          this.stalled = false;
        }
      }
    }
  }
}
