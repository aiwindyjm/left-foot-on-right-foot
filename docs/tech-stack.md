# 技术栈选型

修订：3.0；日期：2026-09-18；依据 [PRD 1.5](PRD.md) 与已批准的桌面版/跨平台控制方案。
当前仅落实文档基线及接入清单，不安装组件、不读真实聊天、不控制应用、不恢复旧模型考试。
选型不代表实现或兼容验证；接入与交付门槛见 [桌面接入验收](desktop-integration.md)。

## 1. 总体决定

**Electron + Electron Forge + React/TypeScript/Vite + TypeScript协调核心 + Ollama/Qwen3 + SQLite，
配Windows C#/.NET10/FlaUI.UIA3与macOS Swift/Accessibility原生辅助组件。**

正式入口为桌面应用，CLI仅保留开发调试。先Windows可安装内测版，再Apple Silicon Mac实机适配；
多个项目后台等待可并行，每项目启用一评估一执行，全机共享前台操作队列。
A回归PRD并给评分/提示词，B执行，本地模型理解并交接，程序比较用户配置阈值，不再审计项目。
旧2.0中单项目、CLI产品入口、永不占前台的约束已被本轮明确决定替代，历史见 [需求追踪](requirements.md)。

## 2. 完整技术清单

| 部分 | 选择 | 作用与实施状态 |
| --- | --- | --- |
| 平台顺序 | Windows 11 x64，随后Apple Silicon macOS | Mac系统版本待实机登记，不承诺Intel Mac或Windows ARM |
| 开发环境 | Node.js24/npm11/TypeScript5.9.3，ESM | 现有基础工具使用；不等于Electron实际Node版本 |
| 桌面宿主/打包 | Electron + Electron Forge | 窗口、托盘、通知、全局停止入口和安装包；未安装 |
| UI | React + TypeScript + Vite | 多项目列表、会话选择、每项目阈值、进度、队列及权限；未实现 |
| 共享协调 | 轻量TS状态/事件循环 | 不依赖Electron UI，复用到契约测试和调试CLI；待实现 |
| 本地模型服务 | Ollama原生/api/chat | 独立于桌面进程，获准本机端点；旧调查0.34.0，未验证新协调职责 |
| 初始模型 | Qwen3 8B Q4_K_M | 复用已有权重起步；Windows/Mac分别测资源、质量与延迟，不自动换模型 |
| Windows原生层 | C#/.NET10 + FlaUI.UIA3 | 调用UIA3控件树、Text/Value/Invoke及事件；SDK/产品适配未就绪 |
| Mac原生层 | Swift + AXUIElement/AXObserver | 控件属性、动作和变化通知；辅助功能权限按需申请，未实测 |
| 原生通信 | 版本化JSON-RPC，子进程stdin/stdout | 有限方法白名单，无公开控制端口；不与AI消息版本混用 |
| 系统输入兜底 | Windows SendInput / Mac CGEvent | 只在获准前台模式、已核对控件下使用，不绕过系统权限 |
| 剪贴板 | 平台剪贴板API | 临时粘贴，保存/恢复支持的格式，用户修改后不覆盖；不后台扫描内容 |
| 业务记录 | SQLite + better-sqlite3 | 目标/阈值/绑定、消息、派发意图/回执和停止原因；未安装 |
| 诊断 | Pino，脱敏JSONL | 元数据与错误，不打印真实对话；未安装 |
| 校验 | JSON Schema2020-12/Ajv8.20.0/jsonc-parser3.3.1 | 现有校验可复用，新协议/RPC需单独定义，不自动修复非法消息 |
| 网络与取消 | fetch/AbortController | 模型和获准官方接口；限制地址、重定向、响应体与期限 |
| 浏览器后续路线 | 按需扩展 + Native Messaging | 仅指定站点/会话；不属首批成品 |
| 专用浏览器 | Playwright/DOM，必要时合法CDP | 条件能力，不能接管默认日常资料目录或偷读Cookie |
| 测试 | node:test、假Adapter、原生平台测试、桌面E2E | 默认CI无账号/真实会话；安装包及Mac需分别验收 |

新依赖在相应获准实施阶段锁定精确版本；先检查Electron支持的OS/Node、Forge/Vite组合及原生依赖，
不能依据版本号猜兼容。本轮不修改package.json或锁文件，不为文档搭空壳应用。
既有better-sqlite3 13.0.3、Pino10.3.1为此前核对的初始依赖基线，Electron兼容测试可能要求另行记录版本调整。
.NET10采用受支持补丁；FlaUI、Swift/Xcode及目标Mac系统版本随实测环境冻结。

## 3. Electron与其他路线的取舍

采用Electron是因用户优先可靠跑通，可复用现有TS/Node生态；接受桌面壳体积与基础内存开销。
Tauri使用系统WebView、壳通常较轻，但保留现有Node核心还需sidecar；两者都必须另做系统控制。
不同时实现两种桌面宿主。React只渲染控制台，不复制一个新的规划聊天产品。
普通网页加本地服务也能组织控制，但仍需本地安装和权限，并未省掉系统层。

桌面进程建议为本地renderer + 最小preload + main，以及独立协调utility进程与平台helper。
模型推理位于Ollama，可能阻塞的UIA/AX调用位于helper，数据库只由协调进程写入；
不让原生调用卡住停止按钮。以随父进程退出的辅助进程隔离故障，不建微服务或后台自启守护。

renderer启用contextIsolation、sandbox、nodeIntegration=false，只加载本地打包UI；
限制导航、新窗口、IPC来源/参数和CSP，Vite开发服务不进入生产包。
IPC只暴露项目配置、状态、已授权操作和停止，不透传任意shell、文件路径或系统函数。
外部会话文本不能变成renderer可执行内容或原生RPC方法。

## 4. 两个平台如何控制应用

### Windows

FlaUI.UIA3封装Windows UI Automation；先读结构化控件与状态，优先Text/Value/Invoke等模式，
不要求本地模型盯全屏截图。控件和事件可用性取决于应用provider，虚拟化聊天区域可能只有可见片段。
不以控件树存在证明完整回复可读，不以Invoke成功证明消息已发送。

UIA在独立原生组件的合适线程模型中调用，阻塞/超时可终止组件，主程序仍能停止队列。
SendInput只在控件定位和授权均成立时用，受UIPI和前台焦点约束；
不默认提权，不操作UAC安全桌面，不以uiAccess配置绕过权限边界。
本轮再次执行dotnet --list-sdks未列出SDK；存在dotnet命令不代表可编译，安装SDK须另行安排。

### macOS

Swift直接封装AXUIElement属性/动作、AXObserver事件；通过辅助功能权限检查和系统设置引导授权。
用户拒绝或撤销权限即显式失败，不循环弹授权，也不把之前通过当永久许可。
控件句柄在应用重启/界面刷新后可能过期，重新核对项目和会话后再使用。
前台输入兜底采用CGEvent；相关权限以实际OS为准，必要时解释并请求，不自动扩大权限。

首版不申请屏幕录制，不用截图OCR作为备用成功路径。
将来视觉路线为Mac ScreenCaptureKit与Windows.Graphics.Capture，捕获授权与控制授权分别处理；
若需全局输入监听也须单独评审，不默认采集用户键盘内容。
Apple Silicon统一内存与Windows独显不同，本地模型资源和并发不能照抄显存阈值。

## 5. 产品会话与系统能力分离

项目与协调层只理解工作区、A/B、目标、阈值和授权。
产品层Codex/ZCODE分别处理项目导航、会话身份、消息布局、生成结束和发送确认。
系统层只处理平台控件、聚焦、输入、剪贴板与权限，不知道PRD评分含义。
能力契约报告后台可用/需要前台/不支持/权限不足，不提供假等价实现。

首批分别验证Codex内双会话与ZCODE内双会话，而非要求任意两个产品立刻互通。
官方接口能准确操作已有会话时优先使用；控件路径是独立可验证路线，不虚构跨客户端共享安全。

- Codex app-server文档有thread/read、thread/resume、turn/start等能力；仍须检查指定桌面会话可见性、
  多客户端竞争、审批传递、结果回显与唯一派发者。不得扫描全部历史或为验证而直接启动turn。
- ZCODE Hooks提供session_id/cwd与Stop结果线索，不等于完整异步发送接口；
  新配置未必作用于已有会话，不能为此擅自创建替代会话或修改用户配置。
- 宿主Codex App提供给当前助手的工具不是独立开源程序已经可用的公共控制API。
- 不读取应用私有数据库、逆向内部控制协议、拷贝Cookie，无法准确绑定则报告不支持。

日常浏览器若后续接入，用用户授权的站点扩展与Native Messaging，本地主机注册和来源限制均需审查。
Chrome默认用户目录远程调试限制使“Playwright直接接管现有浏览器”不能成为前提。
Playwright保留给允许的专用环境，不静默用API新会话替换原聊天。

## 6. RPC、调度与数据

原生helper用子进程stdio的JSON-RPC2.0消息形态、UTF-8逐行封装，协议版本握手独立管理。
stdout仅协议消息，stderr仅脱敏诊断；请求关联ID、大小/期限上限、取消与结构校验必需。
未知方法、过期绑定或跨项目操作拒绝；版本不兼容不执行。正式Schema在后续实现中与测试一起引入。
模型只返回理解结果，不填写任意系统操作参数，helper不能成为任意执行代理。

每项目一条轻量循环，本地推理请求串行；多个项目可以同时等待外部执行。
全机前台队列持有“切换/身份复核/输入/发送/确认”全过程；需要切换的观察也入队，不能后台偷切会话。
发送后确认接收即让出前台，不等待整个模型生成；公平排队、每次操作有截止时间。
未知回执暂停对应项目且不重发；焦点不明或全局接管关闭前台派发，不能直接切去下一项目继续输入。

真实工作区身份解析目录链接/别名，不能只按字符串比较；路径大小写按平台文件系统处理。
相同真实目录共享执行互斥；有在途未知操作时锁不能因超时或重启就消失。
重叠工作区若不能证明写入隔离，默认拒绝并发；多项目不意味着同项目多Agent并行写文件。
应用单实例及helper生命周期管理保证多个进程不能各拿一把“全局锁”。

SQLite保持短事务、参数化SQL、迁移版本、foreign_keys和WAL；意图先持久化，回执后记录。
不在事务内等待外部操作，不宣称跨应用exactly-once；崩溃/重启默认暂停核对。
Electron应用数据目录保存状态/日志，使用app.getPath('userData')下受控目录，不向目标项目写私有状态。
已有开发评估.local/保留，不自动扫描导入；诊断日志轮转有上限，证据清理须用户批准。
剪贴板原文只短暂驻留内存、不日志化，不能恢复的格式先提示/暂停；用户修改后不覆盖恢复。

## 7. 模型与阈值仍然简单

模型从A本轮完整回复识别总体百分比及提示词引用，含糊时请求A澄清，不生成新的项目评分。
程序核对引用/来源并取原提示词发送，防止模型复述改写；子任务进度/历史高分不能替代当前总分。
每项目阈值独立，80%只是示例；达到即不发附带任务，不为凑测试轮数继续。
修改目标、会话或阈值废弃旧决定；已停止后调高阈值不自动复活。

保留Ollama原生结构化输出、Ajv复核、明确调用期限及本机目标限制。
Qwen3 8B既有配置只是起点，按真实脱敏会话验证提取与交接；模型训练、视觉与更大权重不是当前前提。
CPU/GPU混合配置由用户选择并实测，不自动关闭应用或云端兜底。

## 8. 构建、安装与验证

工程继续用Node24、npm锁文件、strict TS和node:test。Electron内置Node版本/ABI另行锁定，
better-sqlite3须按Electron目标架构用Forge重建流程或@electron/rebuild验证。
npm ci --ignore-scripts不能证明原生模块可用；在隔离构建环境审查安装脚本/预构建来源后定向构建，
对实际打包应用做数据库读写/事务/重启测试，不能只测系统Node。

Forge打包平台helper；Windows组件按目标架构自包含发布，使内测用户无需SDK；
Mac组件在Mac工具链构建，随应用签名/权限身份处理，不能只编译通过就认定TCC权限可用。
helper崩溃、缺失、版本错配、路径含空格/中文及父进程退出均需验证。
Mac公开分发需相应签名公证；Windows公开签名及证书费用也单独批准，不绕过Gatekeeper/系统安全提示。
首批可安装内测包不等于公开Release，不实现自动更新，不打包Ollama权重或用户浏览器profile。

首批原生与闭环测试见 [桌面接入验收](desktop-integration.md)，构建流程见 [开发说明](development.md)。
基础CI继续无账号运行；未来增加Windows原生/Electron构建与Mac ARM实机构建验收，
Linux基础测试不等于Linux桌面支持，托管Mac编译也不等于Apple Silicon交互实测。

## 9. 取舍与当前状态

保留TS核心、Ollama、SQLite、严格校验、轻量状态循环，不引入LangChain/LangGraph/XState。
新增桌面宿主和两个小型原生helper是因系统能力需要，不是把整个业务重写成C#/Swift。
先验证接入，再构建桌面最小闭环和多项目内测包，再适配Mac。
浏览器扩展成品、自动更新、截图/OCR、任意应用控制、同项目多执行者不属于首批。

本轮只完成规范与验收清单。真实会话未选定/未测试，SDK未准备，Mac系统版本未记录；
具体运行/控制权限、组件安装及签名费用尚需相应确认，不将现有109项测试当新产品验收。

## 10. 资料依据

以下来源已在方案调研中读取；是接口依据，不是本项目实测结果。
- [Electron进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)、[安全](https://www.electronjs.org/docs/latest/tutorial/security)、[原生模块ABI](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)。
- [Tauri架构](https://v2.tauri.app/concept/architecture/)、[sidecar](https://v2.tauri.app/develop/sidecar/)：替代路线的成本依据。
- [Windows UIA模式](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controlpatternsoverview)、[线程要求](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)、[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)。
- [FlaUI](https://github.com/FlaUI/FlaUI)、[.NET支持周期](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)。
- [Apple AXUIElement](https://developer.apple.com/documentation/applicationservices/axuielement)、[辅助功能权限](https://support.apple.com/guide/mac-help/allow-accessibility-apps-to-access-your-mac-mh43185/mac)。
- [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)、[Windows捕获](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture)：仅后续研究方向。
- [Chrome远程调试限制](https://developer.chrome.com/blog/remote-debugging-port)、[Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)。
- [Codex app-server](https://developers.openai.com/codex/app-server/)、[ZCODE Hooks](https://zcode.z.ai/cn/docs/hooks)、[历史接入报告](phase-1a-report.md)。
