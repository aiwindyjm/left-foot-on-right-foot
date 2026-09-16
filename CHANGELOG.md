# Changelog

本文件只记录已经进入仓库的变化。能力版本由验收结果决定，不按日期凑版本。
发布规则见 [开发说明](docs/development.md)。

## [Unreleased]

### Added

- 项目定位、架构、阶段路线图与原始资料归档。
- 仓库级 Agent、贡献、行为、安全与发布规则。
- TASK / REPORT 协议草案、JSON Schema 与静态契约样例。
- 工作流状态规范与基础验证工具、Windows/Linux CI。

### Changed

- CI Actions 固定到原生 Node.js 24 运行时的官方版本，消除旧运行时弃用告警。

尚未实现 Bridge、ZCODE 或其他 Adapter、浏览器自动化、Session 恢复或 UI。
Phase 0 不等于 v0.1.0，不创建功能发布。
