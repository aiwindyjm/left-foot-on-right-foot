// 工作区互斥（FR-21）：真实路径归并别名/链接/大小写（win32 不敏感），
// 相同真实目录的多个项目不能并发执行；重叠在途未知状态保持阻断。
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export interface ResolvedWorkspace {
  /** 归并后的互斥键。 */
  workspaceKey: string;
  /** 归一化显示路径。 */
  normalizedPath: string;
  /** 目录当前是否存在（模拟项目可用不存在的路径，但互斥语义不变）。 */
  exists: boolean;
}

/**
 * 解析真实工作区身份：绝对化 → 尽力 realpath（不存在或链接失败退回词法归一）。
 * win32 下大小写不敏感（按文件系统语义归一小写）。
 */
export function resolveWorkspace(workspacePath: string): ResolvedWorkspace {
  const absolute = isAbsolute(workspacePath)
    ? workspacePath
    : resolve(process.cwd(), workspacePath);
  let normalized = absolute;
  let exists = true;
  try {
    lstatSync(absolute);
  } catch {
    exists = false;
  }
  try {
    normalized = realpathSync(absolute);
  } catch {
    // 目录不存在（或权限失败）：使用词法归一化，保持确定的互斥键。
    normalized = resolve(absolute);
  }
  const normalizedPath = normalizeSeparators(normalized);
  const caseKey = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
  return { workspaceKey: `ws:${caseKey}`, normalizedPath, exists };
}

function normalizeSeparators(path: string): string {
  return path.split(/[\\/]+/).join(sep);
}

/** 进程内工作区锁注册表：持有者 projectId，重复获取（含别名归并后同键）即冲突。 */
export class WorkspaceRegistry {
  private readonly holders = new Map<string, string>();

  /** 尝试占用；成功返回 null，失败返回当前持有者 projectId。 */
  tryAcquire(workspaceKey: string, projectId: string): string | null {
    const holder = this.holders.get(workspaceKey);
    if (holder !== undefined) {
      return holder === projectId ? null : holder;
    }
    this.holders.set(workspaceKey, projectId);
    return null;
  }

  release(workspaceKey: string, projectId: string): void {
    if (this.holders.get(workspaceKey) === projectId) {
      this.holders.delete(workspaceKey);
    }
  }

  holderOf(workspaceKey: string): string | null {
    return this.holders.get(workspaceKey) ?? null;
  }

  get size(): number {
    return this.holders.size;
  }
}
