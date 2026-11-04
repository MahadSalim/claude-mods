# Opens the Settings Manager page in a WebView2 window that has no native title bar.
# The page sends window commands with chrome.webview.postMessage: min | max | close | size <1-8>
param([string]$Url, [string]$Icon)
$sdk = Join-Path $PSScriptRoot 'webview2'
$dlls = "$sdk\Microsoft.Web.WebView2.Core.dll", "$sdk\Microsoft.Web.WebView2.WinForms.dll"
Add-Type -Path $dlls
Add-Type -ReferencedAssemblies (@('System.Windows.Forms', 'System.Drawing') + $dlls) @'
using System; using System.Drawing; using System.Runtime.InteropServices; using System.Windows.Forms;
using Microsoft.Web.WebView2.Core; using Microsoft.Web.WebView2.WinForms;

public class Host : Form {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int i, uint dpi);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool ReleaseCapture();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, int flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibrary(string path);

  readonly WebView2 view = new WebView2();

  Host(string url, string title, string icon, string data) {
    float scale = GetDpiForSystem() / 96f;
    Text = title;
    Icon = new Icon(icon);
    BackColor = Color.FromArgb(0x1e, 0x1e, 0x1e);
    Size = new Size((int)(1120 * scale), (int)(780 * scale));
    MinimumSize = new Size((int)(640 * scale), (int)(420 * scale));
    StartPosition = FormStartPosition.CenterScreen;
    view.Dock = DockStyle.Fill;
    view.DefaultBackgroundColor = BackColor;
    view.CreationProperties = new CoreWebView2CreationProperties { UserDataFolder = data };
    view.CoreWebView2InitializationCompleted += (s, e) => {
      if (!e.IsSuccess) { MessageBox.Show(e.InitializationException.Message, title); Close(); return; }
      view.CoreWebView2.Settings.IsNonClientRegionSupportEnabled = true;
      view.CoreWebView2.WebMessageReceived += (s2, m) => Run(m.TryGetWebMessageAsString());
      view.CoreWebView2.Navigate(url);
    };
    Controls.Add(view);
    view.EnsureCoreWebView2Async();
  }

  void Run(string command) {
    var parts = command.Split(' ');
    if (parts[0] == "min") WindowState = FormWindowState.Minimized;
    if (parts[0] == "max") WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
    if (parts[0] == "close") Close();
    if (parts[0] == "size") { ReleaseCapture(); SendMessage(Handle, 0xA1, (IntPtr)(9 + int.Parse(parts[1])), IntPtr.Zero); }
  }

  protected override void OnShown(EventArgs e) {
    ShowWindow(Handle, 5);
    base.OnShown(e);
  }

  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, 0x27);
  }

  /** Makes the client area cover the title bar, and keeps it on screen when maximized. */
  protected override void WndProc(ref Message m) {
    if (m.Msg != 0x83 || m.WParam == IntPtr.Zero) { base.WndProc(ref m); return; }
    int top = Marshal.ReadInt32(m.LParam, 4);
    base.WndProc(ref m);
    uint dpi = GetDpiForWindow(m.HWnd);
    Marshal.WriteInt32(m.LParam, 4, top + (IsZoomed(m.HWnd) ? GetSystemMetricsForDpi(33, dpi) + GetSystemMetricsForDpi(92, dpi) : 0));
    m.Result = IntPtr.Zero;
  }

  public static void Start(string url, string title, string icon, string loader, string data) {
    SetProcessDpiAwarenessContext((IntPtr)(-4));
    LoadLibrary(loader);
    Application.Run(new Host(url, title, icon, data));
  }
}
'@
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
[Host]::Start($Url, 'Settings Manager', $Icon, "$sdk\$arch\WebView2Loader.dll", "$env:LOCALAPPDATA\claude-mods\settings-manager")
