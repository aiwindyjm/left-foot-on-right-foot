# 批次A-R1 集中功能收口报告

日期：2026-09-20。范围：[评审单](batch-A-review.md) R1-R11 全部条目；先回归转正，再修复，
最后重建开发包。基线仍为 `06b5f6b`（未提交，用户文档修改保留）；本批未提交未推送。
桌面 E2E、打包与验证均在本机隔离实例完成，未操作任何用户其他应用，未调用真实模型。

## 结论

**R1-R11 全部收口**：11 条评审问题均有对应正式回归测试与修复；renderer 端 E2E
从真实 preload 桥完成 创建→启动→阈值停止→暂停/恢复/停止→全局停止/解除→记录/事件
全流程，零 preload/渲染层错误；新开发包已构建并通过内容排除验收。
**后续增量收口（同日）**：R10 的宿主 utilityProcess 接线已完成（安全门解除后落码，
期间修复 utility 进程自退与并发命令排队两个缺陷）；前台队列由"占位单元"升级为
真实 Adapter 临界区（绑定核对+发送+回执/读取整体持锁，两项目并发实测最大并发 1）。
打包版实测：utility 进程保持运行、服务就绪、窗口正常。
NOT_RUN 维持两项：C# helper 编译（无 SDK）、真实 Codex/ZCODE 接入（批次B）。

## 1. 逐条修复与测试证据

| 评审条目 | 修复 | 正式回归（命令 `node --test <文件>`，全部 pass） |
| --- | --- | --- |
| R1 preload ESM 加载失败 | preload 经 esbuild 打包为单文件 CommonJS（`npm run build:bundles` → `dist/desktop/preload.cjs`），保持 sandbox+contextIsolation；tsc 构建排除该入口 | `tests/e2e/desktop.test.mjs`：preloadErrors === []，`window.lfrr` 全流程可用 |
| R2 IPC 成功结果被当失败 | preload 解包应答信封（校验协议版本、关联 ID、payload 形状）后才交给 UI；main 对每种命令做参数校验（不只 kind 白名单） | E2E 步骤 `invalid command returns structured error`、`createProject rejects invalid threshold without side effects`（非法参数 ok:false 且无副作用） |
| R3 zip 夹带本地记录 | forge.config 改为**白名单 ignore**（仅 package.json/dist/dist-ui/node_modules）；新增 `scripts/verify-package.mjs`：canary（.local/package-canary.txt）+ asar 枚举断言排除 .local/.mimosa/docs/tests/src 等、断言必要运行文件存在 | 打包后执行 verify-package → `OK：816 个条目；本地记录与仓库内容已排除` |
| R4 停止信号不阻止下一次发送 | 运行代数(gen)贯穿全部 await 边界；dispatch 内 绑定核对→gen核对→建意图→前台门→发送；发送统一超时包装（超时=unknown，不标未发出）；飞行中按真实回执落库；stopAll 期间绑定期即中止 | `tests/ar1-core.test.mjs` R4 四用例：绑定挂起期间 stopAll 零发送；飞行 confirmed 如实落库；挂起超时→unknown_send 且只发一次；暂停期间飞行结束→恢复必须先人工放弃 |
| R5 恢复可绕过核对 | 启动/恢复一律依据持久化意图与消息判定（不依赖 UI 原因字段）；A/B/澄清全部先落意图；executor confirmed 未回收 → 必须人工放弃；A 侧 unknown/pending 同样阻断；**分级**：仅"evaluator confirmed 在途"（评估请求无执行副作用）恢复时作废旧请求放行并记录事件 | AR1 R5 两用例 + 重启场景（core-cycle）：confirmed-but-uncollected 阻断重启、abandon(confirmed) 放行；A 侧 unknown 阻断恢复 |
| R6 澄清跳过模型与最新评分 | 重写 runRound 为统一理解循环：A 每条完整新回复（含澄清后）都走 模型理解→评估落库→**最新阈值**判定；缺提示词澄清后回环同一路径；逐字引用守卫全程适用 | AR1 R6 三用例：澄清 90%≥80 即停且零派发（并记录 suppressed prompt）；澄清回复改写被 verbatim 守卫拒绝；等待期间下调阈值按新值停 |
| R7 前台队列未接入 | 能力驱动路由：sendPrompt/readReply 声明 foreground 的操作进入统一 ForegroundQueue；新增专用前台模式开关（协议/服务/UI 显式开启/撤销）；未开启→foreground_required 暂停零发送；全局停止禁止前台提交 | AR1 R7 三用例 + 前台 Adapter 集成验证互斥/取消 |
| R8 模型正文无期限/体积边界 | 客户端重写：计时器覆盖 headers+正文全程；正文流式读取按字节上限（错误响应同样受限）；端点强制本机+拒绝凭据；done=false/模型身份不符拒绝；模型输出与响应均严格 JSON（拒绝重复键，`src/shared/strict-json.ts`，jsonc-parser 移入 dependencies）；已取消请求不发出 | `tests/ollama-hardening.test.mjs` 10 用例全过（慢正文超时/20MB 中止/外域拒绝/凭据拒绝/done=false/身份不符/重复键/取消不发/错误体受限） |
| R9 上下文与多项目关联 | B 结果**全文**回传 A（不再截 2000）；回复核对 sessionId；sendPrompt/readReply 增加 ownerId（模拟层按项目隔离游标与回复）；会话绑定互斥（同 productId+sessionId 同期仅一项目）；工作区父子重叠拒绝；新增 maxRounds/totalBudgetMs 预算；记录摘录上限提升到 2000 | AR1 R9 五用例：尾部标记全文到达 A；maxRounds 到限暂停；父子目录冲突；同会话互斥（含停止释放后可复用）；未知发送未决期间工作区保护保留 |
| R10 原生/适配缺口 | C#：RpcDispatch 带点键改字典序列化；UiaOperations 补 using；sessionHint 锚点缺失即定位失败（不凭标题绑定）；TextPattern 保守 complete=false；剪贴板恢复前竞争检查（用户已修改→拒绝覆盖）。TS：新增产品交互逻辑层 `src/adapters/product-runtime/session-runtime.ts`（可注入 PlatformTransport；锚点绑定/片段拒绝/回显核对 unknown/剪贴板竞争），受控 fixture 全覆盖；协调服务进程隔离：entry bundle + 注入式 ServiceProcessManager | `tests/product-runtime.test.mjs` 6 用例、`tests/service-process.test.mjs` 3 用例（fork entry：init→建→启→达标停；kill 失联→在途请求立即 SERVICE_LOST；未初始化拒绝） |
| R11 E2E 与干净复现 | 旧 12 秒冒烟删除；新增 renderer 驱动 E2E（`tests/e2e/desktop.test.mjs`，LFRR_E2E=1，采集 preload-error/console-error，断言 11 个步骤）；测试分层：`npm test`（无 Electron 依赖、跨平台）、`npm run test:desktop`（win32+产物）；CI 增 windows desktop-e2e job；`scripts/verify-clean.mjs` 干净副本 npm ci→构建→全测 | E2E pass（1/1）；干净副本 212 pass/3 skip/0 fail（197 文件复制+git 索引） |

`npm run validate` 最终：**215 pass / 0 fail**，197 个 Git 可见文件（链接/秘密/空白）通过。

## 2. 可运行入口与交付物

- 源码启动：`npm install && npm start`（模拟模式；`node scripts/fetch-electron.mjs` 补二进制——本机 npm 沙箱不执行 postinstall）。
- 测试：`npm test`（核心，无 Electron）；`npm run test:desktop`（renderer E2E）；`npm run validate`（全链路）。
- 打包：`npm run package:win`；验收：`npm run verify:package`；分发：`npm run dist:win`。
- 新开发包：`out/make/zip/win32/x64/left-foot-on-right-foot-win32-x64-0.0.0.zip`
  SHA-256：`579e9cf46a699e8c5e389ddbe7390466646fae12bc0e0a58d1321b6b3f2460ed`（163MB，
  含 utility 进程接线修复；此前 b653be3e… 为接线前版本，同样应被本包取代）。
  **旧包（02d6a6ed…，评审单所记哈希）含本地记录，不应分发**。
  新包验收：`node scripts/verify-package.mjs` 通过（白名单条目、本地记录排除、canary 在位）；
  打包版实测：utility 进程 booted ok 且保持运行、SQLite 生成、窗口标题正常、干净退出。
- 新增 UI 能力：前台模式开关（顶栏）、解除全局停止按钮、恢复核对框（放弃在途意图）、
  阈值修改入口、暂停原因中文说明（含新增 round_limit/time_limit/foreground_required）。

## 3. 恢复与停止语义（收口后的最终行为）

| 场景 | 行为 |
| --- | --- |
| 发送超时（适配器未返回回执） | 意图=unknown；项目暂停 unknown_send；不重发；恢复必须人工放弃 |
| 停止发生在发送开始前 | 意图=aborted（确认未发出），无需核对 |
| 停止发生在发送飞行中 | 按真实回执落库（confirmed/unknown/failed），不猜测"未发出" |
| executor 已确认但结果未回收（含重启） | 恢复阻断 RECOVERY_PENDING；人工"放弃等待"后可恢复；工作区保护保留至未决清空 |
| evaluator 已确认未回复（用户暂停/恢复） | 放行：作废旧评估请求（记录 stale_evaluator_request_discarded）并重新发起 |
| evaluator/其他 unknown（含重启） | 阻断恢复，人工核对 |
| 全局停止 | 关闭一切新派发/前台；显式 resumeAll 解除（不自动复活项目） |
| 前台模式未开启 | 需前台的操作零执行；项目暂停 foreground_required；开启后可恢复 |

## 4. 残余限制与阻塞

### 4.1 NOT_RUN（不因本批改变）

1. C# helper 编译 NOT_RUN（无 .NET SDK，未获准安装）；源码已按 R10 修正明显错误，
   真实 UIA/剪贴板/前台行为未接触任何用户应用。
2. 真实 Codex/ZCODE 接入 NOT_RUN（批次B/W1）；两个 Adapter 继续诚实拒绝。

### 4.2 utility 进程隔离（后续增量收口中已完成）

初版收口时该接线被 Mimosa PreToolUse 安全门拦截（spawn/execFile/utilityProcess.fork 三形态），
报告为阻塞并申请放行；**安全门解除后接线已完成**：main 以 `utilityProcess.fork` 启动
`dist/desktop/service-entry.cjs`，全部查询与命令经 `ServiceProcessManager`（请求关联、
超时、失联 fail-fast），退出时发送 shutdown。接线过程中修复两个复现缺陷：

1. **utility 进程启动后自退（exit 0）**：entry 在 Electron 场景监听 Node `process.on('disconnect')`，
   而 utilityProcess 不使用 Node ipc 通道、disconnect 立即触发 → init 成功后 0.6 秒自我关闭。
   修复：仅 node child_process 场景（`typeof process.send === 'function'`）监听 disconnect。
2. **并发命令被拒（SERVICE_BUSY）**：entry 原以"单命令+拒绝并发"实现串行，renderer 的
   并发查询/操作大量误失败。修复：改为串行**排队**（不拒绝），超时保护由宿主请求期限承担。

验证：renderer E2E 全流程经 utility 进程通过；打包版冒烟 bootLog 显示
fork→init ok→booted ok 且进程保持运行、SQLite 生成、窗口标题正常；
`tests/service-process.test.mjs`（node fork 场景）3 项继续通过。

### 4.3 其他说明

- preload 状态推送仍为 400ms 快照轮询（同批次A说明，功能等价）。
- 打包偶发失败：electron-packager 重命名 exe 时被杀软实时扫描短暂锁定（UNKNOWN error），
  重试即成功；`npm run package:win` 失败后直接重跑即可。
- 评审文档引用的 `tests/electron-smoke.test.mjs` 已被 E2E 取代，原路径留注释占位
  （说明新位置），保持评审链接与链接检查有效。

## 5. 现场记录（最终包）

- 最终包：`out/make/zip/win32/x64/left-foot-on-right-foot-win32-x64-0.0.0.zip`，
  SHA-256 `b653be3eade41be98db9023485ba2166ba2d20df8e93f6dfcb8f1fa4b70d6a94`，163MB；
  解压目录同步在 `out/left-foot-on-right-foot-win32-x64/`。
- 打包命令链：`npm run build` → `node .local/delivery/build-pkg.mjs`（@electron/packager API，
  输出 ASCII 临时目录，白名单与 forge.config 一致）→ Compress-Archive 生成 zip →
  `node scripts/verify-package.mjs <asar>` 验收。
- **收口过程中发现并修复的额外缺陷**（评审未列）：运行时依赖 `ajv` 原在 devDependencies，
  prune 后打包应用主进程模块加载即失败（窗口"Error"、进程秒退）；已移入 dependencies
  并以打包版冒烟验证。此缺陷在批次A的 12 秒冒烟下不可见（当时未校验服务数据与窗口内容），
  印证评审 R11"退出码≠可用"的判断。
- 打包间歇性失败记录：electron-packager 写入 `lfrr-desktop.exe` 时偶发 UNKNOWN（杀软
  实时扫描锁定），重试或经 packager API 到 ASCII 输出路径可稳定成功；诊断脚本
  `.local/delivery/build-pkg.mjs`（gitignored）留作本地交接，不进入公开提交。

## 6. 测试清单汇总（全部 pass）

- `npm test`：216 项（基础 109 + 批次A 70 + A-R1 36 + 前台真实临界区并发测试 1）；
  A-R1 期间另有服务进程/交互逻辑/加固套件见 §1 表格。
- `npm run test:desktop`：renderer 全流程 E2E 1 项。
- `npm run validate`：测试 + UI typecheck + Vite 构建 + 197 文件静态检查。
- `node scripts/verify-clean.mjs`：干净副本 npm ci → 构建 → 全测（212 pass/3 skip）。
- `node scripts/verify-package.mjs`：产物内容白名单验收（含 canary）。
