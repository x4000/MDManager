// AmmShellMenu — tiny Windows helper that pops the real Explorer shell context
// menu for a folder at a screen position, so AMM can show shell extensions
// (TortoiseSVN/TortoiseGit, 7-Zip, "Open with", etc.) that a custom menu can't.
//
// Compiled on demand by AMM's main process with the system csc.exe (no external
// deps). Args: <folderPath> [<screenX> <screenY>].  Exit 0 = menu shown,
// non-zero = could not show (AMM then falls back to its own menu).
//
// It forwards WM_INITMENUPOPUP / WM_DRAWITEM / WM_MEASUREITEM / WM_MENUCHAR to
// IContextMenu2/3 (HandleMenuMsg/2) so shell-extension submenus populate & draw.

using System;
using System.Runtime.InteropServices;

namespace AmmShell
{
    public static class Program
    {
        [STAThread]
        public static int Main(string[] args)
        {
            foreach (var a in args) if (a == "--serve") return Serve();

            // One-shot mode (fallback / testing): <path> [<x> <y>] [probe]
            if (args.Length < 1 || string.IsNullOrEmpty(args[0])) return 2;
            int x, y;
            if (args.Length < 3 || !int.TryParse(args[1], out x) || !int.TryParse(args[2], out y))
            {
                POINT p; GetCursorPos(out p); x = p.X; y = p.Y;
            }
            bool probe = false;
            for (int i = 0; i < args.Length; i++) if (args[i] == "probe") probe = true;
            try { return new ShellMenu().Show(args[0], x, y, probe); }
            catch (Exception e) { Console.Error.WriteLine("EXC: " + e); return 3; }
        }

        // Persistent "warm" mode: one request per stdin line, "x \t y \t path [\t probe]";
        // shows the menu, then writes "DONE <code>" to stdout. Keeping the process (warm
        // CLR + already-loaded shell-extension DLLs) alive makes later right-clicks far
        // faster than spawning a fresh process each time.
        static int Serve()
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                int code;
                try
                {
                    string[] p = line.Trim().TrimStart('﻿').Split('\t');
                    int x, y;
                    if (p.Length < 3 || !int.TryParse(p[0].Trim(), out x) || !int.TryParse(p[1].Trim(), out y)) code = 2;
                    else
                    {
                        bool probe = p.Length > 3 && p[3].Trim() == "probe";
                        code = new ShellMenu().Show(p[2], x, y, probe);
                    }
                }
                catch (Exception e) { Console.Error.WriteLine("EXC: " + e); code = 3; }
                Console.Out.WriteLine("DONE " + code);
                Console.Out.Flush();
            }
            return 0;
        }

        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct CMINVOKECOMMANDINFO
    {
        public int cbSize;
        public int fMask;
        public IntPtr hwnd;
        public IntPtr lpVerb;
        [MarshalAs(UnmanagedType.LPStr)] public string lpParameters;
        [MarshalAs(UnmanagedType.LPStr)] public string lpDirectory;
        public int nShow;
        public int dwHotKey;
        public IntPtr hIcon;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WNDCLASS
    {
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
    }

    [ComImport, Guid("000214E6-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellFolder
    {
        [PreserveSig] int ParseDisplayName(IntPtr h, IntPtr bc, IntPtr name, IntPtr eaten, out IntPtr pidl, IntPtr attr);
        [PreserveSig] int EnumObjects(IntPtr h, int flags, out IntPtr enumer);
        [PreserveSig] int BindToObject(IntPtr pidl, IntPtr bc, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int BindToStorage(IntPtr pidl, IntPtr bc, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int CompareIDs(IntPtr l, IntPtr pidl1, IntPtr pidl2);
        [PreserveSig] int CreateViewObject(IntPtr hwndOwner, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetAttributesOf(uint cidl, [In] IntPtr[] apidl, ref uint rgfInOut);
        [PreserveSig] int GetUIObjectOf(IntPtr hwndOwner, uint cidl, [In, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 1)] IntPtr[] apidl, [In] ref Guid riid, ref uint rgfReserved, out IntPtr ppv);
        [PreserveSig] int GetDisplayNameOf(IntPtr pidl, uint flags, IntPtr name);
        [PreserveSig] int SetNameOf(IntPtr h, IntPtr pidl, IntPtr name, uint flags, out IntPtr ppidlOut);
    }

    [ComImport, Guid("000214E4-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IContextMenu
    {
        [PreserveSig] int QueryContextMenu(IntPtr hMenu, uint indexMenu, uint idFirst, uint idLast, uint flags);
        [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFO ici);
        [PreserveSig] int GetCommandString(IntPtr idCmd, uint type, IntPtr res, IntPtr commandString, int cchMax);
    }

    [ComImport, Guid("000214F4-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IContextMenu2
    {
        [PreserveSig] int QueryContextMenu(IntPtr hMenu, uint indexMenu, uint idFirst, uint idLast, uint flags);
        [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFO ici);
        [PreserveSig] int GetCommandString(IntPtr idCmd, uint type, IntPtr res, IntPtr commandString, int cchMax);
        [PreserveSig] int HandleMenuMsg(uint uMsg, IntPtr wParam, IntPtr lParam);
    }

    [ComImport, Guid("BCFCE0A0-EC17-11D0-8D10-00A0C90F2719"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IContextMenu3
    {
        [PreserveSig] int QueryContextMenu(IntPtr hMenu, uint indexMenu, uint idFirst, uint idLast, uint flags);
        [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFO ici);
        [PreserveSig] int GetCommandString(IntPtr idCmd, uint type, IntPtr res, IntPtr commandString, int cchMax);
        [PreserveSig] int HandleMenuMsg(uint uMsg, IntPtr wParam, IntPtr lParam);
        [PreserveSig] int HandleMenuMsg2(uint uMsg, IntPtr wParam, IntPtr lParam, out IntPtr plResult);
    }

    public class ShellMenu
    {
        delegate IntPtr WndProcDelegate(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

        IContextMenu2 _ctx2;
        IContextMenu3 _ctx3;

        static bool s_classReady;
        static WndProcDelegate s_wndProc; // kept rooted for the process lifetime
        static ShellMenu s_active;        // the instance whose menu is currently up

        const uint TPM_RETURNCMD = 0x0100;
        const uint TPM_RIGHTBUTTON = 0x0002;
        const uint CMF_EXPLORE = 0x0004;
        const uint WM_INITMENUPOPUP = 0x0117;
        const uint WM_DRAWITEM = 0x002B;
        const uint WM_MEASUREITEM = 0x002C;
        const uint WM_MENUCHAR = 0x0120;

        public int Show(string path, int x, int y, bool probe)
        {
            uint attrs = 0;
            IntPtr pidl;
            int hr = SHParseDisplayName(path, IntPtr.Zero, out pidl, 0, out attrs);
            if (hr != 0 || pidl == IntPtr.Zero)
            {
                Console.Error.WriteLine("SHParseDisplayName hr=0x" + hr.ToString("X8") + " path=[" + path + "]");
                return 10;
            }

            IntPtr parentPtr = IntPtr.Zero, childPidl, icmPtr = IntPtr.Zero, hMenu = IntPtr.Zero, hwnd = IntPtr.Zero;
            Guid iidShellFolder = typeof(IShellFolder).GUID;
            Guid iidContextMenu = typeof(IContextMenu).GUID;
            try
            {
                hr = SHBindToParent(pidl, ref iidShellFolder, out parentPtr, out childPidl);
                if (hr != 0 || parentPtr == IntPtr.Zero)
                {
                    Console.Error.WriteLine("SHBindToParent hr=0x" + hr.ToString("X8"));
                    return 11;
                }
                IShellFolder parent = (IShellFolder)Marshal.GetObjectForIUnknown(parentPtr);

                uint reserved = 0;
                hr = parent.GetUIObjectOf(IntPtr.Zero, 1, new[] { childPidl }, ref iidContextMenu, ref reserved, out icmPtr);
                Marshal.ReleaseComObject(parent);
                if (hr != 0 || icmPtr == IntPtr.Zero)
                {
                    Console.Error.WriteLine("GetUIObjectOf hr=0x" + hr.ToString("X8"));
                    return 12;
                }

                IContextMenu ctx = (IContextMenu)Marshal.GetObjectForIUnknown(icmPtr);
                _ctx2 = ctx as IContextMenu2;
                _ctx3 = ctx as IContextMenu3;

                hMenu = CreatePopupMenu();
                hr = ctx.QueryContextMenu(hMenu, 0, 1, 0x7FFF, CMF_EXPLORE);
                int items = GetMenuItemCount(hMenu);
                if (items <= 0) Console.Error.WriteLine("QueryContextMenu hr=0x" + hr.ToString("X8") + " items=0");
                if (items <= 0) { Marshal.ReleaseComObject(ctx); return 13; }

                if (probe) { Marshal.ReleaseComObject(ctx); return 0; }

                hwnd = CreateOwnerWindow();
                ForceForeground(hwnd);

                s_active = this;
                uint cmd;
                try { cmd = TrackPopupMenuEx(hMenu, TPM_RETURNCMD | TPM_RIGHTBUTTON, x, y, hwnd, IntPtr.Zero); }
                finally { s_active = null; }
                if (cmd != 0)
                {
                    CMINVOKECOMMANDINFO ici = new CMINVOKECOMMANDINFO();
                    ici.cbSize = Marshal.SizeOf(typeof(CMINVOKECOMMANDINFO));
                    ici.lpVerb = (IntPtr)(cmd - 1); // MAKEINTRESOURCE(verb offset)
                    ici.nShow = 1; // SW_SHOWNORMAL
                    ctx.InvokeCommand(ref ici);
                }
                Marshal.ReleaseComObject(ctx);
                return 0;
            }
            finally
            {
                if (hMenu != IntPtr.Zero) DestroyMenu(hMenu);
                if (hwnd != IntPtr.Zero) DestroyWindow(hwnd);
                if (icmPtr != IntPtr.Zero) Marshal.Release(icmPtr);
                if (parentPtr != IntPtr.Zero) Marshal.Release(parentPtr);
                Marshal.FreeCoTaskMem(pidl);
            }
        }

        // Register the owner-window class once for the process; in --serve mode many
        // menus are shown over its lifetime, so re-registering per menu would fail.
        static void EnsureClass()
        {
            if (s_classReady) return;
            s_wndProc = StaticWndProc;
            WNDCLASS wc = new WNDCLASS();
            wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(s_wndProc);
            wc.hInstance = GetModuleHandle(null);
            wc.lpszClassName = "AmmShellMenuOwner";
            RegisterClass(ref wc);
            s_classReady = true;
        }

        IntPtr CreateOwnerWindow()
        {
            EnsureClass();
            return CreateWindowEx(0, "AmmShellMenuOwner", "", 0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, GetModuleHandle(null), IntPtr.Zero);
        }

        // A menu shown from a spawned (non-foreground) process won't display
        // unless its thread can take the foreground. Attaching to the current
        // foreground thread's input lets SetForegroundWindow through.
        void ForceForeground(IntPtr hwnd)
        {
            IntPtr fg = GetForegroundWindow();
            uint pid;
            uint fgThread = (fg != IntPtr.Zero) ? GetWindowThreadProcessId(fg, out pid) : 0;
            uint myThread = GetCurrentThreadId();
            bool attached = false;
            if (fgThread != 0 && fgThread != myThread) attached = AttachThreadInput(myThread, fgThread, true);
            SetForegroundWindow(hwnd);
            BringWindowToTop(hwnd);
            if (attached) AttachThreadInput(myThread, fgThread, false);
        }

        static IntPtr StaticWndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
        {
            ShellMenu self = s_active;
            if (self != null && (msg == WM_INITMENUPOPUP || msg == WM_DRAWITEM || msg == WM_MEASUREITEM || msg == WM_MENUCHAR))
            {
                if (self._ctx3 != null) { IntPtr res; self._ctx3.HandleMenuMsg2(msg, wParam, lParam, out res); return res; }
                if (self._ctx2 != null) { self._ctx2.HandleMenuMsg(msg, wParam, lParam); return IntPtr.Zero; }
            }
            return DefWindowProc(hwnd, msg, wParam, lParam);
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SHParseDisplayName(string name, IntPtr bc, out IntPtr pidl, uint sfgaoIn, out uint sfgaoOut);
        [DllImport("shell32.dll")]
        static extern int SHBindToParent(IntPtr pidl, ref Guid riid, out IntPtr ppv, out IntPtr pidlLast);
        [DllImport("user32.dll")] static extern IntPtr CreatePopupMenu();
        [DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr hMenu);
        [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr hMenu);
        [DllImport("user32.dll")] static extern uint TrackPopupMenuEx(IntPtr hMenu, uint flags, int x, int y, IntPtr hwnd, IntPtr tpm);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern ushort RegisterClass(ref WNDCLASS wc);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr CreateWindowEx(int exStyle, string cls, string name, int style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
        [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr GetModuleHandle(string name);
    }
}
