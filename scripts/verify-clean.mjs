// R11 干净副本验证：把全部 Git 可见文件（含未提交源码）复制到忽略目录下的
// 干净副本，在新副本执行 npm ci --ignore-scripts + npm test，
// 证明"干净 clone 可复现"而非依赖当前工作区的构建残留。
// 用法：node scripts/verify-clean.mjs
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectFiles } from './repository.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const copyDir = join(root, '.local', 'clean-verify', `run-${Date.now()}`);

function removeQuietly(target) {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Windows 句柄释放延迟：清理失败不阻塞验证（旧目录留待下次或手动清理）。
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 失败（exit=${result.status}）`);
  }
}

if (existsSync(join(root, '.local', 'clean-verify'))) {
  // 清理旧运行目录（旧布局或上次运行残留）。
  removeQuietly(join(root, '.local', 'clean-verify'));
}
mkdirSync(copyDir, { recursive: true });

const files = projectFiles();
for (const file of files) {
  const target = join(copyDir, file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, file), target);
}
console.log(`复制 ${files.length} 个 Git 可见文件到 ${copyDir}`);

// 副本内初始化最小 git 索引（不提交、不推送）：部分基础测试依赖 git ls-files 枚举。
run('git', ['init', '-q'], copyDir);
run('git', ['add', '-A'], copyDir);

run('npm', ['ci', '--ignore-scripts'], copyDir);
run('npm', ['run', 'build:eval'], copyDir);
run('npm', ['run', 'build:app'], copyDir);
run('npm', ['test'], copyDir);
console.log('干净副本验证通过：npm ci + 构建 + 全部核心测试可复现（桌面 E2E 另需 Electron 二进制，见 test:desktop）。');
