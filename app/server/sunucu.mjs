// Shortscu yerel sunucusu: arayüzü sunar, projeleri kaydeder, medyayı akıtır, videoyu dışa aktarır.
// Hem Electron içinde hem de tek başına (node server/sunucu.mjs) çalışır.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { motorlar } from "./motorlar.mjs";
import { guncelleyici } from "./guncelleme.mjs";

const require = createRequire(import.meta.url);
const BURASI = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
};

const guvenliAd = (ad) =>
  String(ad || "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120) || "dosya";

const icinde = (kok, yol) => {
  const r = path.relative(kok, yol);
  return !!r && !r.startsWith("..") && !path.isAbsolute(r);
};

const jsonGonder = (res, kod, veri) => {
  const govde = JSON.stringify(veri);
  res.writeHead(kod, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
  res.end(govde);
};

const govdeOku = (req, sinir = 2 * 1024 * 1024 * 1024) =>
  new Promise((coz, red) => {
    const parcalar = [];
    let boy = 0;
    req.on("data", (p) => {
      boy += p.length;
      if (boy > sinir) {
        red(new Error("Dosya çok büyük"));
        req.destroy();
      } else parcalar.push(p);
    });
    req.on("end", () => coz(Buffer.concat(parcalar)));
    req.on("error", red);
  });

/** Range destekli dosya gönderimi (ses/video ileri sarma için şart) */
const dosyaGonder = async (req, res, yol, onbellek = false) => {
  let st;
  try {
    st = await fsp.stat(yol);
    if (!st.isFile()) throw new Error();
  } catch {
    res.writeHead(404);
    return res.end("Bulunamadı");
  }
  const tip = MIME[path.extname(yol).toLowerCase()] || "application/octet-stream";
  const baslik = { "Content-Type": tip, "Accept-Ranges": "bytes", "Cache-Control": onbellek ? "public, max-age=3600" : "no-cache", "Access-Control-Allow-Origin": "*" };
  const aralik = req.headers.range;
  if (aralik) {
    const m = /bytes=(\d*)-(\d*)/.exec(aralik);
    let bas = m && m[1] ? parseInt(m[1], 10) : 0;
    let son = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (m && !m[1] && m[2]) {
      bas = st.size - parseInt(m[2], 10);
      son = st.size - 1;
    }
    if (bas >= st.size || bas > son) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
      return res.end();
    }
    son = Math.min(son, st.size - 1);
    res.writeHead(206, { ...baslik, "Content-Range": `bytes ${bas}-${son}/${st.size}`, "Content-Length": son - bas + 1 });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(yol, { start: bas, end: son }).pipe(res);
    return;
  }
  res.writeHead(200, { ...baslik, "Content-Length": st.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(yol).pipe(res);
};

// ---------------------------------------------------------------- ffmpeg
const ffmpegYolu = () => {
  const ad = process.platform === "win32" ? "@remotion/compositor-win32-x64-msvc" : process.platform === "darwin" ? (process.arch === "arm64" ? "@remotion/compositor-darwin-arm64" : "@remotion/compositor-darwin-x64") : "@remotion/compositor-linux-x64-gnu";
  try {
    const dizin = path.dirname(require.resolve(`${ad}/package.json`));
    return { bin: path.join(dizin, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"), dizin };
  } catch {
    return { bin: "ffmpeg", dizin: null };
  }
};

const ffmpegCalistir = (args) =>
  new Promise((coz, red) => {
    const { bin, dizin } = ffmpegYolu();
    const env = { ...process.env };
    if (dizin && process.platform === "linux") env.LD_LIBRARY_PATH = `${dizin}:${env.LD_LIBRARY_PATH || ""}`;
    const p = spawn(bin, args, { env, windowsHide: true });
    let hata = "";
    p.stderr.on("data", (d) => (hata = (hata + d.toString()).slice(-4000)));
    p.on("error", red);
    p.on("close", (k) => (k === 0 ? coz() : red(new Error(`ffmpeg hata (${k}): ${hata.slice(-600)}`))));
  });

// ---------------------------------------------------------------- sunucu
export const baslat = async (ayar = {}) => {
  const uiDir = ayar.uiDir || path.join(BURASI, "..", "dist", "ui");
  const videoBundle = ayar.videoBundle || path.join(BURASI, "..", "dist", "video");
  const veriKok = ayar.veriKok || path.join(os.homedir(), "Documents", "Shortscu");
  const motorKok = ayar.motorKok || path.join(veriKok, ".motorlar");
  const projeKok = path.join(veriKok, "Projeler");
  const sablonKok = path.join(veriKok, "Sablonlar");
  // Kişisel logolar (takım armaları vb.): yalnızca bu bilgisayarda durur, güncellemelerle dağıtılmaz
  const logoKok = path.join(veriKok, "Logolarım");
  // program klasörüne bırakılmış logoları (ilk kurulum, elle kopyalama) kişisel klasöre al; var olanların üstüne yazma
  if (ayar.ekLogoKok) {
    try {
      const ekler = await fsp.readdir(ayar.ekLogoKok).catch(() => []);
      if (ekler.length) await fsp.mkdir(logoKok, { recursive: true });
      for (const ad of ekler) {
        const hedef = path.join(logoKok, ad);
        if (/\.(png|jpe?g|webp|svg|gif)$/i.test(ad) && !fs.existsSync(hedef)) await fsp.copyFile(path.join(ayar.ekLogoKok, ad), hedef);
      }
    } catch {}
  }
  await fsp.mkdir(projeKok, { recursive: true });
  await fsp.mkdir(sablonKok, { recursive: true });
  const klasorAc = ayar.klasorAc || ((yol) => {
    const komut = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
    try {
      spawn(komut, [yol], { detached: true, stdio: "ignore" }).unref();
    } catch {}
  });
  const isler = new Map();
  const motor = motorlar({ motorKok, ffmpegCalistir });
  const guncelle = guncelleyici({ appKok: ayar.appKok || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."), yenidenBaslat: ayar.yenidenBaslat });
  let guncellemeOnbellek = null;
  // kişisel kütüphane: projeler arasında paylaşılan karakterler, kalıplar, yazı tipleri, sesler
  const KUTUPHANE = {
    karakterler: { dizin: "Karakterler", json: true },
    kaliplar: { dizin: "Kaliplar", json: true },
    fontlar: { dizin: "Fontlar", uz: /\.(ttf|otf|woff2?)$/i },
    sesler: { dizin: "Sesler", uz: /\.(wav|mp3|ogg|m4a)$/i },
    profiller: { dizin: path.join("Sesler", "Profiller"), uz: /\.(wav|mp3|ogg|m4a|webm)$/i },
  };
  const kutuphaneYolu = (tur, ad) => {
    const k = KUTUPHANE[tur];
    if (!k) throw new Error("Bilinmeyen kütüphane");
    const dizin = path.join(veriKok, k.dizin);
    if (ad == null) return { k, dizin };
    const dosya = path.join(dizin, k.json ? `${guvenliAd(ad)}.json` : guvenliAd(ad));
    if (!icinde(dizin, dosya)) throw new Error("Geçersiz ad");
    return { k, dizin, dosya };
  };
  /** Genel iş: arka planda çalışır, durumu /api/is/:id ile izlenir */
  const isCalistir = (tur, f) => {
    const id = Math.random().toString(36).slice(2, 10);
    const is = { id, tur, asama: "Sırada", yuzde: 0, dosya: null, hata: null, bitti: false, uyari: null, iptal: null, sonuc: null, log: [] };
    isler.set(id, is);
    Promise.resolve()
      .then(() => f(is))
      .then((r) => {
        if (r !== undefined) is.sonuc = r;
      })
      .catch((e) => {
        const m = String(e && e.message ? e.message : e);
        kayitYaz(`is:${tur}`, e && e.stack ? e.stack : m);
        is.hata = /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(m) ? "İndirme yapılamadı. İnternet bağlantını kontrol edip tekrar dene.\n\nAyrıntı: " + m.slice(0, 400) : m.slice(0, 2000);
      })
      .finally(() => {
        is.bitti = true;
        is.iptal = null;
      });
    return is;
  };
  let port = 0;
  const tarayici = ayar.tarayici || process.env.STUDYO_TARAYICI || null;
  // indirme gibi iç hatalar süreci düşürmesin
  if (!globalThis.__studyoKoruma) {
    globalThis.__studyoKoruma = true;
    process.on("unhandledRejection", (e) => (console.error("Yakalanmayan hata:", e && e.message ? e.message : e), kayitYaz("sunucu", `Yakalanmayan hata: ${e && e.stack ? e.stack : e}`)));
    process.on("uncaughtException", (e) => (console.error("Yakalanmayan istisna:", e && e.message ? e.message : e), kayitYaz("sunucu", `Yakalanmayan istisna: ${e && e.stack ? e.stack : e}`)));
  }

  // ---- hata kaydı: Belgeler\Shortscu\Kayitlar\shortscu.log (2 MB'ı geçince eskisi .1 olur)
  const kayitDizin = path.join(veriKok, "Kayitlar");
  const kayitDosya = path.join(kayitDizin, "shortscu.log");
  const kayitYaz = (kaynak, mesaj) => {
    try {
      fs.mkdirSync(kayitDizin, { recursive: true });
      try {
        if (fs.statSync(kayitDosya).size > 2 * 1024 * 1024) fs.renameSync(kayitDosya, kayitDosya + ".1");
      } catch {}
      fs.appendFileSync(kayitDosya, `[${new Date().toISOString()}] [${kaynak}] ${String(mesaj).slice(0, 4000)}\n`);
    } catch {}
  };
  const surum = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;
    } catch {
      return "?";
    }
  })();
  kayitYaz("sunucu", `Shortscu ${surum} başladı (${process.platform} ${process.arch}, node ${process.versions.node})`);

  // ---- sürüm geçmişi: kayıtta en fazla 5 dakikada bir yedek, son 60 yedek
  const yedekAl = async (dizin, zorla = false) => {
    const kaynak = path.join(dizin, "proje.json");
    if (!fs.existsSync(kaynak)) return;
    const yd = path.join(dizin, "gecmis");
    await fsp.mkdir(yd, { recursive: true });
    const l = (await fsp.readdir(yd)).filter((x) => x.endsWith(".json")).sort();
    if (!zorla && l.length) {
      const son = await fsp.stat(path.join(yd, l[l.length - 1]));
      if (Date.now() - son.mtimeMs < 5 * 60 * 1000) return;
    }
    const d = new Date();
    const iki = (n) => String(n).padStart(2, "0");
    const ad = `${d.getFullYear()}-${iki(d.getMonth() + 1)}-${iki(d.getDate())}_${iki(d.getHours())}-${iki(d.getMinutes())}-${iki(d.getSeconds())}.json`;
    await fsp.copyFile(kaynak, path.join(yd, ad));
    for (const eski of l.slice(0, Math.max(0, l.length + 1 - 60))) await fsp.rm(path.join(yd, eski), { force: true });
  };

  const projeYolu = (klasor) => {
    const y = path.join(projeKok, guvenliAd(klasor));
    if (!icinde(projeKok, y)) throw new Error("Geçersiz proje");
    return y;
  };

  const yeniKlasorAdi = async (ad) => {
    const temel = guvenliAd(ad).replace(/\s+/g, " ");
    let aday = temel;
    let n = 2;
    while (fs.existsSync(path.join(projeKok, aday))) aday = `${temel} (${n++})`;
    return aday;
  };

  const medyaKaydet = async (klasor, ad, veri) => {
    const dizin = path.join(projeYolu(klasor), "medya");
    await fsp.mkdir(dizin, { recursive: true });
    const uz = path.extname(guvenliAd(ad));
    const kok = path.basename(guvenliAd(ad), uz);
    let aday = `${kok}${uz}`;
    let n = 2;
    while (fs.existsSync(path.join(dizin, aday))) aday = `${kok}-${n++}${uz}`;
    await fsp.writeFile(path.join(dizin, aday), veri);
    return aday;
  };

  // ------------------------------------------------ dışa aktarma
  const disaAktar = async (is, klasor, tur, platform = "") => {
    const renderer = await import("@remotion/renderer");
    const dizin = projeYolu(klasor);
    const proje = JSON.parse(await fsp.readFile(path.join(dizin, "proje.json"), "utf8"));
    const cikti = path.join(dizin, "cikti");
    await fsp.mkdir(cikti, { recursive: true });
    const inputProps = { proje, medyaTaban: `http://127.0.0.1:${port}/medya/${encodeURIComponent(klasor)}/` };
    is.asama = "Hazırlanıyor";
    if (!tarayici) await renderer.ensureBrowser({
      onBrowserDownload: () => {
        is.asama = "Video motoru indiriliyor (ilk sefere özel)";
        return {
          version: null,
          onProgress: (p) => {
            is.yuzde = Math.round((p.percent || 0) * 100);
          },
        };
      },
    });
    const zamanDamgasi = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
    const adTemel = guvenliAd(proje.ad || "video").replace(/\s+/g, "-");
    if (tur === "kapak") {
      is.asama = "Kapak çiziliyor";
      const composition = await renderer.selectComposition({ serveUrl: videoBundle, id: "Kapak", inputProps, browserExecutable: tarayici });
      const hedef = path.join(cikti, `${adTemel}-kapak-${zamanDamgasi}.png`);
      await renderer.renderStill({ composition, serveUrl: videoBundle, output: hedef, inputProps, imageFormat: "png", browserExecutable: tarayici });
      is.dosya = hedef;
      return;
    }
    is.asama = "Video hazırlanıyor";
    const composition = await renderer.selectComposition({ serveUrl: videoBundle, id: "Proje", inputProps, browserExecutable: tarayici });
    const ham = path.join(cikti, `.ham-${is.id}.mp4`);
    is.asama = "Kareler çiziliyor";
    const { cancelSignal, cancel } = renderer.makeCancelSignal();
    is.iptal = cancel;
    await renderer.renderMedia({
      composition,
      serveUrl: videoBundle,
      codec: "h264",
      outputLocation: ham,
      inputProps,
      crf: 20,
      x264Preset: "veryfast",
      concurrency: Math.max(1, Math.min(8, Math.floor(os.cpus().length / 2))),
      cancelSignal,
      browserExecutable: tarayici,
      onProgress: (p) => {
        is.yuzde = Math.round(p.progress * 100);
        is.asama = p.stitchStage === "muxing" ? "Ses ekleniyor" : "Kareler çiziliyor";
      },
    });
    is.asama = "Ses seviyesi ayarlanıyor (-14 LUFS)";
    is.yuzde = 100;
    const ek = { tiktok: "-tiktok", reels: "-reels" }[platform] || "";
    const hedef = path.join(cikti, `${adTemel}${ek}-${zamanDamgasi}.mp4`);
    try {
      await ffmpegCalistir(["-y", "-v", "error", "-i", ham, "-c:v", "copy", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", hedef]);
      await fsp.rm(ham, { force: true });
    } catch (e) {
      // ses ayarı başarısız olursa ham videoyu teslim et
      await fsp.rename(ham, hedef);
      is.uyari = "Ses seviyesi ayarlanamadı, video olduğu gibi kaydedildi.";
    }
    is.dosya = hedef;
  };

  const isBaslat = (klasor, tur, platform = "") => {
    const id = Math.random().toString(36).slice(2, 10);
    const is = { id, klasor, tur, asama: "Sırada", yuzde: 0, dosya: null, hata: null, bitti: false, uyari: null, iptal: null };
    isler.set(id, is);
    disaAktar(is, klasor, tur, platform)
      .catch((e) => {
        const m = String(e && e.message ? e.message : e);
        kayitYaz("disa-aktar", e && e.stack ? e.stack : m);
        if (/Could not download/i.test(m)) is.hata = "Video motoru (Chrome) indirilemedi. İnternet bağlantını kontrol edip tekrar dene; bu indirme yalnızca ilk sefer gerekir.\n\nAyrıntı: " + m.slice(0, 400);
        else if (/cancel/i.test(m)) is.hata = "Dışa aktarma iptal edildi.";
        else is.hata = m.slice(0, 1500);
      })
      .finally(() => {
        is.bitti = true;
        is.iptal = null;
      });
    return is;
  };

  // ------------------------------------------------ yönlendirme
  const sunucu = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const yol = decodeURIComponent(url.pathname);
      const parca = yol.split("/").filter(Boolean);

      if (parca[0] === "medya" && parca.length >= 3) {
        const d = path.join(projeYolu(parca[1]), "medya", guvenliAd(parca.slice(2).join("/")));
        return dosyaGonder(req, res, d, true);
      }
      if (parca[0] === "logolar" && parca.length >= 2) return dosyaGonder(req, res, path.join(logoKok, guvenliAd(parca.slice(1).join("/"))), true);
      if (parca[0] === "kutuphane" && parca.length === 3) return dosyaGonder(req, res, kutuphaneYolu(parca[1], parca[2]).dosya);
      if (parca[0] === "cikti" && parca.length >= 3) {
        const d = path.join(projeYolu(parca[1]), "cikti", guvenliAd(parca[2]));
        return dosyaGonder(req, res, d);
      }

      if (parca[0] === "api") {
        if (parca[1] === "logolar") {
          await fsp.mkdir(logoKok, { recursive: true });
          if (parca.length === 2 && req.method === "GET") {
            const l = [];
            for (const ad of await fsp.readdir(logoKok)) if (/\.(png|jpe?g|webp|svg|gif)$/i.test(ad)) l.push({ dosya: ad, guncel: (await fsp.stat(path.join(logoKok, ad))).mtimeMs });
            l.sort((a, b) => a.dosya.localeCompare(b.dosya, "tr"));
            return jsonGonder(res, 200, l);
          }
          if (parca.length === 2 && req.method === "POST") {
            const ad = guvenliAd(url.searchParams.get("ad") || "logo.png");
            await fsp.writeFile(path.join(logoKok, ad), await govdeOku(req, 50 * 1024 * 1024));
            return jsonGonder(res, 200, { dosya: ad });
          }
          if (parca[2] === "ac" && req.method === "POST") {
            klasorAc(logoKok);
            return jsonGonder(res, 200, { tamam: true, yol: logoKok });
          }
        }
        const yontem = req.method;
        // /api/projeler
        if (parca[1] === "projeler" && yontem === "GET") {
          const liste = [];
          for (const ad of await fsp.readdir(projeKok)) {
            const j = path.join(projeKok, ad, "proje.json");
            try {
              const st = await fsp.stat(j);
              const p = JSON.parse(await fsp.readFile(j, "utf8"));
              liste.push({ klasor: ad, ad: p.ad, guncel: st.mtimeMs, sahne: p.sahneler?.length || 0, sure: p.ses?.sure || 0, tema: p.tema?.renk || null, seri: p.seriAdi || "", bolum: p.bolumNo || 0 });
            } catch {}
          }
          liste.sort((a, b) => b.guncel - a.guncel);
          return jsonGonder(res, 200, liste);
        }
        if (parca[1] === "proje" && parca[2] === "yeni" && yontem === "POST") {
          const govde = JSON.parse((await govdeOku(req)).toString("utf8") || "{}");
          const klasor = await yeniKlasorAdi(govde.ad || "Yeni video");
          await fsp.mkdir(path.join(projeKok, klasor, "medya"), { recursive: true });
          if (govde.proje) await fsp.writeFile(path.join(projeKok, klasor, "proje.json"), JSON.stringify(govde.proje));
          return jsonGonder(res, 200, { klasor });
        }
        if (parca[1] === "proje" && parca[2]) {
          const klasor = parca[2];
          const dizin = projeYolu(klasor);
          if (parca.length === 3 && yontem === "GET") return dosyaGonder(req, res, path.join(dizin, "proje.json"));
          if (parca.length === 3 && yontem === "PUT") {
            const veri = await govdeOku(req, 50 * 1024 * 1024);
            JSON.parse(veri.toString("utf8")); // doğrula
            await fsp.mkdir(dizin, { recursive: true });
            await yedekAl(dizin);
            const gecici = path.join(dizin, `.proje-${Date.now()}.json`);
            await fsp.writeFile(gecici, veri);
            await fsp.rename(gecici, path.join(dizin, "proje.json"));
            return jsonGonder(res, 200, { tamam: true });
          }
          if (parca[3] === "gecmis" && yontem === "GET") {
            const yd = path.join(dizin, "gecmis");
            const l = [];
            for (const ad of (await fsp.readdir(yd).catch(() => [])).filter((x) => x.endsWith(".json"))) {
              const st = await fsp.stat(path.join(yd, ad));
              let ozet = {};
              try {
                const pj = JSON.parse(await fsp.readFile(path.join(yd, ad), "utf8"));
                ozet = { sahne: pj.sahneler?.length ?? 0, oge: (pj.sahneler ?? []).reduce((t, s) => t + (s.ogeler?.length ?? 0), 0), metin: String(pj.metin ?? "").slice(0, 80) };
              } catch {}
              l.push({ ad, zaman: st.mtimeMs, boyut: st.size, ...ozet });
            }
            l.sort((a, b) => b.zaman - a.zaman);
            return jsonGonder(res, 200, l);
          }
          if (parca[3] === "gecmis" && parca[4] && yontem === "POST") {
            const kaynak = path.join(dizin, "gecmis", guvenliAd(parca[4]));
            if (!icinde(path.join(dizin, "gecmis"), kaynak) || !fs.existsSync(kaynak)) return jsonGonder(res, 404, { hata: "Bu sürüm bulunamadı" });
            await yedekAl(dizin, true);
            await fsp.copyFile(kaynak, path.join(dizin, "proje.json"));
            return jsonGonder(res, 200, { tamam: true });
          }
          if (parca[3] === "medya" && yontem === "POST") {
            const ad = url.searchParams.get("ad") || "dosya";
            const veri = await govdeOku(req);
            return jsonGonder(res, 200, { dosya: await medyaKaydet(klasor, ad, veri) });
          }
          if (parca[3] === "medya" && yontem === "GET") {
            const md = path.join(dizin, "medya");
            await fsp.mkdir(md, { recursive: true });
            const l = [];
            for (const ad of await fsp.readdir(md)) {
              const st = await fsp.stat(path.join(md, ad));
              if (st.isFile()) l.push({ dosya: ad, boyut: st.size });
            }
            return jsonGonder(res, 200, l);
          }
          if (parca[3] === "cikti" && yontem === "GET") {
            const cd = path.join(dizin, "cikti");
            await fsp.mkdir(cd, { recursive: true });
            const l = [];
            for (const ad of await fsp.readdir(cd)) if (!ad.startsWith(".")) l.push({ dosya: ad, guncel: (await fsp.stat(path.join(cd, ad))).mtimeMs });
            l.sort((a, b) => b.guncel - a.guncel);
            return jsonGonder(res, 200, l);
          }
          if (parca[3] === "kopya" && yontem === "POST") {
            const yeni = await yeniKlasorAdi(`${klasor} kopya`);
            await fsp.cp(dizin, path.join(projeKok, yeni), { recursive: true });
            return jsonGonder(res, 200, { klasor: yeni });
          }
          if (parca[3] === "sil" && yontem === "POST") {
            const cop = path.join(veriKok, "Silinenler");
            await fsp.mkdir(cop, { recursive: true });
            await fsp.rename(dizin, path.join(cop, `${guvenliAd(klasor)}-${Date.now()}`));
            return jsonGonder(res, 200, { tamam: true });
          }
          if (parca[3] === "ac" && yontem === "POST") {
            const alt = url.searchParams.get("alt");
            const hedef = alt === "cikti" ? path.join(dizin, "cikti") : dizin;
            await fsp.mkdir(hedef, { recursive: true });
            klasorAc(hedef);
            return jsonGonder(res, 200, { tamam: true });
          }
          if (parca[3] === "kutuphaneden" && yontem === "POST") {
            const { dosya } = kutuphaneYolu(url.searchParams.get("tur"), url.searchParams.get("ad"));
            const ad = path.basename(dosya);
            const hedef = path.join(dizin, "medya", ad);
            const [a, b] = await Promise.all([fsp.stat(dosya), fsp.stat(hedef).catch(() => null)]);
            if (b && b.size === a.size) return jsonGonder(res, 200, { dosya: ad });
            return jsonGonder(res, 200, { dosya: await medyaKaydet(klasor, ad, await fsp.readFile(dosya)) });
          }
          if (parca[3] === "yaziya-dok" && yontem === "POST") {
            const d = path.join(dizin, "medya", guvenliAd(url.searchParams.get("dosya")));
            const model = url.searchParams.get("model") || "medium";
            return jsonGonder(res, 200, { id: isCalistir("yaziya-dok", (is) => motor.yaziyaDok(is, d, model)).id });
          }
          if (parca[3] === "seslendir" && yontem === "POST") {
            // govde: { cumleler: string[], profil, ayar: {coskunluk, tempo, cesitlilik, hiz, araMs}, yenile?: number[] }
            const g = JSON.parse((await govdeOku(req)).toString("utf8") || "{}");
            const profil = kutuphaneYolu("profiller", g.profil).dosya;
            if (!fs.existsSync(profil)) return jsonGonder(res, 400, { hata: "Ses profili bulunamadı" });
            const id = isCalistir("seslendir", async (is) => {
              const tts = path.join(dizin, "medya", ".seslendirme");
              await fsp.mkdir(tts, { recursive: true });
              const ayar = g.ayar || {};
              const parcalar = [];
              const sureler = [];
              const yenile = new Set(g.yenile || []);
              for (let i = 0; i < g.cumleler.length; i++) {
                const metin = String(g.cumleler[i]).trim();
                // aynı metin + aynı ayar + aynı profil daha önce üretildiyse tekrar üretme
                const imza = Buffer.from(JSON.stringify([metin, g.profil, ayar.coskunluk, ayar.tempo, ayar.cesitlilik, ayar.tohum])).toString("base64url").slice(-40);
                const yol = path.join(tts, `c${i}-${imza}.wav`);
                if (!fs.existsSync(yol) || yenile.has(i)) {
                  is.asama = `Cümle ${i + 1} / ${g.cumleler.length} seslendiriliyor`;
                  const tohum = yenile.has(i) ? Math.floor(Math.random() * 1e6) + 1 : ayar.tohum;
                  await motor.cumleUret(metin, profil, yol, { ...ayar, tohum });
                }
                parcalar.push(yol);
                is.yuzde = Math.round(((i + 1) / g.cumleler.length) * 90);
              }
              is.asama = "Cümleler birleştiriliyor";
              const ad = `seslendirme-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.wav`;
              const hedef = path.join(dizin, "medya", ad);
              const hiz = Math.max(0.5, Math.min(2, ayar.hiz ?? 1));
              const ara = ayar.araMs ?? 350;
              await motor.birlestir(parcalar, ara, hiz, hedef);
              // her cümlenin çıktıdaki yeri: kelimeleri hizalamak için kesin sınırlar
              let t = 0;
              for (const p of parcalar) {
                const b = await fsp.readFile(p);
                const sr = b.readUInt32LE(24);
                const veri = b.indexOf("data") + 8;
                const sn = (b.length - veri) / (sr * 2);
                const sure = (sn * 1000) / hiz;
                sureler.push({ bas: Math.round(t), son: Math.round(t + sure) });
                t += sure + ara / hiz;
              }
              is.yuzde = 100;
              return { dosya: ad, sureler };
            }).id;
            return jsonGonder(res, 200, { id });
          }
          if (parca[3] === "disa-aktar" && yontem === "POST") {
            const tur = url.searchParams.get("tur") === "kapak" ? "kapak" : "video";
            const is = isBaslat(klasor, tur, url.searchParams.get("platform") || "");
            return jsonGonder(res, 200, { id: is.id });
          }
        }
        if (parca[1] === "is" && parca[2]) {
          const is = isler.get(parca[2]);
          if (!is) return jsonGonder(res, 404, { hata: "İş yok" });
          if (parca[3] === "iptal" && req.method === "POST") {
            if (is.iptal) is.iptal();
            return jsonGonder(res, 200, { tamam: true });
          }
          const { iptal, ...gorunen } = is;
          return jsonGonder(res, 200, { ...gorunen, dosyaAd: is.dosya ? path.basename(is.dosya) : null });
        }
        if (parca[1] === "sablonlar" && req.method === "GET") {
          const l = [];
          for (const ad of await fsp.readdir(sablonKok)) if (ad.endsWith(".json")) l.push(ad.replace(/\.json$/, ""));
          return jsonGonder(res, 200, l);
        }
        if (parca[1] === "sablon" && parca[2]) {
          const d = path.join(sablonKok, `${guvenliAd(parca[2])}.json`);
          if (req.method === "GET") return dosyaGonder(req, res, d);
          if (req.method === "PUT") {
            const veri = await govdeOku(req, 20 * 1024 * 1024);
            JSON.parse(veri.toString("utf8"));
            await fsp.writeFile(d, veri);
            return jsonGonder(res, 200, { tamam: true });
          }
          if (req.method === "DELETE") {
            await fsp.rm(d, { force: true });
            return jsonGonder(res, 200, { tamam: true });
          }
        }
        if (parca[1] === "kutuphane" && parca[2]) {
          if (parca.length === 3 && yontem === "GET") {
            const { k, dizin } = kutuphaneYolu(parca[2]);
            await fsp.mkdir(dizin, { recursive: true });
            const l = [];
            for (const ad of await fsp.readdir(dizin)) {
              if (k.json ? !ad.endsWith(".json") : !k.uz.test(ad)) continue;
              const st = await fsp.stat(path.join(dizin, ad));
              if (st.isFile()) l.push({ ad: k.json ? ad.replace(/\.json$/, "") : ad, boyut: st.size, guncel: st.mtimeMs });
            }
            l.sort((a, b) => b.guncel - a.guncel);
            return jsonGonder(res, 200, l);
          }
          const { k, dizin, dosya } = kutuphaneYolu(parca[2], parca[3]);
          if (yontem === "GET") return dosyaGonder(req, res, dosya);
          if (yontem === "PUT") {
            const veri = await govdeOku(req, 200 * 1024 * 1024);
            if (k.json) JSON.parse(veri.toString("utf8"));
            else if (!k.uz.test(dosya)) return jsonGonder(res, 400, { hata: "Bu dosya türü bu kütüphaneye konamaz" });
            await fsp.mkdir(dizin, { recursive: true });
            await fsp.writeFile(dosya, veri);
            return jsonGonder(res, 200, { ad: path.basename(dosya, k.json ? ".json" : "") });
          }
          if (yontem === "DELETE") {
            await fsp.rm(dosya, { force: true });
            return jsonGonder(res, 200, { tamam: true });
          }
        }
        if (parca[1] === "ses-motoru") {
          if (yontem === "GET") return jsonGonder(res, 200, motor.sesMotoruDurum());
          if (parca[2] === "kur" && yontem === "POST") return jsonGonder(res, 200, { id: isCalistir("ses-kur", (is) => motor.sesMotoruKur(is)).id });
        }
        if (parca[1] === "whisper") {
          if (yontem === "GET") return jsonGonder(res, 200, motor.whisperDurum());
          if (parca[2] === "kur" && yontem === "POST") {
            const model = ["small", "medium", "large-v3-turbo"].includes(url.searchParams.get("model")) ? url.searchParams.get("model") : "medium";
            return jsonGonder(res, 200, { id: isCalistir("whisper-kur", (is) => motor.whisperKur(is, model)).id });
          }
        }
        if (parca[1] === "bilgi") return jsonGonder(res, 200, { veriKok, surum, platform: process.platform });
        if (parca[1] === "guncelleme") {
          if (yontem === "GET") {
            if (guncellemeOnbellek && Date.now() - guncellemeOnbellek.zaman < 10 * 60 * 1000 && !url.searchParams.get("zorla")) return jsonGonder(res, 200, guncellemeOnbellek.veri);
            try {
              const veri = await guncelle.kontrol();
              guncellemeOnbellek = { zaman: Date.now(), veri };
              return jsonGonder(res, 200, veri);
            } catch (e) {
              kayitYaz("guncelleme", e && e.message);
              return jsonGonder(res, 200, { mevcut: surum, yeni: null, hata: "Güncelleme denetlenemedi" });
            }
          }
          if (parca[2] === "kur" && yontem === "POST") return jsonGonder(res, 200, { id: isCalistir("guncelleme", (is) => guncelle.kur(is)).id });
        }
        if (parca[1] === "yeniden-baslat" && yontem === "POST") {
          if (!guncelle.yenidenBaslat) return jsonGonder(res, 400, { hata: "Programı kapatıp yeniden aç." });
          jsonGonder(res, 200, { tamam: true });
          setTimeout(() => guncelle.yenidenBaslat(), 300);
          return;
        }
        if (parca[1] === "kayit" && yontem === "POST") {
          const g = JSON.parse((await govdeOku(req, 512 * 1024)).toString("utf8") || "{}");
          for (const satir of (g.satirlar || []).slice(0, 50)) kayitYaz("arayuz", satir);
          return jsonGonder(res, 200, { tamam: true });
        }
        if (parca[1] === "sorun-raporu" && yontem === "POST") {
          const g = JSON.parse((await govdeOku(req, 5 * 1024 * 1024)).toString("utf8") || "{}");
          const satirlar = [];
          for (const f of [kayitDosya + ".1", kayitDosya]) {
            try {
              satirlar.push(...(await fsp.readFile(f, "utf8")).split("\n"));
            } catch {}
          }
          let proje = "";
          if (g.klasor) {
            try {
              proje = await fsp.readFile(path.join(projeYolu(g.klasor), "proje.json"), "utf8");
              const pj = JSON.parse(proje);
              if (pj.ses) delete pj.ses.zarf;
              proje = JSON.stringify(pj, null, 1);
            } catch {}
          }
          const d = new Date();
          const ad = `Sorun-raporu-${d.toISOString().slice(0, 19).replace(/[T:]/g, "-")}.txt`;
          const dizin = path.join(veriKok, "Sorun raporlari");
          await fsp.mkdir(dizin, { recursive: true });
          const icerik = [
            "SHORTSCU SORUN RAPORU",
            `Sürüm: ${surum}`,
            `Sistem: ${process.platform} ${process.arch} ${os.release()}, ${Math.round(os.totalmem() / 1e9)} GB bellek, ${os.cpus().length} çekirdek`,
            `Tarih: ${d.toLocaleString("tr-TR")}`,
            "",
            "NE OLDU",
            String(g.aciklama || "(yazılmadı)"),
            "",
            "ARAYÜZ",
            String(g.arayuz || ""),
            "",
            "SON KAYITLAR",
            satirlar.filter(Boolean).slice(-400).join("\n"),
            "",
            proje ? "PROJE" : "",
            proje,
          ].join("\n");
          await fsp.writeFile(path.join(dizin, ad), icerik);
          if (g.ac) klasorAc(dizin);
          return jsonGonder(res, 200, { dosya: path.join(dizin, ad) });
        }
        return jsonGonder(res, 404, { hata: "Bilinmeyen istek" });
      }

      // arayüz dosyaları
      let d = path.join(uiDir, yol === "/" ? "index.html" : yol);
      if (!icinde(uiDir, d) && d !== path.join(uiDir, "index.html")) d = path.join(uiDir, "index.html");
      if (!fs.existsSync(d)) d = path.join(uiDir, "index.html");
      return dosyaGonder(req, res, d, /\/assets\//.test(yol));
    } catch (e) {
      if (!res.headersSent) jsonGonder(res, 500, { hata: String(e && e.message ? e.message : e) });
      else res.end();
    }
  });
  sunucu.requestTimeout = 0;
  await new Promise((coz) => sunucu.listen(ayar.port || 0, "127.0.0.1", coz));
  port = sunucu.address().port;
  return {
    port,
    veriKok,
    kapat: () => {
      motor.kapat();
      sunucu.close();
    },
  };
};

// tek başına çalıştırma
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await baslat({ port: Number(process.env.PORT || 4321), veriKok: process.env.STUDYO_VERI || undefined });
  console.log(`Shortscu: http://127.0.0.1:${s.port}  (veri: ${s.veriKok})`);
}
