# 三方监督工作流 0.2

**迁移状态：本页与机器状态表保留旧0.2契约，尚未适配 [PRD 1.5](PRD.md)。**
桌面多项目的全局前台队列、工作区互斥、平台权限和各项目阈值尚未入机器表；原生RPC也未实现。
新产品流程为执行结果回传 → 评估会话核对PRD并给百分比/提示词 → 本地理解 → 比较用户配置阈值 → 未达标交接、达标停止。
80%仅为示例，达标停止不等于本页COMPLETED所代表的完整验收；不得靠旧状态测试通过宣称新流程实现。
后续需同步机器表、协议和测试，本轮仅标注差异，不改变旧转移规则或恢复原实施计划。

设计规范，尚未实现运行时。[机器可读模型](workflow-model.json) 与本页转移由测试核对。
状态机限制何时可以操作；具体审查判断由本地模型产生，不能用预编排脚本替代。

```text
IDLE -> PARSE_TASK -> SUPERVISE_PLAN -> SEND_TO_AGENT
 -> AGENT_RUNNING -> AGENT_WAITING -> CAPTURE_REPORT
 -> SUPERVISE_REPORT -> SEND_TO_PLANNER -> PLANNER_THINKING
 -> PLANNER_DONE -> PARSE_TASK -> SUPERVISE_PLAN
```

SUPERVISE_PLAN 可以要求规划修订、建议派发或建议完成；两种监督状态均可暂停、求助或报错。
Planner、Supervisor、Agent 三个角色不能混为一个模型调用。

## 全局守卫

每次发送前检查真实来源、三方绑定、当前源消息、监督决定、证据引用、人工授权、
限额和去重。TASK 是提案，不是已授权命令，DECISION 也不是权限凭证。
所有新决定绑定上下文快照；模型配置、阶段、候选任务或角色变化后不得复用旧决定。
规划修订循环与普通执行循环都消耗预算，不允许无限来回讨论。
同一状态内的只读状态/证据读取可在明确次数与截止时间内重试；无配置默认不重试。
这不新增派发路径，不适用于模型生成修复、任务发送或未知执行结果；耗尽预算按失败处理。
发送意图和必要上下文必须可持久记录；记录失败禁止新派发，重启发现未确认动作需人工核对。

权限请求、重大决策、消息冲突或未知发送结果进入 HUMAN_GATE；
格式、身份、引用错误和本地推理故障进入 ERROR。
不得由本地模型猜测外部动作是否已成功，不得回退云监督或自动脚本继续派发。
Planner/Agent 的显式暂停、门禁或错误只能停止，不能由监督模型降级。

人工暂停、紧急停止或限额触发先禁止新发送，再请求停止在途操作；
确认静止后进入 PAUSED，否则进入 HUMAN_GATE 并说明仍可能运行。
重复停止请求保持停止状态。COMPLETED 是终态，新目标开启新 Session。

## IDLE

进入：新 Session，人工已提供目标、边界与来自 Planner 的初始候选 TASK。
动作：绑定 Planner 会话、本地监督模型配置、Agent，检查本地推理可用性。
退出：候选消息就绪进 PARSE_TASK；未授权进 HUMAN_GATE；取消进 PAUSED；失败进 ERROR。
初始任务不能跳过本地监督。

允许转移：`PARSE_TASK`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## SEND_TO_AGENT

进入：SUPERVISE_PLAN 已产生适用的 DISPATCH_TASK，且程序守卫全部通过。
动作：记录派发意图，发送被审查的原 TASK 一次，不能暗改 Prompt。
退出：确认执行进 AGENT_RUNNING；未知发送结果进 HUMAN_GATE；明确失败进 ERROR。
暂停须确认未发送或已停止。

允许转移：`AGENT_RUNNING`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## AGENT_RUNNING

进入：Agent 确认正在执行当前任务。
动作：观察结构化状态，响应停止，不用固定等待时间推定完成。
退出：有停止证据进 AGENT_WAITING；权限请求进 HUMAN_GATE；失败进 ERROR；
暂停按全局守卫处理。

允许转移：`AGENT_WAITING`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## AGENT_WAITING

进入：Agent 已停止，但尚未判定原因。
动作：区分报告就绪、权限请求、输入请求和失败。
退出：报告就绪进 CAPTURE_REPORT；需要决定进 HUMAN_GATE；失败进 ERROR；暂停进 PAUSED。

允许转移：`CAPTURE_REPORT`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## CAPTURE_REPORT

进入：当前任务报告可读。
动作：读取 REPORT，核对结构、身份与关联，保存完整受控证据。
退出：普通报告进 SUPERVISE_REPORT，不直接外发；门禁报告进 HUMAN_GATE；
PAUSED/LIMIT_REACHED 进 PAUSED；错误报告或校验失败进 ERROR。

允许转移：`SUPERVISE_REPORT`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## SUPERVISE_REPORT

进入：当前 REPORT 及目标、验证证据已就绪。
动作：本地模型审查进度、证据缺口、阻塞及偏离，返回 REVIEW=REPORT 的 DECISION。
退出：有效 FORWARD_REPORT 且通过外发守卫进 SEND_TO_PLANNER，连同缺口说明转交；
PAUSE/HUMAN_GATE/ERROR 对应停止。无效输出、缺少本地模型或推理超时进 ERROR。
报告转交不表示验收成功，不允许在这里直接造任务或宣布完成。

允许转移：`SEND_TO_PLANNER`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## SEND_TO_PLANNER

进入：有效 FORWARD_REPORT 或 REQUEST_REVISION 决定，外发范围已批准。
动作：将源 REPORT/TASK 与监督结论、目标和必要历史送到绑定 Planner，
记录意图和请求回执。不得隐去失败证据或把修订请求当 Agent 命令。
退出：确认接收进 PLANNER_THINKING；未知结果或登录请求进 HUMAN_GATE；失败进 ERROR。
暂停须确认停止在途操作。

允许转移：`PLANNER_THINKING`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## PLANNER_THINKING

进入：Planner 正在响应当前上下文或修订请求。
动作：观察生成与截止时间，不将流式半截文字视为候选任务。
退出：完整完成进 PLANNER_DONE；超时/失败进 ERROR；人工接管或暂停按全局守卫处理。

允许转移：`PLANNER_DONE`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## PLANNER_DONE

进入：当前请求的规划响应完整。
动作：读取完整响应，核对来源并保留受控原文。
退出：读取完成进 PARSE_TASK；失败进 ERROR；需人工处理或暂停按全局守卫处理。

允许转移：`PARSE_TASK`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## PARSE_TASK

进入：初始、后续或人工恢复的候选 TASK 已就绪。
动作：严格 JSON、Schema、真实身份、关联、去重与阶段边界检查。
退出：CONTINUE 或 COMPLETED 提案进 SUPERVISE_PLAN；不能直接派发或完成。
PAUSE 进 PAUSED，HUMAN_GATE 进同名状态，ERROR 或校验失败进 ERROR。
任意本地策略也可强制人工门禁，不能只依赖模型自报风险。

允许转移：`SUPERVISE_PLAN`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## SUPERVISE_PLAN

进入：通过结构校验的 CONTINUE/COMPLETED 候选及可核对上下文。
动作：本地模型审查目标一致性、可执行性、验证条件、偏离与风险，返回 REVIEW=PLAN 的 DECISION。
退出：DISPATCH_TASK 只能对应 CONTINUE，程序守卫通过后进 SEND_TO_AGENT；
REQUEST_REVISION 进 SEND_TO_PLANNER，由 Planner 产出新候选并重新审查。
COMPLETED 只能对应 COMPLETED 提案，有验收证据、无在途任务且取得必要最终人工批准后进入终态，
否则进 HUMAN_GATE。PAUSE/HUMAN_GATE/ERROR 分别停止，无效或过期决定进 ERROR。

允许转移：`SEND_TO_AGENT`、`SEND_TO_PLANNER`、`HUMAN_GATE`、`PAUSED`、`ERROR`、`COMPLETED`。

## HUMAN_GATE

进入：需要人类决定，所有新派发关闭；未确认停止的执行明确显示为可能仍运行。
动作：展示源消息、监督依据、风险与选项，记录人类决定，不能请求模型代人审批。
退出：确认静止并获得有效候选/完成提案后进 PARSE_TASK 重新监督；
拒绝/延期进 PAUSED，明确失败进 ERROR。
PoC 中复杂的在途读取恢复只人工核对并结束当前会话，Phase 2 再实现完整恢复。

允许转移：`PARSE_TASK`、`PAUSED`、`ERROR`。

## PAUSED

进入：已确认静止的暂停或限额停止。
动作：保留原因、上下文及派发历史，等待人类恢复。
退出：从未派发的 Session 可回 IDLE；有核对且获准候选回 PARSE_TASK；
未解决的在途结果进 HUMAN_GATE；恢复校验失败进 ERROR。不得遗忘派发历史重新启动。

允许转移：`IDLE`、`PARSE_TASK`、`HUMAN_GATE`、`ERROR`。

## ERROR

进入：协议/身份/证据错误、推理故障、已确认失败或超时。
动作：停止派发，保存脱敏诊断，处理在途停止并明确结果；无自动继续或模型兜底。
退出：人确认静止后进 PAUSED；需决定或不能确认停止进 HUMAN_GATE。

允许转移：`PAUSED`、`HUMAN_GATE`。

## COMPLETED

进入：规划完成提案经本地监督审查，程序核对验收和必要人工批准，无在途执行。
动作：输出最终报告并停止。人终止但未通过验收是 PAUSED，不伪装成完成。
退出：无。

允许转移：无。

## 契约与迁移

相同消息 ID、相同内容保持状态不派发；相同 ID 不同内容进 HUMAN_GATE；
上下文、回复或证据错配进 ERROR；未知发送结果进 HUMAN_GATE。
0.1 的 SEND_TO_LLM / LLM_THINKING / LLM_DONE 改为明确的 Planner 状态，
新增 SUPERVISE_REPORT / SUPERVISE_PLAN，移除解析后直接派发的路径。
静态测试只能检查定义一致性，不能证明模型监督质量或 Runtime 守卫已实现。
