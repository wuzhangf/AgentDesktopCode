using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using Forms = System.Windows.Forms;

namespace AgentLink;

internal sealed class TrayIcon : IDisposable
{
    private const int Callback = 0x8001;
    private const uint Add = 0, Delete = 2, SetVersion = 4;
    private readonly HwndSource source;
    private readonly Icon icon;
    private readonly int taskbarCreated = (int)RegisterWindowMessageW("TaskbarCreated");
    private NotifyData data;
    private bool registered;

    internal event Action? ToggleRequested;
    internal event Action<DrawingPoint>? MenuRequested;

    internal TrayIcon()
    {
        source = new HwndSource(new HwndSourceParameters("Agent Link notification icon")
        {
            WindowStyle = unchecked((int)0x80000000),
            ExtendedWindowStyle = 0x80,
            Width = 1,
            Height = 1,
        });
        using var stream = Application.GetResourceStream(new Uri("pack://application:,,,/Assets/AgentLink.ico"))!.Stream;
        icon = new Icon(stream, Forms.SystemInformation.SmallIconSize);
        data = new NotifyData
        {
            Size = (uint)Marshal.SizeOf<NotifyData>(),
            Window = source.Handle,
            Id = 1,
            Flags = 0x87, // NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP
            CallbackMessage = Callback,
            Icon = icon.Handle,
            Tip = "Agent Link",
        };
        source.AddHook(Message);
        Register();
    }

    private void Register()
    {
        registered = Shell_NotifyIconW(Add, ref data);
        if (!registered) return;
        data.Version = 4;
        Shell_NotifyIconW(SetVersion, ref data);
    }

    internal void EnsureRegistered()
    {
        if (!registered) Register();
    }

    private IntPtr Message(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message == taskbarCreated) Register();
        if (message != Callback) return IntPtr.Zero;
        int action = (int)lParam.ToInt64() & 0xffff;
        if (action is 0x400 or 0x401) // NIN_SELECT / NIN_KEYSELECT
        {
            ToggleRequested?.Invoke();
            handled = true;
        }
        else if (action == 0x007b) // WM_CONTEXTMENU
        {
            var rect = Anchor();
            SetForegroundWindow(source.Handle);
            MenuRequested?.Invoke(new(rect.Left + rect.Width / 2, rect.Top));
            handled = true;
        }
        return IntPtr.Zero;
    }

    private Rectangle Anchor()
    {
        var identifier = new NotifyIdentifier
        {
            Size = (uint)Marshal.SizeOf<NotifyIdentifier>(), Window = source.Handle, Id = data.Id,
        };
        if (Shell_NotifyIconGetRect(ref identifier, out var rect) == 0)
            return Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
        var bounds = Forms.Screen.PrimaryScreen!.WorkingArea;
        return new Rectangle(bounds.Right - 16, bounds.Bottom, 1, 1);
    }

    internal void ShowPanel(Window panel)
    {
        var anchor = Anchor();
        var area = Forms.Screen.FromRectangle(anchor).WorkingArea;
        var hwnd = new WindowInteropHelper(panel).EnsureHandle();
        const uint keepZAndFocus = 0x14;
        // Move the hidden window to the icon's monitor before measuring its DPI.
        SetWindowPos(hwnd, IntPtr.Zero, area.Left, area.Top, 0, 0, keepZAndFocus | 1);
        var dpi = Math.Max(96, GetDpiForWindow(hwnd));
        var scale = dpi / 96.0;
        panel.MaxHeight = Math.Max(80, Math.Min(550, (area.Height - 16) / scale));
        panel.MaxWidth = Math.Max(80, (area.Width - 16) / scale);
        panel.Opacity = 0;
        if (!panel.IsVisible) panel.Show();
        panel.UpdateLayout();
        PositionPanel(panel);
        panel.Opacity = 1;
        SetForegroundWindow(hwnd);
        panel.Activate();
    }

    internal void PositionPanel(Window panel)
    {
        if (!panel.IsVisible) return;
        var anchor = Anchor();
        var area = Forms.Screen.FromRectangle(anchor).WorkingArea;
        var hwnd = new WindowInteropHelper(panel).Handle;
        var scale = Math.Max(96, GetDpiForWindow(hwnd)) / 96.0;
        var width = Math.Min(area.Width, (int)Math.Ceiling(panel.ActualWidth * scale));
        var height = Math.Min(area.Height, (int)Math.Ceiling(panel.ActualHeight * scale));
        var x = anchor.Left + anchor.Width / 2 - width / 2;
        var y = anchor.Top - height - 4;
        if (anchor.Top < area.Top + height / 2) y = anchor.Bottom + 4;
        if (anchor.Right <= area.Left) x = area.Left + 4;
        if (anchor.Left >= area.Right) x = area.Right - width - 4;
        SetWindowPos(hwnd, IntPtr.Zero, Math.Clamp(x, area.Left, area.Right - width),
            Math.Clamp(y, area.Top, area.Bottom - height), 0, 0, 0x15); // no resize, activation or z-order change
    }

    public void Dispose()
    {
        Shell_NotifyIconW(Delete, ref data);
        source.Dispose();
        icon.Dispose();
    }

    internal readonly record struct DrawingPoint(int X, int Y);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NotifyData
    {
        public uint Size;
        public IntPtr Window;
        public uint Id, Flags, CallbackMessage;
        public IntPtr Icon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Tip;
        public uint State, StateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Info;
        public uint Version;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string InfoTitle;
        public uint InfoFlags;
        public Guid Guid;
        public IntPtr BalloonIcon;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NotifyIdentifier
    {
        public uint Size;
        public IntPtr Window;
        public uint Id;
        public Guid Guid;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool Shell_NotifyIconW(uint message, ref NotifyData data);
    [DllImport("shell32.dll")]
    private static extern int Shell_NotifyIconGetRect(ref NotifyIdentifier data, out Rect rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint RegisterWindowMessageW(string name);
    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
}
