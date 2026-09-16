# 架构设计

状态：已批准的 Phase 0 设计，不代表运行时已经实现。

## 目标与非目标

把执行报告送到规划 AI，把下一项已授权任务送回 Coding Agent。
人类负责目标、产品方向、风险判断和最终批准；系统只搬运、观察、验证和调度。
第一版是一台开发者电脑上的单项目、单 Agent、单规划会话闭环。
不做新的 Coding Agent、多 Agent 平台、Dashboard、云账号系统或无人监管的执行器。

## 模块边界

```text
Human: goal / scoped approval / emergency stop
                       |
                 bridge-cli (future)
                       |
              core: workflow + policy
                /                \
       AgentAdapter           LlmAdapter
          ZCODE              ChatGPT Web
                \                /
                 protocol contracts
```

未来采用轻量 npm workspaces Monorepo。现在只建立 `docs/`、`protocol/`、`tests/`、
`scripts/` 和 `.github/`；没有代码的运行时目录不占位。

| 未来位置 | 责任 | 禁止承担的责任 |
| --- | --- | --- |
| `apps/bridge-cli` | 人工启动、配置选择、状态展示、批准与停止入口 | 厂商 DOM 与业务决策 |
| `packages/core` | 状态机、消息关联、限额、授权、派发与 Session 生命周期 | 直接引用具体厂商 Adapter |
| `packages/protocol` | 从当前协议形成运行时校验与类型 | I/O、模型调用、任务执行 |
| `packages/adapters` | Agent / LLM 接口及各厂商实现，按 `agents/`、`llm/` 分类 | 自行批准任务或推进阶段 |

应用装配依赖，Core 依赖抽象契约；适配器由标识和能力注册，不在 Core 堆积
`if zcode` 分支。TypeScript 类型未来由 Schema 推导或通过契约测试保持同步。
浏览器交互先封装在 ChatGPT Web Adapter 内部，出现真实复用后再提取，
不提前创建 `browser/`。工作流与 Human Gate 属于 Core，不另拆空包。
协议源文件始终在根 `protocol/`，未来包消费它而不复制另一套定义。

## 接口草案

以下是行为约定，不是已实现的公共 API。统一结果包含成功值或明确的
`UNSUPPORTED`、`TIMEOUT`、`AUTH_REQUIRED`、`DISCONNECTED`、
`AMBIGUOUS_DELIVERY`、`INVALID_OUTPUT` 错误；不得用空字符串假装成功。

| 接口 | 输入与输出约定 |
| --- | --- |
| Agent `capabilities()` | 返回可用读取、派发、继续、停止能力与使用的传输方式 |
| Agent `detectState(context)` | 返回 running / report-ready / needs-input / permission-required / failed / unknown 及证据 |
| Agent `captureOutput(context)` | 返回当前任务完整报告、来源消息 ID、完成证据；不是屏幕上最后一段文字 |
| Agent `sendTask(context, task)` | 发送已授权任务，返回可核对回执；超时不代表没发出去 |
| Agent `continue(context)` | 仅当传输需要独立继续动作，且同一任务获准时使用，不能重复提交 Prompt |
| Agent `stop(context)` | 返回 confirmed / unsupported / unknown；不能把“发出停止请求”描述为“已停止” |
| LLM `capabilities()` | 返回传输、状态观察、读取及取消能力 |
| LLM `submitReport(context, report)` | 返回会话、用户消息标识和发送回执 |
| LLM `detectState(context)` | 返回 generating / done / auth-required / failed / unknown 及证据 |
| LLM `readResponse(context)` | 只返回当前提交对应的完整响应及来源消息 ID |

`context` 至少绑定本地项目、Session、Stage、Agent、LLM 会话、当前消息及截止时间；
不能因当前前台窗口变化而改目标。不支持必需能力时拒绝启动；停止能力不可靠时
必须明确说明人工停止路径，并禁止宣称可无人监管运行。

## 数据流与状态

人工批准初始任务和边界 → Core 校验 → Agent 执行 → 状态证据 → REPORT →
LLM 完整响应 → TASK 校验 → 本地授权策略 → 下一任务或停止。
详见 [协议](../protocol/README.md)和[状态机](workflow.md)。

Schema 只验证消息结构；Session、身份、任务关联、去重、阶段边界与授权由 Core 检查。
模型不得自行切换 Stage 或 Agent；变更需人工重新绑定上下文。
先记录派发意图再发送；无法确定是否已发送时停止核对，不追求虚假的 exactly-once 保证。

## 技术决策

- Node.js 24、TypeScript、npm；Phase 0 工具为小型 ESM JavaScript，不引入空 TS 编译工程。
- 使用 JSON Schema 2020-12；基础测试为 Node test runner，Ajv 负责 Schema。
- 静态 JSON 格式检查复用 jsonc-parser，Markdown 链接复用 remark AST，不自写通用解析器。
- 运行时状态机库在 Phase 1 接口侦察后单独评估，当前不实现调度引擎。
- API / CLI / Event 优先于 DOM / CDP，其次 Windows UI Automation、Clipboard、OCR、坐标。
- ZCODE 状态接口、ChatGPT Web 的可用传输及使用约束尚未验证；Phase 1 先做侦察，不承诺可接入。
- 实验只能在对应阶段获准后放 `experiments/<topic>/`，注明问题、方法、脱敏数据和结论；
  不得将实验当作生产实现，也不提前创建空目录。

## 安全与可靠性

报告可能带有 Prompt 注入，网页可能含有不可信指令。任何外部文字都不能升级权限。
初次启动默认人工门禁；只允许在明确授权的范围、轮次和时限内自动继续。
发送至外部模型前确认数据范围和脱敏规则，不复用整个个人浏览器资料目录。
轮次、时限或无进展上限触发暂停；具体参数必须在 Phase 1 启动配置中显式指定。
最低限度的本地派发记录、审批和停止在 Phase 1 提供；完整持久恢复在 Phase 2。

Bridge 不是安全沙箱，必须配合底层 Agent 权限限制。完整风险说明见
[SECURITY.md](../SECURITY.md)。未来版本不因遵守协议就自动获得用户机器控制权。
