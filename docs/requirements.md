# 需求依据与差异记录

## 原始资料

- [原始 README](originals/README.md%20%E2%80%94%20%E5%B7%A6%E8%84%9A%E8%B8%A9%E5%8F%B3%E8%84%9A.md)：项目气质和对外表达依据。
- [原始基本需求](originals/%E5%B7%A6%E8%84%9A%E8%B8%A9%E5%8F%B3%E8%84%9A%E5%9F%BA%E6%9C%AC%E9%9C%80%E6%B1%82.md)：产品事实依据。

两份原稿按字节保存，哈希在 [归档清单](originals/manifest.json) 中。
原稿中的能力、旧名和优先级是历史输入，不表示已经实现，也不直接充当当前执行协议。
冲突优先遵循基本需求；用户已批准的 Phase 0 决策由本页明确记录，不静默改写原文。

## 需求追踪

| 需求 | 原始依据 | 正式规范与验证 |
| --- | --- | --- |
| 消除复制、粘贴、切窗口 | 基本需求 1、5、18 | [Phase 1](roadmap/phase-1.md)，至少三轮无人工搬运 |
| 人定方向、AI 规划、Agent 执行 | 基本需求 4、9 | [架构](architecture.md)、[Agent 规则](../AGENTS.md) |
| 厂商无关 | 基本需求 6、13 | Adapter 契约与未来包边界 |
| 结构化状态优先 | 基本需求 13、16 | 接口侦察记录与传输优先级 |
| 机器可解析消息 | 基本需求 11 | [协议](../protocol/README.md)、Schema、正反例 |
| 安全默认停止、人工决策 | 基本需求 10、15 | [安全政策](../SECURITY.md)、[状态机](workflow.md) |
| 会话、日志和恢复 | 基本需求 13.5、17 | [Phase 2](roadmap/phase-2.md)，不伪装成现成功能 |
| 开源实验而非完整平台 | 基本需求 6、19 | README 的能力声明和阶段边界 |

## 已批准的具体取舍

1. 正式名称统一为左脚踩右脚 / Left Foot on Right Foot；原稿中的 `MorphoLoop`
   和 `<MORPHO_LOOP>` 仅留作历史内容，不建立兼容解析器。
2. 通信采用严格 JSON，版本独立；不继续使用松散的冒号文本块。
3. 原稿 `CAPTURING_REPORT`、`SENDING_TO_LLM`、`PARSING_TASK`、`SENDING_TO_AGENT`
   分别统一为 `CAPTURE_REPORT`、`SEND_TO_LLM`、`PARSE_TASK`、`SEND_TO_AGENT`；
   增加 `PAUSED`，以区分人工暂停与错误、审批。
4. Human Gate 虽在原稿版本路线中列为第二阶段，但安全章节要求默认门禁。
   因此最低限度人工审批、停止、超时和防重复派发是 Phase 1 前置条件；
   Phase 2 扩展完整交互及恢复，不能借阶段划分取消安全约束。
5. Phase 0 没有可运行闭环。README 的“怎么跑”只介绍基础验证，不编造功能命令。
6. MIT、TypeScript/Node.js 24/npm、公有 GitHub 仓库与隐私提交邮箱已由维护者确认。

新分歧须新增明确决策并经人类批准；保持原始资料和决策的可追溯性。
