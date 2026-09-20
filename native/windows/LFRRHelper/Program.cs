// lfrr-helper：stdin/stdout NDJSON JSON-RPC 2.0 入口（契约见 src/shared/native-rpc.ts v1.0）。
// stdout 仅协议消息；诊断一律走 stderr。请求串行处理（UIA 线程约束）。
using System.Text;
using LFRR.Helper;

Console.OutputEncoding = Encoding.UTF8;
Console.InputEncoding = Encoding.UTF8;

var stderr = Console.Error;
var dispatcher = new RpcDispatch(stderr);
var stdin = Console.In;
var stdout = Console.Out;

string? line;
while ((line = stdin.ReadLine()) != null)
{
    if (string.IsNullOrWhiteSpace(line)) continue;
    string? responseJson;
    try
    {
        responseJson = dispatcher.HandleLine(line);
    }
    catch (Exception ex)
    {
        // 兜底：任何未预期异常都以 INTERNAL_ERROR 应答，进程保持存活。
        stderr.WriteLine($"unhandled: {ex.GetType().Name} {ex.Message}");
        responseJson = RpcDispatch.ErrorJson(0, RpcDispatch.InternalError, "internal error");
    }
    if (responseJson != null)
    {
        stdout.WriteLine(responseJson);
        stdout.Flush();
    }
    if (dispatcher.ShutdownRequested) break;
}
