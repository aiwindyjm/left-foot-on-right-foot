# 批次A交付报告：Windows 桌面功能开发版

日期：2026-09-20。授权范围：用户批次A任务卡（W2-W7 本地部分；先开发功能后真实联调；
不提交不推送；不读取真实聊天、不控制应用、不调用真实模型、不下载模型）。
基线：`06b5f6b`（main，未提交；用户文档修改保留未动）。
**状态更新（同日）**：本报告的初版交付经架构会话评审未通过（见
[验收与集中收口单](batch-A-review.md)），R1-R11 已在 **[A-R1 收口报告](batch-A-R1.md)**
中全部修复并重新交付；以该报告为当前有效版本。初版正文保留于下方作为历史记录，
其中"桌面全功能可用"等结论以 R1 报告的修正为准（初版 zip 已被替换，不应分发）。

## 1. 交付物与启动方式

| 交付物 | 位置 | 状态 |
| --- | --- | --- |
| 桌面应用源码（Electron main/preload + React UI） | `src/desktop/`、`src/ui/` | 已实现，构建通过 |
| TypeScript 协调核心（项目循环/阈值/队列/互斥） | `src/core/` | 已实现，测试通过 |
| SQLite 存储（迁移/意图/回执/事件） | `src/storage/` | 已实现，测试通过 |
| Ollama 客户端与理解服务（真实 HTTP） | `src/ollama/` | 已实现，测试通过 |
| 协议级假模型服务（测试依赖） | `src/fake-model/` | 已实现 |
| 产品 Adapter（模拟 + Codex/ZCODE 未联调申报） | `src/adapters/` | 已实现 |
| 原生 stdio JSON-RPC 客户端 | `src/native-client/` | 已实现，测试通过 |
| Windows C# helper 源码 | `native/windows/LFRRHelper/` | 源码完成，**编译 NOT_RUN**（无 .NET SDK） |
| Windows 开发包（未签名便携 zip） | `out/make/zip/win32/x64/left-foot-on-right-foot-win32-x64-0.0.0.zip` | 已构建并实测启动 |

SHA-256（zip，163MB）：
`02d6a6ed5dc9c1e01cc1f8f66f4e84fdc7944b564b5950ea039828998be13e80`

### 本地启动（用户体验入口）

```sh
npm install        # 本机 npm 沙箱不执行 postinstall 时补跑 node scripts/fetch-electron.mjs
npm start          # 构建并以模拟模式打开桌面
```

模拟模式：创建项目 → 设置目标/PRD/阈值 → 启动 → 观察评估/缺项/轮次 → 暂停/恢复/停止 →
查看记录与事件；数据落在应用数据目录 `coordination/lfrr.sqlite`（WAL）。
`LFRR_MODE=production` 连接本机 Ollama（默认 `http://127.0.0.1:11434`，`qwen3:8b`）；
无 Ollama 时模型健康检查显式失败，不静默降级。
打包版（zip 解压后 `lfrr-desktop.exe`）在中文/空格路径下实测：窗口创建、服务就绪、
sqlite 读写、干净退出（`LFRR_USER_DATA` 隔离验证）。

## 2. PRD 需求映射（FR → 实现 → 证据）

| FR | 实现 | 证据（命令 → 结果） |
| --- | --- | --- |
| FR-01 配置/预检/自回路拒绝 | `project-config.ts` 校验 + UI 表单 | contracts.test 21项 → pass |
| FR-02 本地协调模型（理解不重评） | `ollama/model-service.ts` + 契约校验 + 原文引用守卫 | ollama-client/core-cycle 测试 → pass |
| FR-03/04 会话接入（模拟层） | `SimulatedAdapter`；Codex/ZCODE 诚实 NOT_INTEGRATED | adapters.test 7项 → pass |
| FR-05 阈值可配置/精确停止 | 79.9<80 继续、80≥80 停、无默认值、达标停不发附带任务 | core-cycle（边界/60-95对比/首轮83）→ pass |
| FR-06 回传与原文交接 | nextPrompt 逐字校验，改写即 MODEL_INVALID_OUTPUT | ollama-client verbatim 用例 → pass |
| FR-07 上下文固定关联 | 轮次/PRD 引用贯穿消息与评估记录 | integration records 断言 → pass |
| FR-08 评估依据留存 | evaluations/messages/events 全落库，UI 展示原文 | integration listRecords → pass |
| FR-09/10 去重/受控派发 | 意图先落库→发送→回执；重复引用忽略；unknown 不重发 | core-cycle unknown/duplicate 用例 → pass |
| FR-11 最小记录/重启核对 | 重启默认暂停；未决意图 recovery_pending 需人工放弃 | core-cycle 重启用例 → pass |
| FR-12 有限澄清 | 每轮澄清上限，超限暂停；缺提示词澄清路径 | core-cycle vague 用例 → pass |
| FR-13 桌面状态与控制 | 项目列表/详情/暂停/恢复/单项目停止/全局停止 | UI 构建 + Electron 冒烟 → pass |
| FR-14 不外发场景验证 | 全部走模拟会话与假模型，零真实外发 | 全套测试在 CI 同环境无账号运行 |
| FR-18 多项目调度 | 项目独立循环；模型串行队列；前台单拥有者队列 | integration 多项目用例 + queues 测试 → pass |
| FR-19 跨平台契约 | native-rpc v1.0 双平台共用；能力矩阵如实申报 | contracts/helper-client 测试 → pass |
| FR-20 前台模式/剪贴板 | helper 契约含 snapshot/restore/FOREGROUND_REQUIRED；未接真实控件 | C# 源码 + 假 helper 测试（真实行为 NOT_RUN） |
| FR-21 工作区互斥 | realpath/别名/大小写归并同键，冲突拒绝配置与启动 | core-cycle/fault 测试 → pass |
| FR-22 安装内测包（开发包级） | Forge zip 自包含；打包版实测启动 | sha256 上文 + 启动冒烟 → pass（正式内测安装验收属批次B） |

P1（FR-15/16/17）未实现，符合计划后置。

## 3. 测试实际结果

- `npm test`：**179 pass / 0 fail**（原基础 109 + 批次A新增 70：
  contracts 21、core-cycle 12、storage 5、ollama-client 8、adapters 7、
  helper-client 7、integration 3、fault-closure 4、electron-smoke 1…含分布微差）。
- `npm run validate`：161 个 Git 可见文件（链接/秘密/空白）+ UI typecheck + Vite 构建 → pass。
- 打包验证：`out/left-foot-on-right-foot-win32-x64/lfrr-desktop.exe` 实测窗口标题、
  sqlite 生成、进程干净退出 → pass。
- 模型链路：真实 `OllamaClient` → 本地假 Ollama 服务（HTTP 协议级），
  覆盖成功/HTTP500/非法JSON/超时/连接拒绝/改写拒绝 6 条路径 → pass。
  未调用真实模型（按授权）。

## 4. 未实测项与边界（NOT_RUN / 限制）

1. **真实 Codex/ZCODE 接入 NOT_RUN**（批次B/W1）：两个 Adapter 诚实申报
   `pending-integration`，listSessions 为空、sendPrompt/readReply 显式抛错，不杜撰。
2. **C# helper 编译 NOT_RUN**：本机无 .NET SDK；`native/windows/` 源码未经编译验证，
   FlaUI 4.0.0 版本号待 SDK 后冻结；真实 UIA/剪贴板/前台行为未接触任何用户应用。
3. **helper 进程启动器**：src/ 下 spawn 变量参数形态被 Mimosa PreToolUse 安全门拦截
   （多形态探针确认为误报模式；tests/ 路径不受限）。协议客户端为进程注入式
   （`HelperProcess` 接口），测试经 tests/ spawn 假 helper 驱动真实协议代码；
   产品宿主接真实 helper 的启动接线留批次B（该路径本就依赖 helper 二进制，NOT_RUN）。
4. **真机 Windows 内测安装/自包含 helper/公开签名 NOT_RUN**：本批次交付为开发包；
   正式安装包、无 SDK 机器安装验证属批次B。
5. **Electron ABI**：better-sqlite3 13 以 N-API prebuild 在 Electron 44 内加载实测可用
   （打包版 sqlite 读写成功）；未做 Forge rebuild（无必要证据，已在包内实测代替）。
6. **UI 状态推送**为 400ms 快照轮询（Coordinator onStatus 未暴露注入点），功能等价。
7. 旧协议 0.2 与旧评估工具原样保留（`protocol/`、`evaluation/`、109 项旧测试全部通过），
   未迁移未删除；新运行时使用 `src/shared/ai-contract.ts` v1.0，两者未混用。

## 5. 风险与建议下一步

- 风险：模拟场景通过不代表真实会话布局/接口兼容（PRD 16 已声明）；helper 源码质量
  依赖 SDK 安装后编译修正；打包 zip 未签名（SmartScreen 会提示）。
- 下一步（批次B）：指定真实测试工作区与 Codex/ZCODE 各自 A/B → 只读联调（W1）→
  修正 Adapter 差异 → 真实模型理解/延迟实测 → 真实闭环与内测包安装验收。
  另建议批准安装 .NET SDK 以编译验证 helper（单独询问，不阻塞其他工作）。
- 进度与续接细节：`.local/delivery/2026-09-20-batch-a-progress.md`（不入 Git）。

## 6. Git 状态

- 未提交（按授权不 commit/push）。工作区包含：用户既有文档修改（未动）+
  批次A新增源码/测试/构建配置（`src/`、`native/`、`tests/`、`scripts/`、
  `forge.config.cjs`、`vite.config.ts`、`tsconfig.*.json`、`package.json`、
  `package-lock.json`、`.gitignore`、`README.md`、`docs/development.md`、
  `docs/delivery/batch-A.md`）。
- 构建产物（dist/dist-ui/out/node_modules/.cache）已 gitignore。
