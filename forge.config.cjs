// Electron Forge 打包配置（R3 收口：产物白名单）。
// prune 只处理开发依赖，不排除仓库本地状态——因此使用显式 ignore 白名单：
// 只允许 package.json、dist（主进程/服务构建）、dist-ui（renderer 构建）、
// node_modules（生产依赖）。本地记录（.local）、Agent 状态（.mimosa/.zcode）、
// 测试、文档、原生源码、Git 元数据等一律不进入产物（评审 R3）。
// 可重复验收：scripts/verify-package.mjs 枚举 app.asar 断言排除项与必要项。
module.exports = {
  packagerConfig: {
    name: 'left-foot-on-right-foot',
    executableName: 'lfrr-desktop',
    asar: true,
    // 原生模块必须解包到真实文件系统才能被加载。
    asarUnpack: ['node_modules/better-sqlite3/**'],
    prune: true,
    overwrite: true,
    ignore: (filePath) => {
      // filePath 以 '/' 前缀开头（electron-packager 规范化路径）。
      if (filePath === '' || filePath === '/') return false;
      const normalized = filePath.replace(/^\//, '').replace(/\\/g, '/').replace(/\/$/, '');
      if (normalized === 'package.json') return false;
      if (normalized === 'dist' || normalized.startsWith('dist/')) return false;
      if (normalized === 'dist-ui' || normalized.startsWith('dist-ui/')) return false;
      if (normalized === 'node_modules' || normalized.startsWith('node_modules/')) return false;
      return true;
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
    },
  ],
};
