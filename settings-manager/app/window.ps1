# Window commands for the Settings Manager window, one per line on stdin:
# frame <css width> <css height> <pixel ratio> | min | max | close | drag | size <1-8>
param([string]$Title, [string]$Icon)
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text; using System.Threading;
public static class Win {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct Rect { public int L, T, R, B; }
  struct Point { public int X, Y; }
  struct MonitorInfo { public int Size; public Rect Monitor, Work; public int Flags; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, int flags);
  [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr h, IntPtr r, bool redraw);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, int flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MonitorInfo i);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadImage(IntPtr i, string name, int type, int cx, int cy, int flags);
  [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);

  static int top, side, round;
  static Rect? restore;
  const int MinWidth = 640, MinHeight = 420;

  public static IntPtr Find(string title) {
    var found = IntPtr.Zero;
    EnumWindows((h, l) => {
      var text = new StringBuilder(256); var cls = new StringBuilder(256);
      GetWindowText(h, text, 256); GetClassName(h, cls, 256);
      if (IsWindowVisible(h) && text.ToString() == title && cls.ToString() == "Chrome_WidgetWin_1") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  /** Clips the browser's own title bar and sets the window icon. */
  public static void Frame(IntPtr h, double width, double height, double ratio, string icon) {
    Rect r; GetWindowRect(h, out r);
    side = (int)Math.Round((r.R - r.L - width * ratio) / 2);
    top = (int)Math.Round(r.B - r.T - height * ratio) - side;
    round = (int)(16 * ratio);
    Clip(h);
    for (int kind = 0; kind < 2; kind++) {
      int size = (int)(16 * (1 + kind) * ratio);
      var image = LoadImage(IntPtr.Zero, icon, 1, size, size, 0x10);
      if (image != IntPtr.Zero) SendMessage(h, 0x80, (IntPtr)kind, image);
    }
  }

  static void Clip(IntPtr h) {
    Rect r; GetWindowRect(h, out r);
    int w = r.R - r.L, ht = r.B - r.T;
    SetWindowRgn(h, restore.HasValue ? CreateRectRgn(side, top, w - side, ht - side) : CreateRoundRectRgn(side, top, w - side + 1, ht - side + 1, round, round), true);
  }

  static void Place(IntPtr h, int x, int y, int w, int ht) {
    SetWindowPos(h, IntPtr.Zero, x, y, w, ht, 0x14);
    Clip(h);
  }

  /** Fills the monitor's work area with the page, or puts the window back. */
  public static void Max(IntPtr h) {
    if (restore.HasValue) {
      var r = restore.Value; restore = null;
      Place(h, r.L, r.T, r.R - r.L, r.B - r.T);
      return;
    }
    Rect now; GetWindowRect(h, out now); restore = now;
    var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
    GetMonitorInfo(MonitorFromWindow(h, 2), ref info);
    var a = info.Work;
    Place(h, a.L - side, a.T - top, a.R - a.L + 2 * side, a.B - a.T + top + side);
  }

  /** Moves (edge 0) or resizes the window by one edge (1-8, as WMSZ_*) while the left button is down. */
  public static void Track(IntPtr h, int edge) {
    Point start; GetCursorPos(out start);
    Rect r; GetWindowRect(h, out r);
    if (edge == 0 && restore.HasValue) {
      var old = restore.Value; restore = null;
      int w = old.R - old.L, ht = old.B - old.T;
      int x = start.X - (int)((double)(start.X - r.L) / (r.R - r.L) * w);
      r = new Rect { L = x, T = start.Y - top - 18, R = x + w, B = start.Y - top - 18 + ht };
      Place(h, r.L, r.T, w, ht);
    }
    while ((GetAsyncKeyState(1) & 0x8000) != 0) {
      Point p; GetCursorPos(out p);
      int dx = p.X - start.X, dy = p.Y - start.Y;
      int l = r.L, t = r.T, rt = r.R, b = r.B;
      if (edge == 0) { l += dx; rt += dx; t += dy; b += dy; }
      if (edge == 1 || edge == 4 || edge == 7) l = Math.Min(l + dx, rt - MinWidth);
      if (edge == 2 || edge == 5 || edge == 8) rt = Math.Max(rt + dx, l + MinWidth);
      if (edge == 3 || edge == 4 || edge == 5) t = Math.Min(t + dy, b - MinHeight);
      if (edge == 6 || edge == 7 || edge == 8) b = Math.Max(b + dy, t + MinHeight);
      Place(h, l, t, rt - l, b - t);
      Thread.Sleep(8);
    }
  }
}
'@
[Win]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $cmd, $rest = $line -split ' '
  $rest = @($rest)
  for ($tries = 0; ($h = [Win]::Find($Title)) -eq [IntPtr]::Zero -and $tries -lt 50; $tries++) { Start-Sleep -Milliseconds 100 }
  if ($h -eq [IntPtr]::Zero) { continue }
  switch ($cmd) {
    'frame' { [Win]::Frame($h, [double]$rest[0], [double]$rest[1], [double]$rest[2], $Icon) }
    'min' { [Win]::ShowWindow($h, 6) | Out-Null }
    'max' { [Win]::Max($h) }
    'close' { [Win]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
    'drag' { [Win]::Track($h, 0) }
    'size' { [Win]::Track($h, [int]$rest[0]) }
  }
}
