// Shortscu — masaüstü kabuğu.
// Yerel sunucuyu başlatır ve arayüzü bir pencerede açar. İnternet gerekmez
// (yalnızca ilk dışa aktarmada video motoru bir kez indirilir).
const { app, BrowserWindow, shell, dialog, Menu, screen, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const KOK = path.join(__dirname, "..");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let pencere = null;
  let sunucu = null;

  app.on("second-instance", () => {
    if (pencere) {
      if (pencere.isMinimized()) pencere.restore();
      pencere.focus();
    }
  });

  // ---- pencere durumu: kapatıldığı boyut, konum ve tam ekran hâliyle açılır
  const durumYolu = () => path.join(app.getPath("userData"), "pencere.json");
  const durumOku = () => {
    try {
      const d = JSON.parse(fs.readFileSync(durumYolu(), "utf8"));
      // ekran değiştiyse (monitör çıkarıldıysa) görünür bir yere al
      const gorunur = screen.getAllDisplays().some((e) => {
        const a = e.workArea;
        return d.x + 80 < a.x + a.width && d.x + d.width - 80 > a.x && d.y + 40 < a.y + a.height && d.y + 20 > a.y - 10;
      });
      if (!gorunur) return { width: d.width, height: d.height, maximized: d.maximized, fullscreen: d.fullscreen };
      return d;
    } catch {
      return null;
    }
  };
  let durumZaman = null;
  const durumYaz = (p) => {
    if (!p || p.isDestroyed()) return;
    const b = p.getNormalBounds();
    const veri = { ...b, maximized: p.isMaximized(), fullscreen: p.isFullScreen() };
    try {
      fs.writeFileSync(durumYolu(), JSON.stringify(veri));
    } catch {}
  };
  const durumPlanla = (p) => {
    clearTimeout(durumZaman);
    durumZaman = setTimeout(() => durumYaz(p), 400);
  };

  const baslat = async () => {
    // video motoru (Chrome) indirildiğinde buraya kaydedilsin: yazılabilir bir klasör
    const motor = path.join(app.getPath("userData"), "motor");
    fs.mkdirSync(motor, { recursive: true });
    if (!fs.existsSync(path.join(motor, "package.json"))) fs.writeFileSync(path.join(motor, "package.json"), '{ "name": "studyo-motor", "private": true }');
    process.chdir(motor);

    // eski sürümün klasörünü yeni ada taşı
    const veriKok = path.join(app.getPath("documents"), "Shortscu");
    const eski = path.join(app.getPath("documents"), "HicMerakStudyo");
    try {
      if (!fs.existsSync(veriKok) && fs.existsSync(eski)) fs.renameSync(eski, veriKok);
    } catch {}

    const { baslat: sunucuBaslat } = await import(pathToFileURL(path.join(KOK, "server", "sunucu.mjs")).href);
    sunucu = await sunucuBaslat({
      uiDir: path.join(KOK, "dist", "ui"),
      videoBundle: path.join(KOK, "dist", "video"),
      veriKok,
      motorKok: path.join(app.getPath("userData"), "motorlar"),
      appKok: KOK,
      klasorAc: (yol) => shell.openPath(yol),
      // güncelleme sonrası: pencere durumunu kaydet, kendini yeniden başlat
      yenidenBaslat: () => {
        try {
          durumYaz(pencere);
        } catch {}
        if (sunucu) sunucu.kapat();
        app.relaunch();
        app.exit(0);
      },
    });

    Menu.setApplicationMenu(null);
    // mikrofon izni (ses kaydı için) yalnızca kendi arayüzümüze
    session.defaultSession.setPermissionRequestHandler((wc, izin, cb) => cb(izin === "media" && wc.getURL().startsWith(`http://127.0.0.1:${sunucu.port}/`)));
    session.defaultSession.setPermissionCheckHandler((wc, izin) => izin === "media");
    const d = durumOku();
    pencere = new BrowserWindow({
      width: d?.width || 1560,
      height: d?.height || 940,
      ...(d && d.x != null ? { x: d.x, y: d.y } : {}),
      minWidth: 1100,
      minHeight: 680,
      resizable: true,
      show: false,
      backgroundColor: "#151933",
      title: "Shortscu",
      icon: path.join(__dirname, "ikon.png"),
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
    });
    pencere.once("ready-to-show", () => {
      if (d?.fullscreen) pencere.setFullScreen(true);
      else if (d?.maximized) pencere.maximize();
      pencere.show();
    });
    for (const olay of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) pencere.on(olay, () => durumPlanla(pencere));
    const adres = `http://127.0.0.1:${sunucu.port}/`;
    await pencere.loadURL(adres);

    // çıktı dosyalarını (video/kapak) ayrı pencerede aç, dış bağlantıları tarayıcıda
    pencere.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(adres)) return { action: "allow", overrideBrowserWindowOptions: { width: 540, height: 960, autoHideMenuBar: true, backgroundColor: "#000", title: "Shortscu" } };
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    pencere.webContents.on("will-navigate", (e, url) => {
      if (!url.startsWith(adres)) {
        e.preventDefault();
        if (/^https?:/.test(url)) shell.openExternal(url);
      }
    });
    // F12: geliştirici araçları, Ctrl+R: yenile (sorun giderme için)
    pencere.webContents.on("before-input-event", (_e, girdi) => {
      if (girdi.type !== "keyDown") return;
      if (girdi.key === "F12") pencere.webContents.toggleDevTools();
      if (girdi.key === "F11") pencere.setFullScreen(!pencere.isFullScreen());
      if (girdi.control && girdi.key.toLowerCase() === "r") pencere.webContents.reload();
    });

    // kapatırken son değişiklikleri kaydet
    let kapaniyor = false;
    pencere.on("close", async (e) => {
      if (kapaniyor) return;
      e.preventDefault();
      kapaniyor = true;
      durumYaz(pencere);
      try {
        await Promise.race([pencere.webContents.executeJavaScript("window.__studyoKaydet ? window.__studyoKaydet() : null"), new Promise((r) => setTimeout(r, 3000))]);
      } catch {}
      pencere.destroy();
    });
    pencere.on("closed", () => (pencere = null));
  };

  app.whenReady().then(() =>
    baslat().catch((e) => {
      dialog.showErrorBox("Shortscu açılamadı", String(e && e.stack ? e.stack : e));
      app.quit();
    }),
  );
  app.on("window-all-closed", () => {
    if (sunucu) sunucu.kapat();
    app.quit();
  });
}
