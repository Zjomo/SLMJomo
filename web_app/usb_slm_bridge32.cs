// ============================================================================
// usb_slm_bridge32.cs — Hamamatsu LCOS-SLM 32 位 SDK 桥接宿主
// ============================================================================
// 作用：在 32 位进程中加载 hpkSLMdaLV.dll（32 位 stdcall），为 64 位 Python
// 后端提供 stdio JSON 行协议桥接。编译: csc /platform:x86 /out:usb_slm_bridge32.exe
//
// 协议（每行一个 JSON 对象，UTF-8）:
//   请求: {"id":N,"op":"<name>",...参数}
//   响应: {"id":N,"ok":true,...结果}  或  {"id":N,"ok":false,"error":"..."}
// 特殊 op:
//   hello      -> {"ok":true,"arch":32,"exports":[...18 个导出名...]}
//   quit       -> 进程退出（响应 ok 后退出）
// 大块二进制（图像 1302528 字节）以 base64 传输，字段名 data_b64 / 返回 image_b64。
// 所有 SDK 函数返回值约定: 1=成功 0=失败（手册），非 1 视为调用失败。
// ============================================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace UsbSlmBridge
{
    public static class Bridge
    {
        // ---------- Win32 ----------
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr LoadLibrary(string path);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetProcAddress(IntPtr h, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool FreeLibrary(IntPtr h);

        // ---------- SDK 委托（32 位 stdcall） ----------
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate int OpenDevDelegate(byte[] idList, int size);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate int CloseDevDelegate(byte[] idList, int size);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate int CheckHeadSerialDelegate(byte bid, StringBuilder serial, int charSize);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate int WriteFMemArrayDelegate(byte bid, byte[] data, int size, uint xp, uint yp, uint slot);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate int WriteFMemBMPPathDelegate(byte bid, string path, uint slot);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate int ChangeDispSlotDelegate(byte bid, uint slot);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate int CheckTempDelegate(byte bid, ref double headTemp, ref double cbTemp);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate int ReadImageSlotDelegate(byte bid, uint size, uint xp, uint yp, uint slot, byte[] outData);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate int ReadImageDelegate(byte bid, uint size, uint xp, uint yp, byte[] outData);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate int ModeSelectDelegate(byte bid, byte mode);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate int GetU32Delegate(byte bid, ref uint value);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate void RebootDelegate(byte bid);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate int UploadSdToFMemDelegate(byte bid, uint sdSlot, uint fmemSlot);

        private const int ArraySize = 1272 * 1024;
        private static IntPtr _lib = IntPtr.Zero;
        private static string _dllPath;
        private static readonly string[] ExportNames = {
            "Open_Dev", "Close_Dev", "Check_HeadSerial", "Write_FMemArray",
            "Write_FMemBMPPath", "Change_DispSlot", "Check_Temp", "Check_FMem_Slot",
            "Mode_Select", "Check_Disp_IMG", "Check_LED", "Mode_Check", "Check_IO",
            "Reboot", "Write_SDBMPPath", "Write_SDArray", "Check_SD_Slot",
            "Upload_from_SD_to_FMem"
        };

        private static IntPtr Proc(string name)
        {
            IntPtr p = GetProcAddress(_lib, name);
            if (p == IntPtr.Zero)
                throw new Exception("DLL 导出缺失: " + name);
            return p;
        }

        private static void EnsureLoaded(string dllPath, string searchDirs)
        {
            if (_lib != IntPtr.Zero) return;
            // 把 LVRT 目录与 DLL 目录前置到 PATH（供 LVRT 及 hpkSLMda.dll 解析）
            try
            {
                string old = Environment.GetEnvironmentVariable("PATH") ?? "";
                var parts = new List<string>();
                if (!string.IsNullOrEmpty(searchDirs))
                    parts.AddRange(searchDirs.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries));
                parts.Add(Path.GetDirectoryName(Path.GetFullPath(dllPath)) ?? ".");
                parts.Insert(0, old);
                Environment.SetEnvironmentVariable("PATH", string.Join(";", parts.ToArray()));
            }
            catch { }
            _dllPath = dllPath;
            _lib = LoadLibrary(dllPath);
            if (_lib == IntPtr.Zero)
                throw new Exception("LoadLibrary 失败 Win32Error=" + Marshal.GetLastWin32Error() + " path=" + dllPath);
        }

        // ---------- 单个 op 实现 ----------
        private static Dictionary<string, object> Handle(Dictionary<string, object> req)
        {
            string op = Str(req, "op");
            switch (op)
            {
                case "hello":
                {
                    var r = Ok(req);
                    r["arch"] = IntPtr.Size * 8;
                    r["exports"] = ExportNames;
                    return r;
                }
                case "load":
                {
                    EnsureLoaded(Str(req, "dll_path"), Str(req, "search_dirs"));
                    var r = Ok(req);
                    r["loaded"] = true;
                    return r;
                }
                case "quit":
                {
                    return Ok(req);
                }
                case "open_dev":
                {
                    EnsureLoaded(Str(req, "dll_path"), Str(req, "search_dirs"));
                    int probe = Int_(req, "probe", 8);
                    var d = (OpenDevDelegate)Marshal.GetDelegateForFunctionPointer(Proc("Open_Dev"), typeof(OpenDevDelegate));
                    byte[] buf = new byte[Math.Max(1, probe)];
                    int n = d(buf, probe);
                    if (n < 0) throw new Exception("Open_Dev 返回 " + n);
                    var devices = new List<int>();
                    for (int i = 0; i < Math.Min(n, probe); i++) devices.Add(buf[i]);
                    var r = Ok(req);
                    r["devices"] = devices;
                    return r;
                }
                case "close_dev":
                {
                    var bids = IntList(req, "bids");
                    var d = (CloseDevDelegate)Marshal.GetDelegateForFunctionPointer(Proc("Close_Dev"), typeof(CloseDevDelegate));
                    byte[] buf = new byte[Math.Max(1, bids.Count)];
                    for (int i = 0; i < bids.Count; i++) buf[i] = (byte)bids[i];
                    int rv = d(buf, bids.Count);
                    if (rv != 1) throw new Exception("Close_Dev 返回 " + rv);
                    return Ok(req);
                }
                case "check_head_serial":
                {
                    var d = (CheckHeadSerialDelegate)Marshal.GetDelegateForFunctionPointer(Proc("Check_HeadSerial"), typeof(CheckHeadSerialDelegate));
                    var sb = new StringBuilder(32);
                    int rv = d((byte)Int_(req, "bid", 0), sb, 11);
                    if (rv != 1) throw new Exception("Check_HeadSerial 返回 " + rv);
                    var r = Ok(req);
                    r["serial"] = sb.ToString();
                    return r;
                }
                case "write_fmem_array":
                case "write_sd_array":
                {
                    bool fmem = op == "write_fmem_array";
                    var d = (WriteFMemArrayDelegate)Marshal.GetDelegateForFunctionPointer(
                        Proc(fmem ? "Write_FMemArray" : "Write_SDArray"), typeof(WriteFMemArrayDelegate));
                    byte[] data = Convert.FromBase64String(Str(req, "data_b64"));
                    int rv = d((byte)Int_(req, "bid", 0), data, data.Length,
                               (uint)Int_(req, "x", 1272), (uint)Int_(req, "y", 1024),
                               (uint)Int_(req, "slot", 0));
                    if (rv != 1) throw new Exception((fmem ? "Write_FMemArray" : "Write_SDArray") + " 返回 " + rv);
                    return Ok(req);
                }
                case "write_fmem_bmp_path":
                case "write_sd_bmp_path":
                {
                    bool fmem = op == "write_fmem_bmp_path";
                    var d = (WriteFMemBMPPathDelegate)Marshal.GetDelegateForFunctionPointer(
                        Proc(fmem ? "Write_FMemBMPPath" : "Write_SDBMPPath"), typeof(WriteFMemBMPPathDelegate));
                    int rv = d((byte)Int_(req, "bid", 0), Str(req, "path"), (uint)Int_(req, "slot", 0));
                    if (rv != 1) throw new Exception((fmem ? "Write_FMemBMPPath" : "Write_SDBMPPath") + " 返回 " + rv);
                    return Ok(req);
                }
                case "change_disp_slot":
                {
                    var d = (ChangeDispSlotDelegate)Marshal.GetDelegateForFunctionPointer(Proc("Change_DispSlot"), typeof(ChangeDispSlotDelegate));
                    int rv = d((byte)Int_(req, "bid", 0), (uint)Int_(req, "slot", 0));
                    if (rv != 1) throw new Exception("Change_DispSlot 返回 " + rv);
                    return Ok(req);
                }
                case "check_temp":
                {
                    var d = (CheckTempDelegate)Marshal.GetDelegateForFunctionPointer(Proc("Check_Temp"), typeof(CheckTempDelegate));
                    double head = 0, cb = 0;
                    int rv = d((byte)Int_(req, "bid", 0), ref head, ref cb);
                    if (rv != 1) throw new Exception("Check_Temp 返回 " + rv);
                    var r = Ok(req);
                    r["head_temp"] = head;
                    r["cb_temp"] = cb;
                    return r;
                }
                case "check_fmem_slot":
                case "check_sd_slot":
                case "check_disp_img":
                {
                    byte[] outData = new byte[ArraySize];
                    int rv;
                    if (op == "check_disp_img")
                    {
                        var d = (ReadImageDelegate)Marshal.GetDelegateForFunctionPointer(Proc("Check_Disp_IMG"), typeof(ReadImageDelegate));
                        rv = d((byte)Int_(req, "bid", 0), (uint)ArraySize, 1272, 1024, outData);
                    }
                    else
                    {
                        var d = (ReadImageSlotDelegate)Marshal.GetDelegateForFunctionPointer(
                            Proc(op == "check_fmem_slot" ? "Check_FMem_Slot" : "Check_SD_Slot"), typeof(ReadImageSlotDelegate));
                        rv = d((byte)Int_(req, "bid", 0), (uint)ArraySize, 1272, 1024,
                               (uint)Int_(req, "slot", 0), outData);
                    }
                    if (rv != 1) throw new Exception(op + " 返回 " + rv);
                    var r = Ok(req);
                    r["image_b64"] = Convert.ToBase64String(outData);
                    return r;
                }
                case "mode_select":
                {
                    var d = (ModeSelectDelegate)Marshal.GetDelegateForFunctionPointer(Proc("Mode_Select"), typeof(ModeSelectDelegate));
                    int rv = d((byte)Int_(req, "bid", 0), (byte)Int_(req, "mode", 0));
                    if (rv != 1) throw new Exception("Mode_Select 返回 " + rv);
                    return Ok(req);
                }
                case "mode_check":
                {
                    var d = (GetU32Delegate)Marshal.GetDelegateForFunctionPointer(Proc("Mode_Check"), typeof(GetU32Delegate));
                    uint v = 0;
                    int rv = d((byte)Int_(req, "bid", 0), ref v);
                    if (rv != 1) throw new Exception("Mode_Check 返回 " + rv);
                    var r = Ok(req);
                    r["value"] = v;
                    return r;
                }
                case "check_led":
                {
                    var d = (GetU32Delegate)Marshal.GetDelegateForFunctionPointer(Proc("Check_LED"), typeof(GetU32Delegate));
                    uint v = 0;
                    int rv = d((byte)Int_(req, "bid", 0), ref v);
                    if (rv != 1) throw new Exception("Check_LED 返回 " + rv);
                    var r = Ok(req);
                    r["value"] = v;
                    return r;
                }
                case "check_io":
                {
                    var d = (GetU32Delegate)Marshal.GetDelegateForFunctionPointer(Proc("Check_IO"), typeof(GetU32Delegate));
                    uint v = 0;
                    int rv = d((byte)Int_(req, "bid", 0), ref v);
                    if (rv != 1) throw new Exception("Check_IO 返回 " + rv);
                    var r = Ok(req);
                    r["value"] = v;
                    return r;
                }
                case "reboot":
                {
                    var d = (RebootDelegate)Marshal.GetDelegateForFunctionPointer(Proc("Reboot"), typeof(RebootDelegate));
                    d((byte)Int_(req, "bid", 0));
                    return Ok(req);
                }
                case "upload_sd_to_fmem":
                {
                    var d = (UploadSdToFMemDelegate)Marshal.GetDelegateForFunctionPointer(Proc("Upload_from_SD_to_FMem"), typeof(UploadSdToFMemDelegate));
                    int rv = d((byte)Int_(req, "bid", 0), (uint)Int_(req, "sd_slot", 0), (uint)Int_(req, "fmem_slot", 0));
                    if (rv != 1) throw new Exception("Upload_from_SD_to_FMem 返回 " + rv);
                    return Ok(req);
                }
                default:
                    throw new Exception("未知 op: " + op);
            }
        }

        // ---------- JSON 小工具（C# 2.0 风格，避免依赖 System.Json） ----------
        private static string Str(Dictionary<string, object> d, string k)
        {
            object v; if (d.TryGetValue(k, out v) && v != null) return v.ToString();
            return "";
        }
        private static int Int_(Dictionary<string, object> d, string k, int def)
        {
            object v; int n;
            if (d.TryGetValue(k, out v) && v != null && int.TryParse(v.ToString(), out n)) return n;
            return def;
        }
        private static List<int> IntList(Dictionary<string, object> d, string k)
        {
            var outp = new List<int>();
            object v;
            if (d.TryGetValue(k, out v) && v != null && v is object[])
            {
                object[] arr = (object[])v;
                foreach (object e in arr) { int n; if (int.TryParse(e.ToString(), out n)) outp.Add(n); }
            }
            return outp;
        }

        private static Dictionary<string, object> Ok(Dictionary<string, object> req)
        {
            var r = new Dictionary<string, object>();
            object id; req.TryGetValue("id", out id);
            r["id"] = id;
            r["ok"] = true;
            return r;
        }

        // ---------- 主循环：stdin JSON 行 -> stdout JSON 行 ----------
        public static int Main(string[] args)
        {
            var stdin = Console.In;
            var stdout = Console.Out;
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                bool quit = false;
                Dictionary<string, object> resp;
                try
                {
                    var req = MiniJson.Parse(line) as Dictionary<string, object>;
                    if (req == null) throw new Exception("非法请求");
                    resp = Handle(req);
                    if (Str(req, "op") == "quit") quit = true;
                }
                catch (Exception ex)
                {
                    resp = new Dictionary<string, object>();
                    resp["id"] = null;
                    resp["ok"] = false;
                    resp["error"] = ex.Message;
                }
                stdout.WriteLine(MiniJson.Write(resp));
                stdout.Flush();
                if (quit) break;
            }
            if (_lib != IntPtr.Zero) { try { FreeLibrary(_lib); } catch { } }
            return 0;
        }

        // ---------- 极简 JSON 解析/序列化（值类型: 数字/字符串/bool/null/数组/对象） ----------
        public static class MiniJson
        {
            public static object Parse(string s)
            {
                int pos = 0;
                object v = ParseValue(s, ref pos);
                return v;
            }

            private static object ParseValue(string s, ref int pos)
            {
                SkipWs(s, ref pos);
                if (pos >= s.Length) throw new Exception("JSON 截断");
                char c = s[pos];
                if (c == '{') return ParseObj(s, ref pos);
                if (c == '[') return ParseArr(s, ref pos);
                if (c == '"') return ParseStr(s, ref pos);
                if (c == 't') { Expect(s, ref pos, "true"); return (object)true; }
                if (c == 'f') { Expect(s, ref pos, "false"); return (object)false; }
                if (c == 'n') { Expect(s, ref pos, "null"); return null; }
                return ParseNum(s, ref pos);
            }

            private static void SkipWs(string s, ref int pos)
            {
                while (pos < s.Length && (s[pos] == ' ' || s[pos] == '\t' || s[pos] == '\r' || s[pos] == '\n')) pos++;
            }
            private static void Expect(string s, ref int pos, string lit)
            {
                if (s.Substring(pos, lit.Length) != lit) throw new Exception("JSON 语法错误 @" + pos);
                pos += lit.Length;
            }

            private static Dictionary<string, object> ParseObj(string s, ref int pos)
            {
                var d = new Dictionary<string, object>();
                pos++; // {
                SkipWs(s, ref pos);
                if (pos < s.Length && s[pos] == '}') { pos++; return d; }
                while (true)
                {
                    SkipWs(s, ref pos);
                    string key = ParseStr(s, ref pos);
                    SkipWs(s, ref pos);
                    if (s[pos] != ':') throw new Exception("JSON 缺冒号");
                    pos++;
                    d[key] = ParseValue(s, ref pos);
                    SkipWs(s, ref pos);
                    if (s[pos] == ',') { pos++; continue; }
                    if (s[pos] == '}') { pos++; return d; }
                    throw new Exception("JSON 对象语法错误");
                }
            }

            private static List<object> ParseArr(string s, ref int pos)
            {
                var l = new List<object>();
                pos++; // [
                SkipWs(s, ref pos);
                if (pos < s.Length && s[pos] == ']') { pos++; return l; }
                while (true)
                {
                    l.Add(ParseValue(s, ref pos));
                    SkipWs(s, ref pos);
                    if (s[pos] == ',') { pos++; continue; }
                    if (s[pos] == ']') { pos++; return l; }
                    throw new Exception("JSON 数组语法错误");
                }
            }

            private static string ParseStr(string s, ref int pos)
            {
                var sb = new StringBuilder();
                pos++; // "
                while (pos < s.Length)
                {
                    char c = s[pos++];
                    if (c == '"') return sb.ToString();
                    if (c == '\\')
                    {
                        char e = s[pos++];
                        switch (e)
                        {
                            case 'n': sb.Append('\n'); break;
                            case 't': sb.Append('\t'); break;
                            case 'r': sb.Append('\r'); break;
                            case 'b': sb.Append('\b'); break;
                            case 'f': sb.Append('\f'); break;
                            case 'u':
                                sb.Append((char)Convert.ToInt32(s.Substring(pos, 4), 16));
                                pos += 4;
                                break;
                            default: sb.Append(e); break;
                        }
                    }
                    else sb.Append(c);
                }
                throw new Exception("字符串未闭合");
            }

            private static object ParseNum(string s, ref int pos)
            {
                int start = pos;
                while (pos < s.Length && "-+.0123456789eE".IndexOf(s[pos]) >= 0) pos++;
                string tok = s.Substring(start, pos - start);
                long l;
                if (long.TryParse(tok, out l)) return (object)l;
                return double.Parse(tok, System.Globalization.CultureInfo.InvariantCulture);
            }

            public static string Write(object v)
            {
                var sb = new StringBuilder();
                WriteValue(sb, v);
                return sb.ToString();
            }

            private static void WriteValue(StringBuilder sb, object v)
            {
                if (v == null) { sb.Append("null"); return; }
                if (v is bool) { sb.Append((bool)v ? "true" : "false"); return; }
                if (v is string) { WriteStr(sb, (string)v); return; }
                if (v is int || v is long || v is short || v is byte) { sb.Append(v.ToString()); return; }
                if (v is double || v is float)
                {
                    sb.Append(Convert.ToDouble(v).ToString("R", System.Globalization.CultureInfo.InvariantCulture));
                    return;
                }
                if (v is Dictionary<string, object>)
                {
                    sb.Append('{');
                    bool first = true;
                    foreach (var kv in (Dictionary<string, object>)v)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        WriteStr(sb, kv.Key);
                        sb.Append(':');
                        WriteValue(sb, kv.Value);
                    }
                    sb.Append('}');
                    return;
                }
                if (v is System.Collections.IEnumerable)
                {
                    sb.Append('[');
                    bool first = true;
                    foreach (object e in (System.Collections.IEnumerable)v)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        WriteValue(sb, e);
                    }
                    sb.Append(']');
                    return;
                }
                WriteStr(sb, v.ToString());
            }

            private static void WriteStr(StringBuilder sb, string s)
            {
                sb.Append('"');
                foreach (char c in s)
                {
                    switch (c)
                    {
                        case '"': sb.Append("\\\""); break;
                        case '\\': sb.Append("\\\\"); break;
                        case '\n': sb.Append("\\n"); break;
                        case '\r': sb.Append("\\r"); break;
                        case '\t': sb.Append("\\t"); break;
                        default:
                            if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                            else sb.Append(c);
                            break;
                    }
                }
                sb.Append('"');
            }
        }
    }
}
