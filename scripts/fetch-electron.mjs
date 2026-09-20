// 开发环境辅助：调用 electron 包官方安装模块下载运行时二进制。
// 原因：本机 npm 的 allow-scripts 沙箱不执行 postinstall，dist/ 不会生成。
// 用法：ELECTRON_MIRROR 可覆盖，默认 npmmirror 镜像（本机无 GitHub 直连）。
process.env.ELECTRON_MIRROR ??= 'https://npmmirror.com/mirrors/electron/';
const { pathToFileURL } = await import('node:url');
const { resolve } = await import('node:path');
const installUrl = pathToFileURL(resolve('node_modules/electron/install.js')).href;
await import(installUrl);
console.log(`electron binary ready (mirror: ${process.env.ELECTRON_MIRROR})`);
