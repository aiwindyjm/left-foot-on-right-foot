# Roadmap

当前按用户2026-09-20纠正先开发功能，再联调验收。旧Phase 1A模型考试不恢复，真实会话操作仍按具体授权。
产品是Windows/macOS桌面多项目协调工具，每项目一评估一执行，后台等待并行、前台操作排队；百分比阈值由用户逐项目配置。

| 阶段 | 能力版本 | 文档与边界 |
| --- | --- | --- |
| Phase 0 | Unreleased | [Project Foundation](phase-0.md)，基础已建立 |
| Phase 1A | Unreleased | [基线与接入规范](phase-1a.md)，基线已有，真实接入后续联调，不阻塞编码 |
| Phase 1B | v0.1.0内测目标 | [桌面闭环](phase-1.md)，先Windows安装包，后Mac实机适配，均未实现 |
| Phase 2 | v0.2.0 | [Human Gate、Session、Recovery](phase-2.md)，扩展恢复，不延后最低权限/停止保护 |
| Phase 3 | v0.3.0 | [更多Adapter](phase-3.md)，Codex/ZCODE已是首批目标，不在此才首次接入 |
| Phase 4 | v0.4.0 | [多执行Agent](phase-4.md)，区别于首版多项目各自一对会话 |
| Phase 5 | 未承诺 | [Agent Runtime](phase-5.md)，不以平台化倒推当前实现 |

交付顺序：功能开发与模拟集成 → Windows真实联调/内测 → Mac适配/实机。
D0-D4保留为基线及实测验收项，见 [桌面接入验收](../desktop-integration.md)，不是全部编码的串行前提。
核心、桌面和适配代码先实现；D1会话及权限只限制真实联调，不能以未指定会话为由停止其他开发。

完整规格见 [PRD](../PRD.md)，技术实现基线见 [技术栈](../tech-stack.md)。
每阶段报告实际完成与未验收项；内测安装包不等于公开发布批准，签名账号/费用/推送另行确认。

## 开发组织计划

由架构会话负责全局与批次验收，ZCODE主会话负责并行分工、集成和长任务交付，见
[落地开发计划](delivery-plan.md) 与 [ZCODE执行入口](../zcode-delivery.md)。
这是先开发后联调的交付组织方案，不改变产品目标；开发方向确认不等于真实控制或发布授权。
