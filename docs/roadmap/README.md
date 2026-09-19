# Roadmap

当前执行已批准桌面计划第1步：文档同步与接入验收清单。旧Phase 1A模型考试不自动恢复，真实会话操作仍按分步授权。
产品是Windows/macOS桌面多项目协调工具，每项目一评估一执行，后台等待并行、前台操作排队；百分比阈值由用户逐项目配置。

| 阶段 | 能力版本 | 文档与边界 |
| --- | --- | --- |
| Phase 0 | Unreleased | [Project Foundation](phase-0.md)，基础已建立 |
| Phase 1A | Unreleased | [桌面基线与接入验证](phase-1a.md)，当前完成文档步，先验证Windows已有会话 |
| Phase 1B | v0.1.0内测目标 | [桌面闭环](phase-1.md)，先Windows安装包，后Mac实机适配，均未实现 |
| Phase 2 | v0.2.0 | [Human Gate、Session、Recovery](phase-2.md)，扩展恢复，不延后最低权限/停止保护 |
| Phase 3 | v0.3.0 | [更多Adapter](phase-3.md)，Codex/ZCODE已是首批目标，不在此才首次接入 |
| Phase 4 | v0.4.0 | [多执行Agent](phase-4.md)，区别于首版多项目各自一对会话 |
| Phase 5 | 未承诺 | [Agent Runtime](phase-5.md)，不以平台化倒推当前实现 |

桌面计划五步：D0文档 → D1 Windows指定会话先读后写接入 → D2桌面最小闭环 → D3多项目/Windows内测包 → D4 Mac实机。
各步入口、证据和当前NOT_RUN矩阵见 [桌面接入验收](../desktop-integration.md)。
当前仅D0文档落实；D1具体会话及读取范围尚未指定，实际控制另行批准，不提前建UI绕过接入风险。

完整规格见 [PRD](../PRD.md)，技术实现基线见 [技术栈](../tech-stack.md)。
每阶段报告实际完成与未验收项；内测安装包不等于公开发布批准，签名账号/费用/推送另行确认。
