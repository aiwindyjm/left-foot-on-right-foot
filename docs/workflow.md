# 工作流状态机 0.1

设计规范，尚未实现运行时。机器可读邻接表见 [workflow-model.json](workflow-model.json)；
下列每个状态的允许转移与该表由测试核对。

正常闭环：

```text
IDLE -> SEND_TO_AGENT -> AGENT_RUNNING -> AGENT_WAITING
 -> CAPTURE_REPORT -> SEND_TO_LLM -> LLM_THINKING -> LLM_DONE
 -> PARSE_TASK -> SEND_TO_AGENT (next round) / COMPLETED
```

## 全局守卫

任何派发之前检查上下文、关联、去重、预算和授权。第一次运行默认需要人工批准目标及范围。
等待不是成功；模型沉默不是完成；不能用固定 sleep 时间代替真实状态证据。
遇到登录或权限请求、高风险动作、重大决策、消息冲突或未知发送结果进入 HUMAN_GATE。
格式错误、来源错配、已确认失败或无外部副作用的超时进入 ERROR；不自动补发。

人工暂停、紧急停止或限额触发时，先禁止新的发送，再请求终止在途操作；
仅确认静止后进入 PAUSED。无法确认停止时进入 HUMAN_GATE，展示未知状态与人工停止步骤。
已经处于 HUMAN_GATE / PAUSED / ERROR 的重复停止请求不再次派发，记录后保持当前状态。
COMPLETED 是终态；新任务创建新的 Session，不复活旧终态。

## IDLE

进入：新 Session 尚未发送初始任务。
动作：绑定项目、Agent、LLM 会话，校验人工初始 TASK 和有限授权。
退出：明确批准后进入 SEND_TO_AGENT；未批准进 HUMAN_GATE；取消进 PAUSED；校验失败进 ERROR。

允许转移：`SEND_TO_AGENT`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## SEND_TO_AGENT

进入：任务结构、关联、策略和停止限额均通过。
动作：先记录派发意图，以同一任务 ID 发送一次，等待可核对回执。
退出：确认接收并执行后进入 AGENT_RUNNING；结果未知进 HUMAN_GATE；明确失败进 ERROR。
暂停仅在确认未发送或已停止后生效。

允许转移：`AGENT_RUNNING`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## AGENT_RUNNING

进入：Agent 已确认开始当前任务。
动作：观察结构化事件或可靠状态，响应停止请求。
退出：观察到真实停止进入 AGENT_WAITING；权限请求进 HUMAN_GATE；崩溃/超时按全局守卫处理。

允许转移：`AGENT_WAITING`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## AGENT_WAITING

进入：Agent 停止运行，但尚未判定原因。
动作：区分报告就绪、请求输入、权限审批和执行错误。
退出：只有完整报告就绪才进 CAPTURE_REPORT；需要决定进 HUMAN_GATE；异常进 ERROR。

允许转移：`CAPTURE_REPORT`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## CAPTURE_REPORT

进入：当前任务的报告可读且来源可核对。
动作：读取并校验 REPORT、关联和真实完成证据，按批准的数据范围脱敏。
退出：可外发的普通完成报告进 SEND_TO_LLM；门禁报告进 HUMAN_GATE；
PAUSED/LIMIT_REACHED 报告进 PAUSED；错误或无完整报告进 ERROR。

允许转移：`SEND_TO_LLM`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## SEND_TO_LLM

进入：报告通过校验，外发范围已由人批准。
动作：记录意图，发送到绑定会话，等待提交回执；不自动打开其他会话兜底。
退出：确认接收进入 LLM_THINKING；发送结果未知或需重新登录进 HUMAN_GATE；明确失败进 ERROR。

允许转移：`LLM_THINKING`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## LLM_THINKING

进入：当前报告对应的模型响应正在生成。
动作：观察生成状态与截止时间，不读取半截回复当作任务。
退出：确认生成完整响应进 LLM_DONE；超时或失败进 ERROR；需人工接管进 HUMAN_GATE。

允许转移：`LLM_DONE`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## LLM_DONE

进入：当前提交的完整模型消息已生成。
动作：读取该消息并绑定来源，保留本地受控原文。
退出：完整读取进 PARSE_TASK；来源不符或读取失败进 ERROR；权限变化进 HUMAN_GATE。

允许转移：`PARSE_TASK`、`HUMAN_GATE`、`PAUSED`、`ERROR`。

## PARSE_TASK

进入：完整响应或人工恢复时提供的候选任务已就绪。
动作：严格 JSON、Schema、版本、关联、去重、阶段、授权与限额检查。
退出：CONTINUE 仅在所有守卫通过时进 SEND_TO_AGENT；
PAUSE 进 PAUSED；HUMAN_GATE 进同名状态；ERROR 或无效消息进 ERROR；
COMPLETED 只有验收证据充分才进入终态，否则进 HUMAN_GATE。

允许转移：`SEND_TO_AGENT`、`HUMAN_GATE`、`PAUSED`、`ERROR`、`COMPLETED`。

## HUMAN_GATE

进入：需要人类决定，所有新派发关闭；如执行停止未确认，明确显示仍可能运行。
动作：展示脱敏依据、风险、目标和待批准内容，记录人类决定。
退出：确认静止、消除歧义并提供有效候选任务/完成请求后进入 PARSE_TASK 重新校验，
而不是直接发送；拒绝或延期进 PAUSED；明确失败进 ERROR。
恢复中需继续读取已有在途响应而非发送新任务的复杂情况，Phase 1 仅人工核对后结束当前会话，
Phase 2 再设计持久恢复，不伪装成自动恢复。

允许转移：`PARSE_TASK`、`PAUSED`、`ERROR`。

## PAUSED

进入：已确认静止的暂停或限额停止，不再有自动发送。
动作：保留上下文与停止原因，等待明确人工操作。
退出：尚未派发任何消息的 Session 可回 IDLE；有已核对且获准的候选任务回 PARSE_TASK；
在途结果未解决进 HUMAN_GATE；恢复检查失败进 ERROR。不能丢掉发送历史后回 IDLE。

允许转移：`IDLE`、`PARSE_TASK`、`HUMAN_GATE`、`ERROR`。

## ERROR

进入：协议/上下文错误、已确认失败或超时。
动作：停止派发，记录错误，保留证据；有在途执行时请求停止并报告是否确认。
退出：人工确认静止后可进 PAUSED；需决定或无法确认停止进 HUMAN_GATE。
没有自动 ERROR → SEND_TO_AGENT 重试。

允许转移：`PAUSED`、`HUMAN_GATE`。

## COMPLETED

进入：当前授权范围的验收条件有证据支持，且没有未解决风险或在途执行。
动作：输出最终报告并停止；如任务需要最终人类批准，批准必须先取得。
退出：无。人工终止但未完成验收仍是 PAUSED，不伪造完成。

允许转移：无。

## 关联与去重

相同 ID 与相同内容：IGNORE_DUPLICATE，保持状态，不再次派发。
相同 ID 不同内容：HUMAN_GATE。上下文错配：ERROR。回复关联错配：ERROR。
未知发送结果：HUMAN_GATE，不能用新 ID 重试来绕过去重。
详细语义见 [协议](../protocol/README.md)。静态测试只能核对定义，未来必须补运行时测试。
