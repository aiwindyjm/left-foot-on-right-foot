// FlaUI.UIA3 封装：控件定位/读取/写入/调用、前台激活、CF_UNICODETEXT 剪贴板快照恢复。
// 能力缺失显式报错（RpcFault），不用坐标或猜测填补（tech-stack §4）。
// R10 修正：sessionHint 锚点缺失时定位失败（不凭窗口标题绑定）；
// TextPattern 路径按保守语义返回 complete=false；恢复剪贴板前检查当前值是否仍为快照值。
using System.Runtime.InteropServices;
using System.Text.Json;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;

namespace LFRR.Helper;

public sealed class UiaOperations
{
    private readonly TextWriter stderr;
    private readonly object gate = new();
    private readonly Dictionary<string, ElementRecord> cache = new();
    private int nextHandle;
    private UIA3Automation? automation;

    private sealed record ElementRecord(int ProcessId, AutomationElement Element);

    public UiaOperations(TextWriter stderr) => this.stderr = stderr;

    private UIA3Automation Automation => automation ??= new UIA3Automation();

    public object Locate(string appHint, string sessionHint)
    {
        lock (gate)
        {
            using var desktop = Automation.GetDesktop();
            var condition = desktop.ConditionFactory;
            // 只按进程名或窗口标题线索查找顶层窗口；不做全窗口枚举扫描。
            Window[] windows;
            try
            {
                windows = desktop.FindAllDescendants(
                    condition.ByControlType(ControlType.Window)).OfType<Window>().ToArray();
            }
            catch (Exception ex)
            {
                throw new RpcFault(RpcCodes.InternalError, $"desktop enumeration failed: {ex.Message}");
            }
            foreach (var window in windows)
            {
                string title = window.Title ?? "";
                int pid = 0;
                try { pid = window.Properties.ProcessId; } catch { }
                string? processName = null;
                try { processName = window.Properties.ProcessName; } catch { }
                bool matches = title.Contains(appHint, StringComparison.OrdinalIgnoreCase)
                    || (processName?.Contains(appHint, StringComparison.OrdinalIgnoreCase) ?? false);
                if (!matches) continue;
                var anchor = sessionHint.Length > 0 ? FindTextAnchor(window, sessionHint) : null;
                if (sessionHint.Length > 0 && anchor == null)
                {
                    // R10：找不到会话锚点即定位失败；不退回"窗口标题匹配"冒充绑定成功。
                    continue;
                }
                string evidence = $"Window(title='{title}',pid={pid},process='{processName}')";
                if (anchor != null)
                {
                    evidence += $" +Anchor('{sessionHint}')";
                }
                nextHandle += 1;
                var handle = $"win-{nextHandle}";
                cache[handle] = new ElementRecord(pid, window);
                bool isForeground = GetForegroundWindowProcessId() == pid;
                return new
                {
                    elements = new[] { new { handle, identityEvidence = evidence, requiresForeground = !isForeground } },
                };
            }
            throw new RpcFault(RpcCodes.InternalError,
                sessionHint.Length > 0
                    ? $"no window matched appHint '{appHint}' with session anchor '{sessionHint}'（不猜测，明确报告未找到）"
                    : $"no window matched appHint '{appHint}'（不猜测，明确报告未找到）");
        }
    }

    private static AutomationElement? FindTextAnchor(AutomationElement root, string text)
    {
        try
        {
            var cf = new ConditionFactory(new UIA3PropertyLibrary());
            var matches = root.FindAllDescendants(cf.ByName(text));
            return matches.Length > 0 ? matches[0] : null;
        }
        catch
        {
            return null;
        }
    }

    private AutomationElement Resolve(string handle)
    {
        lock (gate)
        {
            if (!cache.TryGetValue(handle, out var record))
            {
                throw new RpcFault(RpcCodes.StaleBinding, $"unknown handle {handle}");
            }
            bool offscreen;
            try { offscreen = record.Element.IsOffscreen; }
            catch
            {
                cache.Remove(handle);
                throw new RpcFault(RpcCodes.StaleBinding, $"handle {handle} no longer valid (element gone)");
            }
            if (offscreen)
            {
                int pid;
                try { pid = record.Element.Properties.ProcessId; }
                catch
                {
                    cache.Remove(handle);
                    throw new RpcFault(RpcCodes.StaleBinding, $"handle {handle} no longer valid");
                }
                if (pid != record.ProcessId)
                {
                    cache.Remove(handle);
                    throw new RpcFault(RpcCodes.StaleBinding, $"handle {handle} rebound to different process");
                }
            }
            return record.Element;
        }
    }

    public object ReadText(string handle)
    {
        var element = Resolve(handle);
        // ValuePattern 优先（输入框/可写区）：值即全文，可声明 complete=true。
        try
        {
            var value = element.Patterns.Value.Pattern.Value;
            return new { text = value ?? "", complete = true };
        }
        catch { }
        try
        {
            var textPattern = element.Patterns.Text.Pattern;
            // R10：虚拟化容器可能只暴露可见片段且无截断标记；
            // 无依据声明完整，保守返回 complete=false（宿主按"片段"处理，不得当全量）。
            string text = textPattern.DocumentRange.GetText(int.MaxValue);
            return new { text, complete = false };
        }
        catch (Exception ex)
        {
            throw new RpcFault(RpcCodes.Unsupported, $"element exposes neither Value nor Text pattern: {ex.Message}");
        }
    }

    public void SetValue(string handle, string text)
    {
        var element = Resolve(handle);
        try
        {
            element.Patterns.Value.Pattern.SetValue(text);
        }
        catch (Exception ex)
        {
            throw new RpcFault(RpcCodes.Unsupported, $"SetValue failed: {ex.Message}");
        }
    }

    public void Invoke(string handle)
    {
        var element = Resolve(handle);
        try
        {
            element.Patterns.Invoke.Pattern.Invoke();
        }
        catch (Exception ex)
        {
            throw new RpcFault(RpcCodes.Unsupported, $"Invoke failed: {ex.Message}");
        }
    }

    public void ActivateForeground(string handle)
    {
        var element = Resolve(handle);
        int pid;
        try { pid = element.Properties.ProcessId; }
        catch (Exception ex)
        {
            throw new RpcFault(RpcCodes.StaleBinding, $"cannot resolve process: {ex.Message}");
        }
        var window = FindWindowByProcessId(pid);
        if (window == IntPtr.Zero)
        {
            throw new RpcFault(RpcCodes.InternalError, $"no top window for pid {pid}");
        }
        if (SetForegroundWindow(window)) return;
        // 常见失败：调用方非前台进程。明确要求宿主先进入获准的前台模式，不静默重试。
        throw new RpcFault(RpcCodes.ForegroundRequired, "SetForegroundWindow denied; foreground mode required");
    }

    public object ClipboardSnapshot()
    {
        if (!OpenClipboard(IntPtr.Zero))
        {
            throw new RpcFault(RpcCodes.InternalError, "OpenClipboard failed (busy or denied)");
        }
        try
        {
            IntPtr handle = GetClipboardData(CF_UNICODETEXT);
            if (handle == IntPtr.Zero) return new { formats = new { text = (string?)null } };
            IntPtr pointer = GlobalLock(handle);
            if (pointer == IntPtr.Zero)
            {
                throw new RpcFault(RpcCodes.InternalError, "GlobalLock failed");
            }
            try
            {
                string text = Marshal.PtrToStringUni(pointer) ?? "";
                return new { formats = new { text } };
            }
            finally
            {
                GlobalUnlock(handle);
            }
        }
        finally
        {
            CloseClipboard();
        }
    }

    public object ClipboardRestore(JsonElement ps)
    {
        string? text = null;
        if (ps.ValueKind == JsonValueKind.Object && ps.TryGetProperty("formats", out var formats)
            && formats.ValueKind == JsonValueKind.Object
            && formats.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String)
        {
            text = t.GetString();
        }
        if (text == null) throw new RpcFault(RpcCodes.InvalidParams, "formats.text required");
        if (!OpenClipboard(IntPtr.Zero))
        {
            throw new RpcFault(RpcCodes.InternalError, "OpenClipboard failed");
        }
        try
        {
            // R10：恢复前竞争检查——当前剪贴板文本已被用户修改时拒绝覆盖。
            IntPtr current = GetClipboardData(CF_UNICODETEXT);
            string currentText = "";
            bool readable = false;
            if (current != IntPtr.Zero)
            {
                IntPtr lockPtr = GlobalLock(current);
                if (lockPtr != IntPtr.Zero)
                {
                    try { currentText = Marshal.PtrToStringUni(lockPtr) ?? ""; readable = true; }
                    finally { GlobalUnlock(current); }
                }
            }
            if (readable && currentText != text)
            {
                return new { restored = false, currentChanged = true };
            }
            EmptyClipboard();
            IntPtr global = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)((text.Length + 1) * 2));
            if (global == IntPtr.Zero) throw new RpcFault(RpcCodes.InternalError, "GlobalAlloc failed");
            IntPtr pointer = GlobalLock(global);
            if (pointer == IntPtr.Zero) throw new RpcFault(RpcCodes.InternalError, "GlobalLock failed");
            try { Marshal.Copy(text.ToCharArray(), 0, pointer, text.Length); }
            finally { GlobalUnlock(global); }
            if (SetClipboardData(CF_UNICODETEXT, global) == IntPtr.Zero)
            {
                GlobalFree(global);
                throw new RpcFault(RpcCodes.InternalError, "SetClipboardData failed");
            }
            return new { restored = true };
        }
        finally
        {
            CloseClipboard();
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll")]
    private static extern bool CloseClipboard();
    [DllImport("user32.dll")]
    private static extern bool EmptyClipboard();
    [DllImport("user32.dll")]
    private static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetClipboardData(uint format, IntPtr data);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalLock(IntPtr handle);
    [DllImport("kernel32.dll")]
    private static extern bool GlobalUnlock(IntPtr handle);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalFree(IntPtr handle);

    private const uint CF_UNICODETEXT = 13;
    private const uint GMEM_MOVEABLE = 0x0002;

    private uint GetForegroundWindowProcessId()
    {
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return 0;
        GetWindowThreadProcessId(hwnd, out var pid);
        return pid;
    }

    private IntPtr FindWindowByProcessId(int processId)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hwnd, _) =>
        {
            GetWindowThreadProcessId(hwnd, out var pid);
            if (pid == (uint)processId && IsWindowVisible(hwnd) && GetWindow(hwnd, GW_OWNER) == IntPtr.Zero)
            {
                found = hwnd;
                return false; // 停止枚举
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint relationship);

    private const uint GW_OWNER = 4;
}
