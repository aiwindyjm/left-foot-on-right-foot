# 左脚踩右脚

**Left Foot on Right Foot**

> Let AI step on AI. 让 AI 踩着 AI 往前走。

**当前只有 Phase 0 项目基础：文档、通信协议、测试和贡献规则。自动闭环尚未实现，没有可启动的 Bridge，也没有可用的 Agent Adapter。**

## 这是干什么的？

ChatGPT 出主意，Coding Agent 干活。干完以后，它们一起等你。

你复制报告、切窗口、粘贴、发送；等下一条 Prompt，再把刚才的动作倒着来一遍。
半天过去，代码是 AI 写的，快递是你送的。

这个实验想把中间那段机械劳动接起来：

```text
人类：目标、边界、重大决定与最终批准
                   |
ChatGPT / LLM <-> 左脚踩右脚 <-> Coding Agent
     规划          搬运与调度          执行
```

不是重新发明一个超级 Agent，也不是让 AI 自己批准自己。第一关只瞄准
**ZCODE 与 ChatGPT Web 之间连续多轮、零人工复制粘贴的闭环**。
其他 Agent 和模型留有接口，但还没接上。

## 名字为什么这么离谱？

武侠和网络段子里，左脚踩右脚好像就能施展轻功。
现实物理不答应。两个 AI 互相递任务能不能把工作往前推？我们也不知道，准备试试。

工程上严肃，名字上不正经。项目第一步不是飞，是先把脚摆对。

## 现在怎么跑？

现在能跑的是**项目基础验证**，不是 AI 自动化。需要 Git、Node.js 24 和 npm。

```sh
git clone https://github.com/aiwindyjm/left-foot-on-right-foot.git
cd left-foot-on-right-foot
npm ci
npm test
npm run validate
```

验证检查协议样例、格式反例、状态定义、文档链接、原稿完整性和常见敏感信息。
不需要 API Key，不登录 ChatGPT，不控制浏览器或 Agent。
测试通过不表示自动闭环已经可用。

## 从哪里看起？

- [架构与模块边界](docs/architecture.md)：不绑定厂商，也不先造一大堆空目录。
- [通信协议](protocol/README.md)与[状态机](docs/workflow.md)：什么时候继续，什么时候必须停。
- [阶段路线图](docs/roadmap/README.md)：每一关的入口、出口和禁区。
- [需求依据与原稿](docs/requirements.md)：原来的想法一字没删。
- [AGENTS.md](AGENTS.md)：让进仓库的 Coding Agent 先读规矩再动手。

## 后面准备踩到哪儿？

| 阶段 | 目标 | 状态 |
| --- | --- | --- |
| Phase 0 | 项目基础、协议与开源规则 | 本仓库当前范围 |
| Phase 1 / v0.1.0 | ZCODE ↔ ChatGPT Web PoC | 未实现 |
| Phase 2 / v0.2.0 | Human Gate 交互、Session、恢复 | 未实现 |
| Phase 3 / v0.3.0 | Codex / Claude Code / OpenCode Adapter | 未实现 |
| Phase 4 / v0.4.0 | 多 Agent 工作流 | 未实现 |
| Phase 5 | 更完整的 Agent Runtime | 探索方向，未承诺发布日期 |

最低限度的人工审批、紧急停止和防重复派发不能等到第二关再补。
接入方式及第三方服务使用约束也必须先确认，不能把“想接”写成“已支持”。

## 一起试试？

欢迎文档纠错、协议反例、接口研究和小范围 PR。先看 [贡献指南](CONTRIBUTING.md)，
不要一个 PR 顺便造出整个 Agent OS。我们还在摆脚。

维护者：[@aiwindyjm](https://github.com/aiwindyjm)。
安全问题请看 [SECURITY.md](SECURITY.md)，不要把 Cookie 或真实会话贴进 Issue。
社区行为与私密举报见 [行为准则](CODE_OF_CONDUCT.md)。

采用 [MIT](LICENSE)。这是实验，不保证正确、安全或适合生产；请保留权限限制和人工监督。
免责声明也不替代工程上的安全措施。
