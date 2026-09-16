# 开发、测试与发布

## 本地验证

需要 Git、Node.js 24、npm 11。Windows PowerShell 与 Linux shell 使用同样命令：

```sh
npm ci
npm test
npm run validate
git diff --check
```

`npm test` 运行静态协议与基础资产测试；`npm run validate` 再检查整个 Git 可见工作集的
文档链接、秘密模式和 Git 空白错误。它也检查未跟踪但未忽略的文件，
忽略 `node_modules` 等本地内容；不联网检查外部链接。
`npm run check:secrets` 单独扫描已知秘密模式，不会打印匹配值。

依赖只用于开发验证，版本精确固定并提交 `package-lock.json`。
Phase 0 工具不导出产品 SDK、不连接模型、不启动浏览器。
`package.json` 的 `0.0.0` 是不可发布工具占位版本，`private: true` 防止误发 npm。

## 测试分层

| 层次 | 当前/未来 | 证据 |
| --- | --- | --- |
| 基础资产 | 当前 | 必需文件、原稿 SHA-256、相对链接、秘密模式 |
| 静态协议契约 | 当前 | 每种动作正例、字段/格式反例、状态表与去重规则声明 |
| Core 状态与策略 | Phase 1 起 | 真实实现的转移、审批、超时、重复消息测试 |
| Adapter 契约 | Phase 1 起 | 假传输和脱敏固定输入，验证状态、读取、回执 |
| 端到端闭环 | Phase 1 起 | 人工批准的隔离环境中至少三轮，保存脱敏验收证据 |
| 恢复与故障注入 | Phase 2 起 | 中断、重启、未知派发结果和持久审批 |

静态规范测试不能证明 Core 行为已被实现。测试凭证不得进入 CI 或仓库。
新增行为要补适当测试；修复缺陷先补可复现的失败用例。
Windows/Linux CI 只运行基础验证，不接触真实 Agent、Cookie 或用户会话。

## Git 与审查

默认分支 `main`；使用聚焦分支和 PR，维护者审查后合并。
提交格式 `type: description`，推荐类型见 [贡献指南](../CONTRIBUTING.md)。
首次提交为 `chore: initialize open source project`。
不强制额外签署 CLA；不在本轮配置付费能力或复杂分支保护。
CODEOWNERS 表达审查归属，不等于服务器端强制保护。

## 版本机制

软件标签使用 `vMAJOR.MINOR.PATCH`，每个 minor 表示可理解、可验收的能力集合。
`v0.1.0` 是实际 PoC，不是“文件建好了”；后续能力映射见 [路线图](roadmap/README.md)。
在 `0.x` 阶段，破坏性行为或接口变化提升 minor 并写迁移说明；兼容修复提升 patch。
不得通过每天一个版本掩盖没有新增可用能力。

协议 `VERSION` 独立采用 `MAJOR.MINOR`。当前草案为 `0.1`，
破坏性变更在实验期提升 minor；稳定后破坏性变更提升 major。
接收端必须明确支持版本，不因主版本相同就猜测兼容。当前拒绝非 `0.1`。

## 发布清单

1. 满足该阶段验收，审查风险、依赖许可与安全扫描；CI 通过并取得人类发布批准。
2. 将 `CHANGELOG` 中对应 Unreleased 内容整理为准确版本与发布日期，记录迁移。
3. 复核发布树不含本地状态，提交发布变更并再次验证。
4. 经批准创建版本标签与 GitHub Release，说明已实现和未实现能力。
5. 核实标签、提交和发布资产一致；出现问题发布修复，不重写已发布历史。

Phase 0 不执行这份发布清单，不创建 tag、Release 或 npm 包。
CI action 固定到审核过的提交 SHA；更新时复核官方来源与变更说明。
