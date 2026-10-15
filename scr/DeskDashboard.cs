// Windows screensaver host: shows the dashboard (http://localhost:7777) full screen via WebView2.
// Args: /s (or none) = run, /c = configure, /p <hwnd> = preview (unsupported, exits).
// Build target is csc.exe of .NET Framework 4 (C# 5), so no newer syntax.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program
{
    const string Url = "http://localhost:7777/";
    const int Port = 7777;
    // Defaults; override with a DeskDashboard.cfg next to the .scr (lines "distro=..." and "script=...").
    static string Distro = "Ubuntu";
    static string ServerScript = "/path/to/desk-dashboard/run-server.sh";

    static void LoadCfg()
    {
        try
        {
            string f = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "DeskDashboard.cfg");
            foreach (string line in File.ReadAllLines(f))
            {
                int i = line.IndexOf('=');
                if (i < 0) continue;
                string k = line.Substring(0, i).Trim().ToLowerInvariant(), v = line.Substring(i + 1).Trim();
                if (k == "distro") Distro = v; else if (k == "script") ServerScript = v;
            }
        }
        catch { }
    }

    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point p);
    [DllImport("user32.dll")] static extern bool LockWorkStation();

    // Windows should lock on resume (ScreenSaverIsSecure=1) but doesn't reliably for third-party .scr: lock explicitly.
    public static void LockNow()
    {
        if (Hold) return;
        try { LockWorkStation(); } catch { }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    static string StateDir
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DeskDashboard"); }
    }

    // "Since you left": when started by idle timeout, that's the moment of last input.
    // When started by hotkey (you were just active), fall back to when the dashboard was last dismissed.
    static long SinceMs()
    {
        long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
        LASTINPUTINFO li = new LASTINPUTINFO();
        li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        long idle = 0;
        if (GetLastInputInfo(ref li)) idle = unchecked((uint)Environment.TickCount - li.dwTime);
        if (idle > 60000) return now - idle;
        try { return long.Parse(File.ReadAllText(Path.Combine(StateDir, "lastexit.txt")).Trim()); } catch { }
        return now - idle;
    }

    public static void RecordExit()
    {
        try
        {
            Directory.CreateDirectory(StateDir);
            long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
            File.WriteAllText(Path.Combine(StateDir, "lastexit.txt"), now.ToString());
        }
        catch { }
    }
    static long since;

    public static bool Hold; // test flag: ignore input for 12s

    [STAThread]
    static void Main(string[] args)
    {
        string mode = args.Length > 0 ? args[0].ToLowerInvariant().Substring(0, Math.Min(2, args[0].Length)) : "/s";
        if (mode == "/p") return;
        if (mode == "/c")
        {
            MessageBox.Show("Desk Dashboard has no settings window.\nEdit config.json in the dashboard folder.", "Desk Dashboard");
            return;
        }
        Hold = Array.IndexOf(args, "/hold") >= 0;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        LoadCfg();
        since = SinceMs();
        EnsureServer();
        Application.Run(new Saver());
    }

    static bool PortOpen()
    {
        try
        {
            using (TcpClient c = new TcpClient())
            {
                IAsyncResult r = c.BeginConnect("127.0.0.1", Port, null, null);
                bool ok = r.AsyncWaitHandle.WaitOne(300) && c.Connected;
                return ok;
            }
        }
        catch { return false; }
    }

    static void EnsureServer()
    {
        if (PortOpen()) return;
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("wsl.exe", "-d " + Distro + " -- " + ServerScript);
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            Process.Start(psi);
        }
        catch { }
        for (int i = 0; i < 40 && !PortOpen(); i++) Thread.Sleep(250);
    }

    // "secondScreen": true in config.json puts sessions on the primary screen and tabs, todos and
    // notifications on the second. Off (or collector unreachable): other screens stay black.
    public static bool SecondScreen()
    {
        try
        {
            using (WebClient c = new WebClient())
                return Regex.IsMatch(c.DownloadString(Url + "config"), "\"secondScreen\"\\s*:\\s*true");
        }
        catch { return false; }
    }

    class Saver : Form
    {
        readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer();
        readonly DateTime started = DateTime.UtcNow;
        Point origin;

        public Saver()
        {
            Rectangle all = Screen.PrimaryScreen.Bounds;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Bounds = all;
            BackColor = Color.Black;
            TopMost = true;
            ShowInTaskbar = false;
            Cursor.Hide();
            GetCursorPos(out origin);

            bool split = Program.SecondScreen();
            Form side = null;
            foreach (Screen s in Screen.AllScreens)
            {
                if (s.Primary) continue;
                Form f = new Form();
                f.FormBorderStyle = FormBorderStyle.None;
                f.StartPosition = FormStartPosition.Manual;
                f.Bounds = s.Bounds;
                f.BackColor = Color.Black;
                f.TopMost = true;
                f.ShowInTaskbar = false;
                if (split && side == null) side = f;
                f.Show();
                FormClosed += delegate { f.Close(); };
            }

            WebView2 wv = AddView(this);
            WebView2 sv = side != null ? AddView(side) : null;
            Load += async delegate
            {
                try
                {
                    string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DeskDashboard");
                    CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, data);
                    await Open(wv, env, Url + "?since=" + since + (sv != null ? "&view=main" : ""));
                    if (sv != null) await Open(sv, env, Url + "?since=" + since + "&view=side");
                }
                catch (Exception ex)
                {
                    File.WriteAllText(Path.Combine(Path.GetTempPath(), "deskdashboard-error.txt"), ex.ToString());
                    Close();
                }
            };

            // WebView2 swallows window messages, so watch input globally by polling.
            poll.Interval = 100;
            poll.Tick += delegate { if (InputDetected()) Close(); };
            poll.Start();
        }

        static WebView2 AddView(Form f)
        {
            WebView2 v = new WebView2();
            v.Dock = DockStyle.Fill;
            v.DefaultBackgroundColor = Color.Black;
            f.Controls.Add(v);
            return v;
        }

        static async System.Threading.Tasks.Task Open(WebView2 v, CoreWebView2Environment env, string url)
        {
            await v.EnsureCoreWebView2Async(env);
            v.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            v.CoreWebView2.Settings.IsStatusBarEnabled = false;
            v.CoreWebView2.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e)
            {
                if (!e.IsSuccess)
                    v.CoreWebView2.NavigateToString("<body style='background:#0e1116;color:#8a93a3;font:24px sans-serif;padding:60px'>Dashboard server not reachable on localhost:7777.</body>");
            };
            v.CoreWebView2.Navigate(url);
        }

        bool InputDetected()
        {
            if ((DateTime.UtcNow - started).TotalMilliseconds < (Program.Hold ? 12000 : 1500)) return false;
            Point p; GetCursorPos(out p);
            if (Math.Abs(p.X - origin.X) + Math.Abs(p.Y - origin.Y) > 12) return true;
            for (int k = 1; k < 255; k++)
                if ((GetAsyncKeyState(k) & 0x8000) != 0) return true;
            return false;
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            Cursor.Show();
            Program.RecordExit();
            Program.LockNow();
            base.OnFormClosed(e);
            Application.Exit();
        }
    }
}
