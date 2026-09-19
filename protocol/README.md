# 三方协作协议草案 0.2

**迁移状态：此0.2契约供现有工具和静态测试使用，尚未适配 [PRD 1.5](../docs/PRD.md)。**
多项目身份/阈值、桌面队列和原生组件RPC尚未实现；原生JSON-RPC将独立版本化，不与AI消息VERSION混同。
新需求允许外部会话用普通语言给总完成度、缺项及提示词，由本地模型理解，内部结果再严格校验。
评估会话负责回归与评分，本地模型不独立重打分；用户阈值可配置，80%只是示例。
本草案未定义总完成度、配置阈值及达标停止的完整字段，不能把旧COMPLETED冒充此能力。
后续需明确版本迁移并同步Schema、示例、状态和测试；本轮不修改0.2字段或放宽其解析规则。

状态：静态规范、Schema 与样例；没有监督运行时或实际模型接入。
三方为独立 Planner、本地 Supervisor、Coding Agent。程序负责传输与强制约束，
模型承担监督判断，不能将固定状态转移当作模型判断的替代品。

## 消息与身份

每次传输恰好一个 UTF-8 JSON 对象。允许 JSON 空白；拒绝 BOM、注释、尾逗号、
重复键（含嵌套和转义键）、Markdown 围栏、前后自然语言、多对象和截断。
未知字段和版本拒绝，不自动提取或“修复”为可派发指令。

[message.schema.json](message.schema.json) 是结构权威。
[examples.json](examples.json) 是各分支的独立静态示例，不是应依次执行的数组；
示例没有真实执行证据，也不代表监督行为正确。

| 共享字段 | 含义 |
| --- | --- |
| VERSION | 仅接受 `0.2`，与软件版本独立 |
| TYPE | TASK / REPORT / DECISION |
| MESSAGE_ID | Session 内唯一稳定标识；重试不换 ID |
| SESSION_ID | 本地项目与三方绑定的会话 |
| IN_REPLY_TO | 当前审查或回复的消息 ID；仅初始 TASK 可为 null |
| STAGE | 人工批准阶段 |
| AGENT | 执行端实例标识，不是厂商白名单 |
| PLANNER | 独立规划端实例/会话绑定标识，不限于 ChatGPT |
| SUPERVISOR | 本地监督实例与配置绑定标识，不是授权身份声明 |

标识为 1–128 字符，ASCII 字母、数字、点、下划线、冒号、连字符。
Runtime 必须用真实连接来源和已绑定上下文核对这些字段。
消息自称来自本地监督者，不证明其来源；不得仅凭模型填写的身份选择端点。
路由与关联元数据由 Runtime/Connector 根据绑定上下文提供或核对，不由模型自由决定。
第三方原生事件可以无歧义地规范化为内部消息并保留来源；自然语言观察不能被猜测成可执行 TASK。
内部协议边界仍要求完整的合法对象。本次 PRD 更新不改变草案 0.2 字段或新增自动修复路径。

## TASK：规划提案

由 Planner 产生，初始任务可以由人类带入，但仍须本地监督审查。
除共享字段外，固定包含 ACTION、PROMPT、HUMAN_GATE、STOP_CONDITION、REASON、ERROR。
不适用字段为 null，不能省略。

| ACTION | PROMPT / STOP_CONDITION | HUMAN_GATE | REASON | ERROR |
| --- | --- | --- | --- | --- |
| CONTINUE | 非空文本 / 非空文本 | false | null | null |
| PAUSE | null / null | false | 非空文本 | null |
| HUMAN_GATE | null / null | true | 非空文本 | null |
| COMPLETED | null / null | false | 非空完成依据 | null |
| ERROR | null / null | false | 非空文本 | code + message |

CONTINUE 是候选任务，不能直接发送 Agent；COMPLETED 是完成提案，不是完成证据。
PAUSE、HUMAN_GATE、ERROR 直接停止推进，监督模型不能将它们降级为继续。
STOP_CONDITION 是可审阅描述，不可执行为代码，也不能取代限额和强制停止。

## REPORT：执行结果

由 Agent 回复实际已派发 TASK，不允许 null IN_REPLY_TO。包含：

- SUMMARY：真实摘要。
- CHANGES：相对路径和 added / modified / deleted；路径仅供展示，不直接用于文件操作。
- VALIDATION：command、PASS / FAIL / NOT_RUN、details；未执行不得记为 PASS。
- RISKS、BLOCKERS：文本数组；无内容用空数组。
- STOP_REASON：TASK_COMPLETED / HUMAN_GATE / PAUSED / ERROR / LIMIT_REACHED。
- ERROR：仅错误停止时为 code + message，其他情况为 null。

本地监督者判断报告内容及证据是否支持推进，不把 TASK_COMPLETED 当作成功证明。
门禁、暂停、限额和错误报告不能被监督模型改写为普通继续。
格式合法的普通报告可以带缺口说明转交 Planner，请其安排验证，而非凭空补全结果。

## DECISION：本地监督判断

DECISION 必须来自绑定的本地推理流程，IN_REPLY_TO 指向当前 REPORT 或候选 TASK。
它只提出下一步，不直接执行命令，也不替代人类授权。

| 字段 | 约束 |
| --- | --- |
| REVIEW | REPORT 或 PLAN，必须与被审查消息类型对应 |
| ACTION | 见下表 |
| REASON | 非空的结论与依据摘要，不要求模型隐藏思维链 |
| EVIDENCE | 非空、无重复的本地证据/消息 ID 数组；必须包含被审查消息 ID |
| REQUEST | 仅 REQUEST_REVISION 为非空修订请求，其余为 null |
| HUMAN_GATE | 仅 HUMAN_GATE 动作为 true，其余 false |
| ERROR | 仅 ERROR 动作为 code + message，其余 null |

| 审查对象 | 允许动作 | 含义 |
| --- | --- | --- |
| REPORT | FORWARD_REPORT | 将原始报告及监督结论交给 Planner；不等于确认任务成功 |
| PLAN | DISPATCH_TASK | 建议执行被审查的 CONTINUE TASK，不得改写其内容 |
| PLAN | REQUEST_REVISION | 把候选 TASK 和修订请求交回 Planner，不绕开规划端自行造新任务 |
| PLAN | COMPLETED | 建议接受 Planner 的 COMPLETED 提案，仍需验证验收及最终人工批准 |
| 两者 | PAUSE / HUMAN_GATE / ERROR | 暂停、请求人工决定或报告错误，不派发任务 |

结构校验不能证明引用存在、来源可信、上下文一致或判断正确。Runtime 另行检查：
REVIEW 与源类型对应；证据来自本 Session 且可解析；决定适用于当前未变更的源消息和配置；
DISPATCH_TASK 只针对 CONTINUE，COMPLETED 只针对 COMPLETED。
任何修改都重新产生 ID 并重新监督，不能把旧决定用于新内容。
Supervisor 无权修改审批策略、目标或 Stage，无权豁免规划端/Agent 已提出的门禁。

## 关联与派发

初始 TASK → 审查 PLAN 的 DECISION → 获准派发 TASK → Agent REPORT →
审查 REPORT 的 DECISION → Planner TASK → 审查 PLAN 的 DECISION。

Planner 在收到报告后产生的 TASK 回复该 REPORT；
收到 REQUEST_REVISION 后产生的新 TASK 回复该 DECISION。
发送给 Planner 的上下文包包含源消息和监督结论，工具层必须同时记录两者，
不能只发摘要而丢掉失败验证或风险。外发范围必须预先批准。
DECISION 总是回复源 TASK/REPORT，Agent REPORT 总是回复实际执行的 TASK。
重复监督拒绝与修订循环计入轮次、耗时和无进展预算。

| 情形 | 处理 |
| --- | --- |
| 同一 Session、消息 ID、相同已接收内容 | IGNORE_DUPLICATE，不派发、不推进 |
| 同一 Session、消息 ID、不同内容 | HUMAN_GATE |
| Agent / Planner / Supervisor / Stage / Session 错配 | ERROR |
| 回复不是当前期待消息，或证据引用无效 | ERROR |
| 发送回执未知 | HUMAN_GATE，禁止盲目重试 |
| 本地推理不可用或输出无效 | ERROR，禁止脚本或云监督自动兜底 |

相同内容按严格解析后的对象深相等判断；对象键顺序无意义，数组顺序有意义。
Schema 校验之外的守卫是未来 Core 职责；本轮只有静态契约，不声称实现了运行时保护。

## 授权与恢复

HUMAN_GATE:false、DISPATCH_TASK 和模型自报信心都不是权限凭证。
每次发送前检查三方上下文、源任务、监督决定、人工授权、限额与去重。
任务、目标、三方身份或模型配置变化使旧审批及相关决定失效。
高风险动作和重大决策必须人类确认；模型之间互相同意不算人工批准。

状态转移见 [工作流](../docs/workflow.md)。监督者不能凭推理认定在途动作已停止。
错误只保留本地脱敏诊断，不自动要求模型修 JSON 或猜测恢复；
确认静止、排除歧义并获得人类恢复授权后才重审。

## 从 0.1 迁移

这是实验期破坏性变更：VERSION 提升到 0.2，旧消息直接拒绝。
TASK/REPORT 增加 PLANNER、SUPERVISOR 绑定；新增 DECISION。
旧的“LLM 输出合法即可回填 Agent”流程被禁止，所有可派发任务必须有本地监督决定。
消费者需绑定三方上下文、建立真实来源与证据校验，并采用新状态机，不能仅改 VERSION。
当前没有已发布运行时或持久 Session，因此无需执行数据迁移，保留 Git 历史即可。
