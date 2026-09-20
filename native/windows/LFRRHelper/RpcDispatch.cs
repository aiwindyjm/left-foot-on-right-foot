// 方法白名单分发 + 参数/结果 DTO。协议版本握手独立管理。
using System.Text.Json;
using System.Text.Json.Serialization;

namespace LFRR.Helper;

public static class RpcCodes
{
    public const int ParseError = -32700;
    public const int InvalidRequest = -32600;
    public const int MethodNotFound = -32601;
    public const int InvalidParams = -32602;
    public const int InternalError = -32000;
    public const int Unsupported = -32002;
    public const int StaleBinding = -32003;
    public const int PermissionDenied = -32004;
    public const int ForegroundRequired = -32005;
}

public sealed class RpcRequest
{
    [JsonPropertyName("jsonrpc")] public string JsonRpc { get; set; } = "";
    [JsonPropertyName("id")] public long Id { get; set; }
    [JsonPropertyName("method")] public string Method { get; set; } = "";
    [JsonPropertyName("params")] public JsonElement? Params { get; set; }
}

public static class Whitelist
{
    public static readonly string[] Methods =
    {
        "initialize", "shutdown", "ping", "sys.capabilities",
        "uia.locate", "uia.readText", "uia.setValue", "uia.invoke",
        "fg.activate", "clipboard.snapshot", "clipboard.restore",
    };
}

public sealed class RpcDispatch
{
    public const string ProtocolVersion = "1.0";
    public const int ParseError = RpcCodes.ParseError;
    public const int InvalidRequest = RpcCodes.InvalidRequest;
    public const int MethodNotFound = RpcCodes.MethodNotFound;
    public const int InvalidParams = RpcCodes.InvalidParams;
    public const int InternalError = RpcCodes.InternalError;
    public const int Unsupported = RpcCodes.Unsupported;

    private readonly UiaOperations uia;
    private readonly TextWriter stderr;
    private readonly JsonSerializerOptions jsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public bool ShutdownRequested { get; private set; }

    public RpcDispatch(TextWriter stderr)
    {
        this.stderr = stderr;
        uia = new UiaOperations(stderr);
    }

    /// 处理一行请求，返回应答 JSON（通知类返回 null）。
    public string? HandleLine(string line)
    {
        RpcRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<RpcRequest>(line, jsonOptions);
        }
        catch (JsonException)
        {
            return ErrorJson(null, ParseError, "parse error");
        }
        if (request == null || request.JsonRpc != "2.0") return ErrorJson(null, InvalidRequest, "invalid request");
        if (!Whitelist.Methods.Contains(request.Method))
        {
            return ErrorJson(request.Id, MethodNotFound, $"method not found: {request.Method}");
        }
        var params0 = request.Params ?? JsonDocument.Parse("null").RootElement;
        try
        {
            var result = Dispatch(request.Method, params0);
            return ResultJson(request.Id, result);
        }
        catch (RpcFault fault)
        {
            return ErrorJson(request.Id, fault.Code, fault.Message);
        }
    }

    private object? Dispatch(string method, JsonElement ps)
    {
        switch (method)
        {
            case "initialize":
                var requested = GetString(ps, "protocolVersion") ?? "";
                if (requested != ProtocolVersion)
                {
                    throw new RpcFault(InvalidParams,
                        $"protocol version mismatch: helper supports {ProtocolVersion}, client sent '{requested}'");
                }
                return new
                {
                    platform = "win32",
                    methods = MethodMatrix(),
                    notes = new[]
                    {
                        "UIA3 backend; virtualized lists may yield partial text (complete=false)",
                    },
                };
            case "shutdown":
                ShutdownRequested = true;
                return new { bye = true };
            case "ping":
                return new { pong = true };
            case "sys.capabilities":
                return new { platform = "win32", methods = MethodMatrix(), notes = Array.Empty<string>() };
            case "uia.locate":
            {
                var appHint = GetString(ps, "appHint") ?? throw new RpcFault(InvalidParams, "appHint required");
                var sessionHint = GetString(ps, "sessionHint") ?? "";
                return uia.Locate(appHint, sessionHint);
            }
            case "uia.readText":
            {
                var handle = GetString(ps, "handle") ?? throw new RpcFault(InvalidParams, "handle required");
                return uia.ReadText(handle);
            }
            case "uia.setValue":
            {
                var handle = GetString(ps, "handle") ?? throw new RpcFault(InvalidParams, "handle required");
                var text = GetString(ps, "text") ?? throw new RpcFault(InvalidParams, "text required");
                uia.SetValue(handle, text);
                return new { ok = true };
            }
            case "uia.invoke":
            {
                var handle = GetString(ps, "handle") ?? throw new RpcFault(InvalidParams, "handle required");
                uia.Invoke(handle);
                return new { ok = true };
            }
            case "fg.activate":
            {
                var handle = GetString(ps, "handle") ?? throw new RpcFault(InvalidParams, "handle required");
                uia.ActivateForeground(handle);
                return new { ok = true };
            }
            case "clipboard.snapshot":
                return uia.ClipboardSnapshot();
            case "clipboard.restore":
                return uia.ClipboardRestore(ps);
            default:
                throw new RpcFault(MethodNotFound, $"method not found: {method}");
        }
    }

    /// 能力矩阵：JSON 键含点号，匿名类型无法表达，用字典序列化（键原样保留）。
    private static System.Collections.Generic.Dictionary<string, string> MethodMatrix() =>
        new()
        {
            ["initialize"] = "supported",
            ["shutdown"] = "supported",
            ["ping"] = "supported",
            ["sys.capabilities"] = "supported",
            ["uia.locate"] = "supported",
            ["uia.readText"] = "supported",
            ["uia.setValue"] = "supported",
            ["uia.invoke"] = "supported",
            ["fg.activate"] = "supported",
            ["clipboard.snapshot"] = "supported",
            ["clipboard.restore"] = "supported",
        };

    private static string? GetString(JsonElement ps, string name)
    {
        if (ps.ValueKind != JsonValueKind.Object) return null;
        if (!ps.TryGetProperty(name, out var value)) return null;
        return value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    }

    public static string ResultJson(long id, object? result) =>
        JsonSerializer.Serialize(new { jsonrpc = "2.0", id, result }, jsonOptionsStatic);
    public static string ErrorJson(long? id, int code, string message) =>
        JsonSerializer.Serialize(new { jsonrpc = "2.0", id, error = new { code, message } }, jsonOptionsStatic);
    private static readonly JsonSerializerOptions jsonOptionsStatic = new();
}

public sealed class RpcFault : Exception
{
    public int Code { get; }
    public RpcFault(int code, string message) : base(message) => Code = code;
}
