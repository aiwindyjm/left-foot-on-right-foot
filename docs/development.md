# 开发、测试与发布

## 本地验证

需要 Git、Node.js 24、npm 11。Windows PowerShell 与 Linux shell 使用同样命令：

```sh
npm ci
npm test
npm run validate
git diff --check
```

`npm test` 运行静态协议测试、基础资产测试和批次A新增的核心/存储/模型客户端/集成测试
（node:test，约 179 项；模型链路走本地假 Ollama 服务，不加载真实权重）。
`npm run validate` 再跑完整测试、UI typecheck、Vite 构建，并检查整个 Git 可见工作集的
文档链接、秘密模式和 Git 空白错误；不联网检查外部链接。
`npm run check:secrets` 单独扫描已知秘密模式，不会打印匹配值。

## 桌面功能开发版（批次A）

```sh
npm install            # 首次安装；本机 npm 沙箱不跑 postinstall 时再执行 node scripts/fetch-electron.mjs
npm start              # 构建（TS + Vite）并以模拟模式启动桌面
npm run dev            # 同上（显式开发入口）
npm run package:win    # 生成 out/<name>-win32-x64/（Windows x64 开发包）
npm run dist:win       # 生成 out/make/zip/... 分发 zip
```

模拟模式下桌面使用内置模拟会话与本地回环假模型服务（真实 HTTP 协议链路，非固定返回），
可完整体验：创建项目 → 设阈值 → 启动循环 → 观察评估/缺项 → 暂停/停止 → 查看持久记录。
生产模式：`LFRR_MODE=production LFRR_MODEL_ENDPOINT=http://127.0.0.1:11434 npm start`，
需要本机 Ollama 与已拉取模型；Codex/ZCODE 真实接入在批次B联调前会诚实报告"未联调"。
桌面数据（SQLite/WAL）保存在应用数据目录 `coordination/` 下，不写入被管理项目。

依赖只用于开发验证，版本精确固定并提交 `package-lock.json`。
Phase 0 基础测试与 Phase 1A 默认测试不连接模型、不启动浏览器；显式模型评估命令见 [评估说明](../evaluation/README.md)。
`package.json` 的 `0.0.0` 是不可发布工具占位版本，`private: true` 防止误发 npm。

Phase 1 的明确技术版本、构建与部署方案见 [技术栈选型](tech-stack.md)，不表示当前已安装那些依赖。
当前 Phase 1A 用单个严格 TS 编译配置构建 tools/evaluation 到 .cache/evaluation，只引入编译与类型依赖。
技术栈3.0使用Electron/Forge与React/TS/Vite桌面入口，TS协调核心独立于UI；CLI仅调试，不引入XState或通用Agent框架。
Windows组件为C#/.NET10/FlaUI.UIA3，Mac为Swift/AX，通过版本化JSON-RPC stdio通信；开发交付须含功能，不以空壳代替。
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
按最新 [开发计划](roadmap/delivery-plan.md) 先实现功能并做本地集成；真实对象缺失不阻塞编码。
真实读写仍按 [桌面接入验收](desktop-integration.md) 授权，模拟测试和实际兼容结果分开报告。

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

### GitHub Release 策略

Git 提交、GitHub 推送和 GitHub Release 是三个不同动作：提交保存历史，推送同步代码，Release
面向使用者标记一个可理解的交付点。普通提交和合并 PR 不自动创建 Release；每个已完成阶段至少
创建一个对应的 GitHub Release，避免仓库长期显示 `No releases published`。

| 版本 | 对应阶段 | 类型 | 最低内容 |
| --- | --- | --- | --- |
| `v0.0.1-foundation` | Phase 0 | 正式基础版本 | 规则、协议、测试和可贡献仓库基础；不宣称运行时闭环 |
| `v0.1.0` | Phase 1 / 1B | 正式功能版本 | Windows 可运行 PoC、双会话、阈值停止、最小 Human Gate 和验收证据 |
| `v0.2.0` | Phase 2 | 正式功能版本 | Session、日志、暂停恢复和异常恢复达到阶段验收 |
| `v0.3.0` | Phase 3 | 正式功能版本 | 额外产品/模型 Adapter 完成真实联调并有兼容性说明 |
| `v0.4.0` | Phase 4 | 正式功能版本 | 多 Agent 工作流达到明确验收标准 |

Phase 0 的 Release 只表示工程基础可以被 Clone、理解和贡献，不表示产品闭环已经实现。
阶段开发中可以发布 `v0.1.0-rc.1`、`v0.1.0-beta.1` 或 `v0.1.0-dev.1` 等预发布版本，
但必须明确列出未完成、未验证和不可用于生产的部分。阶段验收通过后再创建对应正式版本。

每个 Release 必须满足：

1. `CHANGELOG.md` 的 `Unreleased` 内容已整理为对应版本，并注明日期、迁移说明和已知限制。
2. 标签指向已验收提交，版本标签、Release 页面和附件哈希可以互相核对；发布后不重写标签、不强推。
3. 正文写清已实现能力、未实现能力、支持平台、验证命令及实际结果、安全边界和已知风险。
4. 可安装包只有完成内容白名单、哈希和启动冒烟验证后才能作为附件；未签名内测包必须标为预发布。
5. 没有实际能力变化不创建新版本；`v0.x.y` 中 `x` 表示能力阶段，`y` 表示该阶段的兼容修复。

Release 仍是外部发布动作，需要维护者明确授权。本节定义发布时机和证据，不替代人工批准。

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

Phase 0 不发布 npm 包；完成基础资产并取得明确发布授权后，应创建 `v0.0.1-foundation`
GitHub Release。Phase 1A 不创建功能 Release；若需展示开发进度，只能使用明确标记的预发布版本。
CI action 固定到审核过的提交 SHA；更新时复核官方来源与变更说明。
