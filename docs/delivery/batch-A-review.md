# 批次A验收与集中收口单

日期：2026-09-20。验收对象：当前未提交工作区及 [ZCODE批次A报告](batch-A.md)，基线提交 `06b5f6b`。
本次由架构会话审查，不代替ZCODE修改功能，不接真实会话、不运行真实模型、不安装SDK、不提交推送。

## 结论

**批次A暂不通过，继续功能收口A-R1，不进入批次B真实控制。**
已有实质源码、模拟服务链路和开发zip，不再是纯文档项目。但“可运行桌面功能版全部完成”的结论证据不足：
同配置的Electron隐藏窗口复现preload加载失败，IPC成功响应结构也与UI预期不一致。
停止、未知发送恢复、澄清阈值和打包边界有可复现缺陷；这些均能在本地修复，不需要用户先准备真实A/B。

确认的成果：TS编译、现有179项测试、UI构建与基础校验通过；开发zip存在，哈希与原报告一致。
不能确认的声明：桌面创建/启动/停止真实操作链已通过、原生源码完成可构建、前台队列已接入协调器、开发包不含本地资料。
以下P1均需在进入真实控制前关闭；P2在本批次一并收口。NOT_RUN不能当作PASS，但也不阻止无关功能开发。

## 已执行检查

- `npm run validate`：179 pass，UI类型检查和构建通过，本次基础扫描135个Git可见文件。文件数取本次现场值，不沿用原报告161/162。
- 独立隐藏Electron窗口：使用当前构建UI/preload、相同sandbox/contextIsolation/nodeIntegration设置。
  输出 `PRELOAD_ERROR Cannot use import statement outside a module`；`typeof window.lfrr` 为 `undefined`，页面正文为空。
  这是同配置隔离复现，不宣称已经点击原应用全部界面。
- preload执行逻辑用VM注入假ipcRenderer：main形状的成功应答返回 `{v,id,payload:{ok:true}}`，UI读取顶层ok为false。
- 模拟服务复现：unknown_send后resume返回ok，轮次从1变2，并再次发送评估请求；无需重启即可绕过未决状态。
- 可控假Adapter复现：阻塞verifyBinding，调用stopAll，再释放verifyBinding，sendPrompt仍调用1次。
- 可控澄清复现：先65%且缺提示词，澄清回复90%并带提示词，阈值80%，仍对B发送1次。
  Adapter声明需前台，该路径的foregroundQueue.submit调用次数为0。
- 本地HTTP服务先回响应头、350ms后回正文：客户端timeoutMs=50，约370ms后仍成功完成。
  构造外部域名端点被接受；该检查只构造客户端，没有向外部域名发请求。
- zip SHA-256：`02d6a6ed5dc9c1e01cc1f8f66f4e84fdc7944b564b5950ea039828998be13e80`。
  仅枚举其app.asar文件清单，发现包含`.local/`和`.mimosa/`；未读取其中私有记录正文。

隔离复现脚本位于本机已忽略的 `.local/delivery/audit-core.mjs`、`audit-ollama.mjs`、`audit-electron.cjs`。
用于本地交接，不把本地目录纳入公开提交或分发。ZCODE应将缺陷转为正式脱敏回归测试。

## R1：P1 桌面preload无法加载

位置：[main](../../src/desktop/main.ts) createWindow，[preload](../../src/desktop/preload.ts) 的ESM imports，tsconfig.app构建。
宿主启用sandbox，指向tsc产出的ESM preload.js，沙箱preload加载时报import语法错误，window.lfrr未建立。
窗口存在或SQLite生成都不能证明用户能使用界面。

收口：将preload独立构建为沙箱兼容的单文件CommonJS，有限依赖打包，保持sandbox与contextIsolation，
不要通过关闭安全设置消除报错。验收从真实renderer调用getState并创建、启动一个模拟项目。

## R2：P1 IPC成功结果被UI当失败

位置：[preload](../../src/desktop/preload.ts) sendCommand，[main](../../src/desktop/main.ts) lfrr:command，
[App](../../src/ui/App.tsx) command及 [NewProjectForm](../../src/ui/NewProjectForm.tsx)。
main返回ServiceEnvelope，preload直接强转成ServiceResult；UI读取result.ok，实际ok在payload内。
修好R1后仍会出现“操作失败”或表单不关闭，后台可能已经创建项目，用户重试又制造重复。

收口：在preload校验版本、关联ID和payload后解包，统一错误语义；main校验IPC发送来源及每种命令参数，
不能只检查kind白名单再强转TypeScript。真实UI成功/失败两条路径均测，非法参数不能写坏数据库。

## R3：P1 zip夹带本地记录

位置：[Forge配置](../../forge.config.cjs) packagerConfig。
prune只处理开发依赖，不排除仓库本地状态，.gitignore也不约束打包。已生成的zip确实包含.local和.mimosa。
这已违反“不打包本地记录”的边界，潜在敏感程度未检查，不能声称发现了具体密钥，也不能因此认为可以分发。

收口：使用可审查的产物白名单/构建暂存目录，只包含必要运行文件、生产依赖和明确原生组件。
排除本地记录、会话、环境文件、IDE/Agent状态、缓存、测试证据与工作副本；检查嵌套路径。
新增无秘密的canary排除测试，并枚举最终zip/asar验收；重打包、生成新哈希。旧包不分发，不擅自删除用户产物。

## R4：P1 停止信号不能阻止下一次发送

位置：[coordinator](../../src/core/coordinator.ts) runRound、sendWithTimeout、awaitReply、pauseProject/stopProject。
verifyBinding之后没有再次检查取消便sendPrompt；stopAll发生在绑定等待期间，仍会发送。
sendWithTimeout没有实际超时控制，awaitReply也未接收取消；模型队列任务没有绑定项目取消。
暂停后立即恢复可能在旧异步调用未结束时新开loop；旧loop仍可能修改新运行状态。

收口：引入run generation/取消令牌贯穿绑定、排队、发送前检查和读取；每个副作用边界重新核对授权/取消。
取消不等于外部已停止，不能把不明发送标为“未发出”，也不能提前释放未决工作区保护。
增加暂停/停止在每个await边界发生、立即恢复、迟到回执、失控超时和服务退出测试。
全局停止后的显式恢复目前永远返回GLOBAL_STOPPED，需设计可用但不自动复活的用户恢复动作及UI测试。

## R5：P1 未知发送可直接恢复绕过核对

位置：[coordinator](../../src/core/coordinator.ts) startProject、loadPersisted、runRound及 [records](../../src/storage/records.ts) 意图操作。
startProject只阻止pauseReason=recovery_pending，而当次unknown_send仍允许resume。现有测试只测重启后的阻断。
A评估与澄清发送没有持久化意图；B的confirmed只代表收到了任务，不代表任务已完成，重启仍需核对在途执行。

收口：所有启动/恢复依据持久化未决操作和外部任务状态判定，不依赖可被stop清空的UI原因字段。
A/B及澄清统一意图/回执/回复关联；模糊传输异常不得简单按“未发送失败”处理。
覆盖不重启恢复、停止再启动、已确认但仍执行中重启、A发送未知、人工核对后恢复等场景，未决不得重发。

## R6：P1 澄清路径跳过本地模型和最新评分

位置：[coordinator](../../src/core/coordinator.ts) 缺提示词分支，reExtract正则附近。
65%缺提示词后，直接从澄清回复抓取第一个「...」发送，不重新理解评分；即使澄清已到90%也继续执行。
同样无法可靠区分引用旧任务、取消或新的歧义，这不是PRD要求的本地模型协调。

收口：所有A完整新回复进入同一理解、来源关联和最新阈值检查路径；发送前再核对当前阈值/目标版本。
增加“澄清达标且附任务”“只补提示词”“澄清矛盾”“阈值在等待期间下调”的回归。

## R7：P1 前台队列没有接入协调路径

位置：[coordinator](../../src/core/coordinator.ts) foregroundQueue仅用于getStatus，发送和读取直接调用Adapter；
[queues](../../src/core/queues.ts)。
队列类自身有测试不代表系统互斥。声明foreground的Adapter仍然不经队列；缺少专用前台模式授权与撤销路径。

收口：能力驱动路由；需要前台的完整绑定/切换/读取或输入/确认过程进入统一队列，后台读取不占锁。
未开启模式、用户接管、焦点失配、队列超时和全局停止后禁止新前台动作；超时不自动继续不安全的剩余队列。
用两个假前台Adapter在真实Coordinator集成测试中验证互斥、取消和公平性，不要求操作用户应用。

## R8：P1 Ollama正文阶段无期限和可靠体积边界

位置：[client](../../src/ollama/client.ts) request/chat/listModels，[model-service](../../src/ollama/model-service.ts)。
fetch收到headers就清掉计时器和外层取消监听，后续response.text可能无限等且先全量载入再检查大小。
端点只限制http/https，并未限制本机；生产结果也未拒绝done=false、错误模型或截断生成。

收口：期限/取消覆盖headers及正文读取全过程，按字节流限制大小，错误响应也受限；已取消请求不发出。
明确本机端点边界，拒绝外部域名/凭据/非预期路径，不靠注释约束；核对模型身份、完成状态和可执行输出。
严格JSON拒绝重复键，避免模型结构字段被后一个重复属性覆盖。用假HTTP覆盖全部情况，不调用真实模型。

## R9：P1 上下文和多项目关联不完整

位置：[coordinator](../../src/core/coordinator.ts) lastResultExcerpt/result与awaitReply，
[simulated-adapter](../../src/adapters/simulated/simulated-adapter.ts)、[workspace-lock](../../src/core/workspace-lock.ts)。
B完整结果虽入库，下轮只回传前2000字符，后部失败/缺项会丢失；“完整回复见记录”实际记录也仅显示400字符。
多个项目可绑定同一A/B，模拟Adapter按sessionId共享游标和最后回复；没有项目/运行/请求级隔离。
读取仅以lastRef区分，不核对回复sessionId或对应发送；工作区只比较相等键，不阻止父子目录重叠。
roundTimeout是每轮限额，缺少总轮次/总时长上限，默认无进展限制关闭可一直循环。

收口：完整报告受控传递或明确分段/拒绝，不能静默截掉失败；保留目标/PRD版本和发送-回复关联。
不同项目禁止并发复用同一真实执行会话或提供明确互斥；模拟项目实例真正隔离，断言各项目收到自己的结果。
补父子/链接目录冲突与运行总预算、过期目标回执测试；0%阈值按PRD 0-100边界处理，不自行改为(0,100]。

## R10：P1 原生与产品适配仍缺可开发的实现

位置：[RpcDispatch](../../native/windows/LFRRHelper/RpcDispatch.cs)、[UiaOperations](../../native/windows/LFRRHelper/UiaOperations.cs)、
[pending-integration](../../src/adapters/pending-integration.ts) 及 [service](../../src/desktop/service.ts)。
源码静态可见C#匿名对象写了 `["sys.capabilities"] = ...` 的字典索引初始化语法，不能用于匿名对象；
UiaOperations使用JsonElement但没有System.Text.Json导入。SDK缺失意味着未编译，不意味着明显源码错误可以算完成。
定位不到sessionHint仍返回窗口，ReadText无依据声明complete=true；ClipboardRestore无竞争检查便EmptyClipboard。
Codex/ZCODE全方法拒绝属于诚实占位，不是“产品交互逻辑已完成”；helper启动、宿主接线和协调utility进程也缺失。

收口：修正明确源码问题，按FlaUI真实API核对类型与资源释放；无SDK继续标原生编译NOT_RUN，不臆造通过。
实现可注入平台传输的产品交互逻辑与受控控件fixture，未知布局显式失败；不凭标题绑定、不默认完整、不覆盖用户新剪贴板。
协调/数据库按批准架构隔离到utility进程，做阻塞/失联停止测试；生产模式不能仍注册可启动的模拟Adapter。
若启动实现确被工具安全门拦截，报告确切阻塞及影响，不反复换语法/目录规避安全门；继续其余模块，申请针对性处理。

## R11：P1 测试未证明UI可用，干净CI不能复现

位置：[electron-smoke](../../tests/electron-smoke.test.mjs)、[package.json](../../package.json)、
`.github/workflows/`中的Foundation validation。
冒烟只启动进程等待12秒再kill，退出0或null就算成功，忽略preload/renderer错误；未证明窗口交互或干净退出。
npm test不构建dist-ui却要求它存在；CI的npm ci --ignore-scripts不准备Electron，测试又写死electron.exe，Linux必不能照此运行。
因此本机179绿不等于新clone/双平台CI可复现，报告“CI同环境通过”不能成立。

收口：建立真正renderer端E2E，覆盖配置、启动、阈值、暂停、恢复、停止、记录与错误，监听preload-error/pageerror。
拆分无账号跨平台核心测试与平台桌面测试；构建顺序正确，明确原生依赖/Electron安装和ABI验证步骤。
使用无真实数据的干净工作副本/CI验证npm ci到验收完整链，不删除当前工作区产物来假装干净环境。

## 集中派发：A-R1功能收口，不回到前置调查

给ZCODE主会话：

```text
读取docs/delivery/batch-A-review.md及当前AGENTS.md，继续批次A-R1功能收口，不进入批次B。
当前179项测试通过是基线，不是验收通过；先将R1-R11转成能复现缺陷的正式回归，再修复功能。
不要求用户先提供真实A/B，不重复入场报告，不扩大到真实模型/聊天/控制操作。

你负责内部组织和集成：
方向一：桌面、preload/IPC、真正renderer E2E、打包排除与干净构建（R1/R2/R3/R11）。
方向二：核心取消/恢复/澄清/前台调度/上下文隔离及运行预算（R4-R7/R9）。
方向三：模型HTTP边界、原生源码和适配实现（R8/R10）。
仅在已许可且隔离可靠时并行；否则串行，不因缺worktree许可停工。
公共协议、依赖锁文件和utility装配由主会话维护，所有者之间通过明确接口协作。

修复→单测→真实本地桌面E2E→集成→开发包重建，一批完成再汇报。
本地桌面测试只控制本项目的隔离实例，不操作用户其他应用；不运行真实模型。
系统SDK安装未获准则对应编译保持NOT_RUN，不能用它为其他源码缺口开脱。
工具安全门阻塞不得绕过；Git不提交不推送，不删除用户工作/旧开发包。
最终更新batch-A报告并交docs/delivery/batch-A-R1.md：每条问题的修复、测试、残余限制，
可运行入口、新包哈希、最终zip内容排除检查。旧包标不应分发。
不得再用窗口存活或服务测试代替从renderer完成创建→启动→停止的证据。
完成本批次后由架构会话一次性回归，不逐小功能要求用户搬运或审计。
```

## 本次停止点

已完成批次级审查及隔离复现，保留ZCODE源码和既有用户修改，仅新增审查文档与gitignored本地诊断。
未改功能、未提交推送；main相对本地origin/main跟踪记录仍领先1次提交，本次未查询远端。
原生编译、真实模型、真实Codex/ZCODE接入、Windows干净安装和Mac实机仍未验证。
下一步是ZCODE完整收口A-R1，而非要求用户先做真实目标验证。
