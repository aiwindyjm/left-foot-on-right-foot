// 会话绑定互斥（R9）：不同项目禁止并发复用同一产品会话（评估或执行），
// 避免消息游标、发送与读取互相干扰。同一项目重复获取返回成功（幂等）。
export class SessionRegistry {
  private readonly holders = new Map<string, string>();

  private static key(productId: string, sessionId: string): string {
    return `${productId}::${sessionId}`;
  }

  /** 尝试占用；成功返回 null，失败返回当前持有项目。 */
  tryAcquire(productId: string, sessionId: string, projectId: string): string | null {
    const key = SessionRegistry.key(productId, sessionId);
    const holder = this.holders.get(key);
    if (holder !== undefined) {
      return holder === projectId ? null : holder;
    }
    this.holders.set(key, projectId);
    return null;
  }

  release(productId: string, sessionId: string, projectId: string): void {
    const key = SessionRegistry.key(productId, sessionId);
    if (this.holders.get(key) === projectId) {
      this.holders.delete(key);
    }
  }

  holderOf(productId: string, sessionId: string): string | null {
    return this.holders.get(SessionRegistry.key(productId, sessionId)) ?? null;
  }
}
