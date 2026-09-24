<#
  --widget-flash-test için ekran örnekleyici (test/widget-flash-test.js başlatıyor).

  Ekranın fiziksel bir bölgesini GDI BitBlt ile kare hızında okuyup her karede düğmenin
  RENGİNDEKİ pikselleri sayıyor. DWM'in birleştirdiği görüntü okunuyor, yani pencerenin
  nerede olduğu değil kullanıcının GÖRDÜĞÜ ölçülüyor: webview yeni pencere şekline geç
  çizdiğinde düğme bir an yanlış yerde görünürse o kare yakalanıyor.

  Başlamadan önce TABAN alınıyor: bölgede zaten o renkte olan pikseller (masaüstündeki
  mavi bir şey) sonradan sayılmıyor. Merkez ve sınır kutusu YOĞUN satır/sütunlardan
  (en az 8 piksel) hesaplanıyor; başıboş birkaç piksel konumu sürüklemesin.

  Kullanım: powershell -NoProfile -ExecutionPolicy Bypass -File widget-flash-sampler.ps1 X Y W H R G B
  stdout:  READY                                taban alındı, örnekleme başladı
           F t n cx cy top bottom left right    bir kare. t: ms (örnekleyicinin saati),
                                                n: piksel sayısı, konumlar bölgeye göreli
                                                fiziksel piksel; görünmüyorsa '-'
           M t i                                stdin'den gelen 'M i' işaretinin anı
           END
  stdin:   'M i' işaret, 'Q' bitir.

  İşaretler örnekleyicinin KENDİ saatiyle damgalanıyor: iki süreç arasında saat eşlemeye
  gerek yok, kareler ve adımlar aynı eksende.
#>
param([int]$X, [int]$Y, [int]$W, [int]$H, [int]$R, [int]$G, [int]$B)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

public static class WidgetFlashSampler
{
    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFOHEADER
    {
        public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes;
        public ushort biBitCount; public uint biCompression; public uint biSizeImage;
        public int biXPelsPerMeter; public int biYPelsPerMeter; public uint biClrUsed; public uint biClrImportant;
    }

    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);

    const uint SRCCOPY = 0x00CC0020, CAPTUREBLT = 0x40000000;
    const int DENSE = 8;   // düğme ~48 px: gövdesindeki her satır/sütunda en az bu kadar piksel var
    const int TOL = 40;    // kanal başına renk toleransı

    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    static readonly object OutLock = new object();

    static void Emit(string line)
    {
        lock (OutLock) { Console.Out.WriteLine(line); Console.Out.Flush(); }
    }

    public static void Run(int x, int y, int w, int h, int r, int g, int b)
    {
        var clock = Stopwatch.StartNew();
        var stop = new ManualResetEvent(false);
        var ready = new ManualResetEvent(false);

        var worker = new Thread(() =>
        {
            // Ölçekli monitörde koordinatlar sanallaştırılmasın: fiziksel piksel iste.
            try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { }
            IntPtr screen = GetDC(IntPtr.Zero);
            IntPtr mem = CreateCompatibleDC(screen);
            var bi = new BITMAPINFOHEADER { biSize = 40, biWidth = w, biHeight = -h, biPlanes = 1, biBitCount = 32 };
            IntPtr bits;
            IntPtr dib = CreateDIBSection(screen, ref bi, 0, out bits, IntPtr.Zero, 0);
            IntPtr old = SelectObject(mem, dib);
            var buf = new byte[w * h * 4];
            var baseline = new bool[w * h];
            var rows = new int[h];
            var cols = new int[w];

            Func<bool> grab = () =>
            {
                bool ok = BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT);
                GdiFlush();
                if (ok) Marshal.Copy(bits, buf, 0, buf.Length);
                return ok;
            };
            Func<int, bool> isBtn = o =>
                Math.Abs(buf[o + 2] - r) <= TOL && Math.Abs(buf[o + 1] - g) <= TOL && Math.Abs(buf[o] - b) <= TOL;

            if (grab())
                for (int i = 0; i < w * h; i++) baseline[i] = isBtn(i * 4);
            ready.Set();

            while (!stop.WaitOne(0))
            {
                if (grab())
                {
                    Array.Clear(rows, 0, h);
                    Array.Clear(cols, 0, w);
                    int n = 0;
                    for (int yy = 0, i = 0; yy < h; yy++)
                        for (int xx = 0; xx < w; xx++, i++)
                            if (!baseline[i] && isBtn(i * 4)) { rows[yy]++; cols[xx]++; n++; }

                    double sx = 0, nx = 0, sy = 0, ny = 0;
                    int left = -1, right = -1, top = -1, bottom = -1;
                    for (int xx = 0; xx < w; xx++)
                        if (cols[xx] >= DENSE) { sx += xx * (double)cols[xx]; nx += cols[xx]; if (left < 0) left = xx; right = xx; }
                    for (int yy = 0; yy < h; yy++)
                        if (rows[yy] >= DENSE) { sy += yy * (double)rows[yy]; ny += rows[yy]; if (top < 0) top = yy; bottom = yy; }

                    string t = clock.Elapsed.TotalMilliseconds.ToString("F1", Inv);
                    if (nx > 0 && ny > 0)
                        Emit(string.Format(Inv, "F {0} {1} {2:F1} {3:F1} {4} {5} {6} {7}", t, n, sx / nx, sy / ny, top, bottom, left, right));
                    else
                        Emit(string.Format(Inv, "F {0} {1} - - - - - -", t, n));
                }
                // Uyku yok: BitBlt DWM'den okumayı kendisi bekletiyor (~7 ms). `Sleep(1)` kare
                // hızını ~140'tan ~95/sn'ye düşürüyordu; 120 Hz ekranda kare kaçardı.
            }
            SelectObject(mem, old);
            DeleteObject(dib);
            DeleteDC(mem);
            ReleaseDC(IntPtr.Zero, screen);
        });
        worker.IsBackground = true;
        worker.Start();
        ready.WaitOne();
        Emit("READY");

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (line.StartsWith("M "))
                Emit("M " + clock.Elapsed.TotalMilliseconds.ToString("F1", Inv) + " " + line.Substring(2).Trim());
            else if (line.Trim() == "Q")
                break;
        }
        stop.Set();
        worker.Join(2000);
        Emit("END");
    }
}
'@

[WidgetFlashSampler]::Run($X, $Y, $W, $H, $R, $G, $B)
