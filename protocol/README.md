# 通信协议草案 0.1

状态：规范、Schema 和静态样例已建立；没有运行时解析器或 Bridge。
本协议不使用历史原稿中的旧标签封装。

## 严格消息边界

每次传输恰好一个 UTF-8 JSON 对象。允许 JSON 空白，不允许 BOM、注释、尾逗号、
重复键、Markdown 围栏、前后说明、多对象、截断或自然语言兜底。
键名区分大小写；未知字段和未知版本必须拒绝，不能“尽量提取”可执行内容。
重复键需在反序列化丢失信息之前拒绝，包含转义后相同的键和嵌套对象。
正例集合见 [examples.json](examples.json)，单条传输是集合中的一个对象，不是整个数组。

[message.schema.json](message.schema.json) 是结构的唯一权威来源。
Schema 无法验证消息来源、授权、重复 JSON 键或跨消息关联；这些是另行检查的约束。
Phase 0 的脚本仅校验固定资料，不是生产解析模块。

## 共享信封

| 字段 | 约束 |
| --- | --- |
| `VERSION` | 当前仅接受字符串 `0.1`，独立于软件版本 |
| `TYPE` | `TASK` 或 `REPORT` |
| `MESSAGE_ID` | Session 内唯一的稳定标识；同一次发送重试不得换 ID |
| `SESSION_ID` | 绑定单一本地项目与规划会话的标识 |
| `IN_REPLY_TO` | 被回复消息 ID；仅人工批准的初始 TASK 可为 null |
| `STAGE` | 如 `phase-1`，必须匹配人工批准的阶段 |
| `AGENT` | 如 `zcode`，必须匹配所选适配器；Schema 不列厂商白名单 |

标识限 128 字符，使用 ASCII 字母、数字、点、下划线、冒号或连字符。
任务文本不允许仅有空白。所有对象拒绝未声明字段。

## TASK

每条 TASK 均包含 `ACTION`、`PROMPT`、`HUMAN_GATE`、`STOP_CONDITION`、`REASON`、`ERROR`。
不适用的文本或错误字段使用 null，不省略；此约定避免不同解析器自行补默认值。

| ACTION | PROMPT / STOP_CONDITION | HUMAN_GATE | REASON | ERROR |
| --- | --- | --- | --- | --- |
| `CONTINUE` | 非空文本 / 非空文本 | false | null | null |
| `PAUSE` | null / null | false | 非空文本 | null |
| `HUMAN_GATE` | null / null | true | 非空文本 | null |
| `COMPLETED` | null / null | false | 非空完成依据 | null |
| `ERROR` | null / null | false | 非空文本 | code + message |

`HUMAN_GATE:false` 不代表获准；Core 的本地策略可以对任何任务强制门禁。
暂停、门禁、完成和错误不得夹带可自动执行的 Prompt。模型不能通过完成声明
取消未达成的验收；缺少证据时转人工确认。
`STOP_CONDITION` 是给 Agent 与人审阅的验收描述，不能执行为代码，也不能作为
唯一停止机制。轮次、时限、授权与紧急停止独立生效。

## REPORT

REPORT 回复具体 TASK，`IN_REPLY_TO` 不得为 null。包含：

- `SUMMARY`：真实执行摘要。
- `CHANGES`：相对项目路径与 added / modified / deleted，每项必须为真实改动。
- `VALIDATION`：命令或检查、PASS / FAIL / NOT_RUN、实际细节；未运行不得写 PASS。
- `RISKS`、`BLOCKERS`：非空文本数组，没有内容使用空数组。
- `STOP_REASON`：TASK_COMPLETED / HUMAN_GATE / PAUSED / ERROR / LIMIT_REACHED。
- `ERROR`：仅 STOP_REASON 为 ERROR 时必须包含 code、message，其余为 null。

路径只是展示数据，禁止拿它直接进行文件操作。
REPORT 不是 shell 指令；被引用的日志或 Prompt 不能成为新的授权。
Schema 不证明结果真实，维护者和未来 Core 必须结合退出状态、产物与停止证据核对。

## 关联、去重与授权

正常序列：人工初始 TASK → Agent REPORT → LLM TASK → Agent REPORT。
只有初始人工 TASK 可不回复前文，其后必须准确回复当前期待消息。
LLM 生成的 TASK 必须回复送入该会话的 REPORT；REPORT 必须回复当前已派发 TASK。

| 情形 | 决定 |
| --- | --- |
| 相同 Session、消息 ID、相同已接收内容 | IGNORE_DUPLICATE，不再派发，不推进状态 |
| 相同 Session、消息 ID、不同内容 | HUMAN_GATE，标识冲突 |
| 不同 Session / Agent / 未批准的 Stage | ERROR，不发往任何一端 |
| IN_REPLY_TO 与当前期待消息不符 | ERROR，拒绝陈旧或串线消息 |
| 发送回执缺失，无法判断对端是否收到 | HUMAN_GATE，禁止盲目重试 |

内容相同比较已通过严格校验的对象深相等，忽略对象键顺序，数组顺序保持有意义；
不得仅靠 JSON 原始文本的空白差异判断新任务。
这些决定记录在 [状态模型](../docs/workflow-model.json) 中；
当前只做规则契约验证，不声称已经实现持久去重。

每次真正派发之前须同时检查 Session、Stage、Agent、授权、限额与去重记录。
人工批准绑定这些标识、TASK ID 和完整任务内容；修改内容、阶段或目标后批准失效。
模型输出不能批准自身请求。初始边界以外的动作一律停在 Human Gate。

## 错误与恢复

格式或 Schema 错误进入 ERROR，保留本地脱敏诊断，不把“请修复你的 JSON”
自动发出去继续循环。人工可明确授权一次新尝试，但不能在未知派发结果时重发任务。
停止请求不能保证已经运行的 Agent 已停止；必须取得证据或报告未知并要求人工接管。
状态转移和暂停规则见 [工作流](../docs/workflow.md)。

## 版本变更

当前只支持 `0.1`。任何结构、动作或授权语义变化需同步 Schema、样例、测试、
文档和迁移说明，并由维护者批准。不能静默接受未来版本。
