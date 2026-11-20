// Shortscu online güncelleme: GitHub'daki herkese açık depodan sadece değişen dosyaları indirir.
// Depo düzeni:  guncelleme.json  (sürüm, notlar, dosya listesi)
//               app/<yol>        (uygulama dosyaları, resources/app ile birebir)
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const DEPO = "emrekzlrs/shortscu";
const HAM = process.env.SHORTSCU_GUNCELLEME_URL || `https://raw.githubusercontent.com/${DEPO}/main`;

const surumKarsilastir = (a, b) => {
  const x = String(a).split(".").map(Number);
  const y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

const sha = (dosya) =>
  new Promise((coz, red) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(dosya)
      .on("data", (d) => h.update(d))
      .on("end", () => coz(h.digest("hex")))
      .on("error", red);
  });

/** Uygulama klasöründeki (node_modules hariç) dosyaların listesi: yol -> [sha256, boyut] */
export const dosyaListesi = async (kok) => {
  const sonuc = {};
  const gez = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const tam = path.join(d, e.name);
      const rel = path.relative(kok, tam).split(path.sep).join("/");
      if (e.isDirectory()) {
        if (rel === "node_modules" || rel.startsWith(".")) continue;
        await gez(tam);
      } else if (e.isFile() && !e.name.startsWith(".")) {
        const st = await fsp.stat(tam);
        sonuc[rel] = [await sha(tam), st.size];
      }
    }
  };
  await gez(kok);
  return sonuc;
};

/** Bağımlılık imzası: bu değişirse sadece dosya güncellemesi yetmez, tam paket gerekir */
export const bagimlilikImzasi = (pkg) => crypto.createHash("sha256").update(JSON.stringify(pkg.dependencies || {})).digest("hex").slice(0, 16);

export const guncelleyici = ({ appKok, yenidenBaslat }) => {
  const pkgOku = () => JSON.parse(fs.readFileSync(path.join(appKok, "package.json"), "utf8"));
  const yerelListeYolu = path.join(appKok, ".guncelleme-liste.json");
  let sonManifest = null;

  const manifestAl = async () => {
    const r = await fetch(`${HAM}/guncelleme.json?t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Güncelleme bilgisi alınamadı (${r.status})`);
    return await r.json();
  };

  /** Değişen dosyaları bulur (boyut farklıysa ya da özet tutmuyorsa) */
  const farklar = async (m) => {
    const l = [];
    for (const [rel, [ozet, boyut]] of Object.entries(m.dosyalar || {})) {
      const yerel = path.join(appKok, ...rel.split("/"));
      const st = await fsp.stat(yerel).catch(() => null);
      if (!st || st.size !== boyut || (await sha(yerel)) !== ozet) l.push({ rel, ozet, boyut });
    }
    return l;
  };

  const kontrol = async () => {
    const pkg = pkgOku();
    const m = await manifestAl();
    if (!m || surumKarsilastir(m.surum, pkg.version) <= 0) return { mevcut: pkg.version, yeni: null };
    sonManifest = m;
    const tamKurulum = m.bagimlilik && m.bagimlilik !== bagimlilikImzasi(pkg);
    const f = tamKurulum ? [] : await farklar(m);
    return {
      mevcut: pkg.version,
      yeni: m.surum,
      notlar: m.notlar || [],
      tarih: m.tarih,
      boyut: f.reduce((t, x) => t + x.boyut, 0),
      dosyaSayisi: f.length,
      tamKurulum: !!tamKurulum,
      tamPaket: m.tamPaket || `https://github.com/${DEPO}/releases/latest`,
      yenidenBaslatilabilir: !!yenidenBaslat,
    };
  };

  /** İndir, doğrula, yerine koy. Yarıda kalırsa uygulama dosyalarına dokunulmamış olur. */
  const kur = async (is) => {
    const m = sonManifest || (await manifestAl());
    if (!m) throw new Error("Güncelleme bulunamadı");
    const pkg = pkgOku();
    if (m.bagimlilik && m.bagimlilik !== bagimlilikImzasi(pkg)) throw new Error("Bu sürüm için yeni paketi indirmen gerekiyor.");
    is.asama = "Değişen dosyalar bulunuyor";
    const f = await farklar(m);
    const toplam = f.reduce((t, x) => t + x.boyut, 0) || 1;
    const gecici = path.join(appKok, ".guncelleme");
    await fsp.rm(gecici, { recursive: true, force: true });
    let inen = 0;
    for (const [i, d] of f.entries()) {
      is.asama = `İndiriliyor (${i + 1}/${f.length})`;
      const hedef = path.join(gecici, ...d.rel.split("/"));
      await fsp.mkdir(path.dirname(hedef), { recursive: true });
      const r = await fetch(`${HAM}/app/${d.rel.split("/").map(encodeURIComponent).join("/")}`, { signal: AbortSignal.timeout(120000) });
      if (!r.ok || !r.body) throw new Error(`${d.rel} indirilemedi (${r.status})`);
      const yaz = fs.createWriteStream(hedef);
      for await (const parca of r.body) {
        inen += parca.length;
        is.yuzde = Math.min(99, Math.round((inen / toplam) * 100));
        if (!yaz.write(parca)) await new Promise((c) => yaz.once("drain", c));
      }
      await new Promise((c, h) => yaz.end((e) => (e ? h(e) : c())));
      if ((await sha(hedef)) !== d.ozet) throw new Error(`${d.rel} bozuk indi, tekrar dene.`);
    }
    is.asama = "Yerine koyuluyor";
    for (const d of f) {
      const hedef = path.join(appKok, ...d.rel.split("/"));
      await fsp.mkdir(path.dirname(hedef), { recursive: true });
      await fsp.rename(path.join(gecici, ...d.rel.split("/")), hedef);
    }
    // eski sürümde olup yenisinde olmayan dosyaları kaldır (sadece daha önce güncellemeyle gelenler)
    try {
      const eski = JSON.parse(await fsp.readFile(yerelListeYolu, "utf8"));
      for (const rel of Object.keys(eski)) if (!m.dosyalar[rel]) await fsp.rm(path.join(appKok, ...rel.split("/")), { force: true });
    } catch {}
    await fsp.writeFile(yerelListeYolu, JSON.stringify(m.dosyalar));
    await fsp.rm(gecici, { recursive: true, force: true });
    is.asama = "Hazır";
    is.yuzde = 100;
    return { surum: m.surum, yenidenBaslatilabilir: !!yenidenBaslat };
  };

  return { kontrol, kur, yenidenBaslat };
};
