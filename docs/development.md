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
Phase 0 基础测试与 Phase 1A 默认测试不连接模型、不启动浏览器；显式模型评估命令见 [评估说明](../evaluation/README.md)。
`package.json` 的 `0.0.0` 是不可发布工具占位版本，`private: true` 防止误发 npm。

Phase 1 的明确技术版本、构建与部署方案见 [技术栈选型](tech-stack.md)，不表示当前已安装那些依赖。
当前 Phase 1A 用单个严格 TS 编译配置构建 tools/evaluation 到 .cache/evaluation，只引入编译与类型依赖。
技术栈3.0使用Electron/Forge与React/TS/Vite桌面入口，TS协调核心独立于UI；CLI仅调试，不引入XState或通用Agent框架。
Windows组件为C#/.NET10/FlaUI.UIA3，Mac为Swift/AX，通过版本化JSON-RPC stdio通信；本轮不安装或创建应用空壳。
SQLite/better-sqlite3与Pino为业务记录和诊断，桌面数据放应用数据目录，不写入目标项目，旧评估.local/不自动迁移。
引入 better-sqlite3 时须处理现有 CI 的 --ignore-scripts 与原生绑定安装冲突，
增加经审查的定向 rebuild 及 Windows/Linux 数据库 smoke test，不能只凭依赖安装退出码宣称可用。
Electron自带Node运行时，不假定与系统Node24同ABI；实际打包应用须重建原生模块并验证数据库读写/事务/重启。
Windows helper以自包含目标架构发布，验证无开发SDK机器运行；本机dotnet命令存在但未列出SDK，不擅自安装。
Mac构建在Mac工具链验证，实机另测辅助功能授予/撤销与应用签名身份；编译通过不是交互验收。
Forge内测包不包含账号、会话、数据库或权重；公开签名/公证、证书费用与发布单独批准。

## 测试分层

| 层次 | 当前/未来 | 证据 |
| --- | --- | --- |
| 基础资产 | 当前 | 必需文件、原稿 SHA-256、相对链接、秘密模式 |
| 静态协议契约 | 当前 | 每种动作正例、字段/格式反例、状态表与去重规则声明 |
| 隔离评估工具 | Phase 1A当前 | 严格TS编译、模拟集校验、假HTTP、超时/取消/错绑/资源不足；不证明模型合格 |
| Core 状态与策略 | Phase 1 起 | 真实实现的转移、审批、超时、重复消息测试 |
| 本地协调验证 | Phase 1 起 | 总体/分项评分识别、提示词原文交接、有限澄清与阈值判断；不重新审计项目 |
| 上下文、证据与最小持久记录 | Phase 1 起 | 过期证据、目标/快照变化、原始事实与摘要冲突、存储失败和重启后拒绝盲重发 |
| Adapter 契约 | Phase 1 起 | 假传输和脱敏固定输入，验证状态、读取、回执 |
| 影子运行 | Phase 1 起 | 只观察与建议，发送工具禁用；与人的决定对照，不计入零人工搬运验收 |
| 端到端闭环 | Phase 1 起 | 获准组合中零人工搬运；多轮场景验证连续性，提前达标即停，不为凑轮次继续 |
| 多项目与前台队列 | Phase 1 起 | 两项目独立阈值、目录别名互斥、前台完整事务串行、接管及剪贴板竞争 |
| 平台与安装包 | Phase 1 分平台 | Windows/Mac各自的控件、权限、helper、Electron ABI及安装实测 |
| 恢复与故障注入 | Phase 2 起 | 中断、重启、未知派发结果和持久审批 |

静态规范测试不能证明 Core 行为已被实现。测试凭证不得进入 CI 或仓库。
产品验收口径、FR 编号和待决策门槛见 [PRD](PRD.md)；模型质量不得以 JSON 合法率代替。
新增行为要补适当测试；修复缺陷先补可复现的失败用例。
Windows/Linux CI 运行基础验证、TS 构建和环回假服务故障测试，不接触真实模型、Agent、Cookie 或用户会话。
后续桌面CI与原生组件测试按平台增加，Mac ARM交互需实机；Linux基础CI不表示Linux桌面受支持。
当前只执行计划D0，真实对象、读写权限和阶段门槛见 [桌面接入验收](desktop-integration.md)。

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

协议 `VERSION` 独立采用 `MAJOR.MINOR`。当前草案为 `0.2`，
破坏性变更在实验期提升 minor；稳定后破坏性变更提升 major。
接收端必须明确支持版本，不因主版本相同就猜测兼容。当前拒绝非 `0.2`。
`0.1` 到 `0.2` 的角色绑定与监督决定迁移见 [协议说明](../protocol/README.md)。

## 发布清单

1. 满足该阶段验收，审查风险、依赖许可与安全扫描；CI 通过并取得人类发布批准。
2. 将 `CHANGELOG` 中对应 Unreleased 内容整理为准确版本与发布日期，记录迁移。
3. 复核发布树不含本地状态，提交发布变更并再次验证。
4. 经批准创建版本标签与 GitHub Release，说明已实现和未实现能力。
5. 核实标签、提交和发布资产一致；出现问题发布修复，不重写已发布历史。

Phase 0和Phase 1A不执行这份发布清单，不创建tag、Release或npm包。
CI action 固定到审核过的提交 SHA；更新时复核官方来源与变更说明。
