// R3 验收：枚举打包产物（app.asar），断言本地记录/仓库内容被排除、必要运行文件在内。
// canary 机制：.local/package-canary.txt（无秘密，仅标记）若存在则必须被排除——
// 证明 .local 整体未进入产物。用法：node scripts/verify-package.mjs [asar路径]
import { listPackage } from '@electron/asar';
import { existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const asarPath = process.argv[2]
  ?? (() => {
    const outRoot = join(process.cwd(), 'out');
    const appDir = readdirSync(outRoot).find((name) => name.endsWith('-win32-x64'));
    if (!appDir) throw new Error('out/ 下未找到打包目录；先运行 npm run package:win');
    return join(outRoot, appDir, 'resources', 'app.asar');
  })();

if (!existsSync(asarPath)) {
  throw new Error(`app.asar 不存在：${asarPath}`);
}

// canary：确保 .local 有可检测标记（内容固定无秘密）。
const canaryPath = join(process.cwd(), '.local', 'package-canary.txt');
if (existsSync(canaryPath)) {
  const content = readFileSync(canaryPath, 'utf8');
  if (!content.includes('package-canary')) {
    throw new Error('.local/package-canary.txt 内容异常（应仅含固定标记文本）');
  }
} else {
  writeFileSync(canaryPath, 'package-canary: 打包排除验证标记（无秘密）。\n');
}

const entries = listPackage(asarPath).map((entry) => entry.replace(/\\/g, '/'));
const errors = [];

// 必须排除（本地状态、仓库内容、测试与工作副本）。
const forbiddenPrefixes = [
  '/.local', '/.mimosa', '/.zcode', '/.claude', '/.git',
  '/docs', '/tests', '/src', '/native', '/scripts', '/tools', '/evaluation',
  '/protocol', '/coverage', '/tmp', '/temp',
];
const forbiddenFiles = [
  '/forge.config.cjs', '/vite.config.ts', '/tsconfig.app.json', '/tsconfig.ui.json',
  '/tsconfig.evaluation.json', '/.gitignore', '/.env', '/package-lock.json',
];
for (const prefix of forbiddenPrefixes) {
  if (entries.some((entry) => entry === prefix || entry.startsWith(`${prefix}/`))) {
    errors.push(`产物包含被排除目录：${prefix}`);
  }
}
for (const file of forbiddenFiles) {
  if (entries.includes(file)) {
    errors.push(`产物包含被排除文件：${file}`);
  }
}

// 必须包含（运行必需）。
const required = [
  '/package.json',
  '/dist/desktop/main.js',
  '/dist/desktop/preload.cjs',
  '/dist/desktop/service.js',
  '/dist-ui/index.html',
];
for (const file of required) {
  if (!entries.includes(file)) {
    errors.push(`产物缺少必要文件：${file}`);
  }
}
const hasSqlite = entries.some((entry) => entry.includes('better-sqlite3'));
if (!hasSqlite) {
  errors.push('产物缺少 better-sqlite3（生产依赖）');
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`verify-package OK：${entries.length} 个条目；本地记录与仓库内容已排除，必要运行文件齐全（${asarPath}）`);
