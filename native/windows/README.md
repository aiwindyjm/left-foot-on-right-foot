# Windows 原生 Helper（lfrr-helper）

C#/.NET 10 + FlaUI.UIA3 实现版本化 JSON-RPC（契约：`src/shared/native-rpc.ts` v1.0）。
进程模型：stdin/stdout 逐行 NDJSON，stdout 仅协议消息，诊断走 stderr；请求串行处理。

## 方法矩阵

| 方法 | 状态 | 说明 |
| --- | --- | --- |
| initialize / shutdown / ping | 支持 | 版本握手 `protocolVersion: "1.0"`，不匹配即 InvalidParams |
| sys.capabilities | 支持 | 如实报告能力矩阵，不虚构 |
| uia.locate | 支持 | 按 appHint（进程名/窗口标题）+ sessionHint 锚点定位顶层窗口；不做全窗口扫描 |
| uia.readText | 支持 | ValuePattern 优先，TextPattern 兜底；不可读显式报 Unsupported |
| uia.setValue / uia.invoke | 支持 | 对应 ValuePattern / InvokePattern；模式缺失显式报错 |
| fg.activate | 支持 | SetForegroundWindow；被拒绝时返回 FOREGROUND_REQUIRED（-32005），不静默重试 |
| clipboard.snapshot / restore | 支持 | 仅 CF_UNICODETEXT；快照只存内存；restore 语义为写回快照值 |

句柄生命周期：应用重启/控件失效后旧 handle 返回 STALE_BINDING（-32003），
宿主必须重新 locate，不得跨生命周期复用。

## 构建（本机当前无 .NET SDK，NOT_RUN）

```sh
dotnet publish LFRRHelper/LFRRHelper.csproj -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true
```

产物：`bin/Release/net10.0-windows/win-x64/publish/lfrr-helper.exe`（自包含，目标机无需 SDK）。

## 状态与边界（批次A）

- **编译 NOT_RUN**：本机 `dotnet --list-sdks` 无 SDK；源码未经编译验证，语法/API 错误需 SDK 安装后修正。
- **真实 UIA 行为 NOT_RUN**：未接触任何用户应用；`uia.*` 的控件树/虚拟化列表行为以批次B联调为准。
- FlaUI.UIA3 4.0.0 版本号为占位，SDK 安装后按 NuGet 实际稳定版冻结。
- 不申请管理员权限；SendInput 兜底不在本批次范围（契约保留 fg.activate 前台语义）。
