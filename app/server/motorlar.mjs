// Shortscu motorları: kendi sesinle seslendirme (Chatterbox) ve konuşmayı yazıya dökme (whisper.cpp).
// İkisi de isteğe bağlı; ilk kullanımda bilgisayara bir kez kurulur ve sonra internetsiz çalışır.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const BURASI = path.dirname(fileURLToPath(import.meta.url));
const PY_SURUM = "3.11.9";
const TORCH = "2.7.1";
const CHATTERBOX = "0.1.7";
const PY_PAKETLER = [
  "numpy<2",
  // resemble-perth (ses filigranı) pkg_resources ister; setuptools 81'den itibaren yok
  "setuptools<81",
  "librosa==0.11.0",
  "s3tokenizer",
  "transformers==5.2.0",
  "diffusers==0.29.0",
  "resemble-perth>=1.0.0",
  "conformer==0.3.2",
  "safetensors==0.5.3",
  "pyloudnorm",
  "omegaconf",
  "einops",
  "scipy",
  "soundfile",
  "huggingface_hub",
  "tqdm",
];

/** Dosyayı ilerlemeyle indirir; yarım kalan indirme kalıntı bırakmaz */
export const indir = async (url, hedef, ilerleme = () => {}) => {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok || !r.body) throw new Error(`${url} indirilemedi (${r.status})`);
  const toplam = Number(r.headers.get("content-length") || 0);
  await fsp.mkdir(path.dirname(hedef), { recursive: true });
  const gecici = `${hedef}.indiriliyor`;
  const yaz = fs.createWriteStream(gecici);
  let gelen = 0;
  try {
    for await (const parca of r.body) {
      gelen += parca.length;
      if (!yaz.write(parca)) await new Promise((c) => yaz.once("drain", c));
      if (toplam) ilerleme(gelen / toplam);
    }
    await new Promise((c, h) => yaz.end((e) => (e ? h(e) : c())));
    await fsp.rename(gecici, hedef);
  } catch (e) {
    yaz.destroy();
    await fsp.rm(gecici, { force: true });
    throw e;
  }
};

const calistir = (bin, args, { env, cwd, satir } = {}) =>
  new Promise((coz, red) => {
    const p = spawn(bin, args, { env: { ...process.env, ...env }, cwd, windowsHide: true });
    let son = "";
    const oku = (d) => {
      const s = d.toString();
      son = (son + s).slice(-6000);
      if (satir) s.split(/\r?\n|\r/).forEach((x) => x.trim() && satir(x.trim()));
    };
    p.stdout.on("data", oku);
    p.stderr.on("data", oku);
    p.on("error", red);
    p.on("close", (k) => (k === 0 ? coz(son) : red(new Error(`${path.basename(bin)} çıkış kodu ${k}\n${son.slice(-1500)}`))));
  });

export const motorlar = ({ motorKok, ffmpegCalistir }) => {
  const pyDizin = path.join(motorKok, "python");
  const pyBin = path.join(pyDizin, process.platform === "win32" ? "python.exe" : "bin/python3");
  const hfDizin = path.join(motorKok, "modeller");
  const hazirIsaret = path.join(pyDizin, ".shortscu-hazir");
  const whisperDizin = path.join(motorKok, "whisper");
  const pyEnv = { HF_HOME: hfDizin, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PIP_DISABLE_PIP_VERSION_CHECK: "1" };

  // ------------------------------------------------ seslendirme motoru kurulumu
  const sesMotoruDurum = () => ({
    kurulu: fs.existsSync(hazirIsaret),
    modelInik: fs.existsSync(path.join(hfDizin, "hub", "models--ResembleAI--chatterbox")),
    destek: process.platform === "win32" || process.env.SHORTSCU_PY ? true : false,
  });

  /** Gömülü Python + PyTorch (CUDA 12.8, RTX 50 serisi için) + Chatterbox kurar */
  const sesMotoruKur = async (is) => {
    const log = (m) => {
      is.log = [...(is.log || []), m].slice(-200);
    };
    if (process.platform !== "win32" && !process.env.SHORTSCU_PY) throw new Error("Seslendirme motorunun otomatik kurulumu şimdilik yalnızca Windows'ta var.");
    await fsp.mkdir(motorKok, { recursive: true });
    if (!fs.existsSync(pyBin)) {
      is.asama = "Python indiriliyor";
      const zip = path.join(motorKok, `python-${PY_SURUM}.zip`);
      await indir(`https://www.python.org/ftp/python/${PY_SURUM}/python-${PY_SURUM}-embed-amd64.zip`, zip, (p) => (is.yuzde = Math.round(p * 100)));
      await fsp.mkdir(pyDizin, { recursive: true });
      await calistir("tar", ["-xf", zip, "-C", pyDizin]);
      await fsp.rm(zip, { force: true });
      // gömülü Python site-packages kullanmaz; açıyoruz
      const pth = (await fsp.readdir(pyDizin)).find((d) => /^python\d+\._pth$/.test(d));
      if (pth) await fsp.writeFile(path.join(pyDizin, pth), `python311.zip\n.\nLib\\site-packages\n${path.join(BURASI)}\nimport site\n`);
      log("Python hazır");
    }
    const pip = (args, asama) => {
      is.asama = asama;
      is.yuzde = 0;
      let n = 0;
      return calistir(pyBin, ["-m", "pip", ...args], {
        env: pyEnv,
        satir: (s) => {
          log(s);
          if (/^(Collecting|Downloading|Installing)/.test(s)) is.yuzde = Math.min(95, ++n * 3);
        },
      });
    };
    const pipVar = await calistir(pyBin, ["-m", "pip", "--version"], { env: pyEnv }).then(
      () => true,
      () => false,
    );
    if (!pipVar) {
      is.asama = "pip kuruluyor";
      const gp = path.join(motorKok, "get-pip.py");
      await indir("https://bootstrap.pypa.io/get-pip.py", gp);
      await calistir(pyBin, [gp, "--no-warn-script-location"], { env: pyEnv, satir: log });
    }
    const kisit = path.join(motorKok, "kisitlar.txt");
    await fsp.writeFile(kisit, `torch==${TORCH}+cu128\ntorchaudio==${TORCH}+cu128\n`);
    await pip(["install", "--no-warn-script-location", `torch==${TORCH}`, `torchaudio==${TORCH}`, "--index-url", "https://download.pytorch.org/whl/cu128"], "PyTorch indiriliyor (yaklaşık 3 GB, bir kere)");
    await pip(["install", "--no-warn-script-location", "-c", kisit, "--extra-index-url", "https://download.pytorch.org/whl/cu128", ...PY_PAKETLER], "Ses kütüphaneleri kuruluyor");
    await pip(["install", "--no-warn-script-location", "--no-deps", `chatterbox-tts==${CHATTERBOX}`], "Chatterbox kuruluyor");
    is.asama = "Ses modeli indiriliyor (yaklaşık 3 GB, bir kere)";
    is.yuzde = 0;
    await calistir(pyBin, [path.join(BURASI, "ses_isci.py"), "--indir"], { env: pyEnv, satir: log });
    await fsp.writeFile(hazirIsaret, new Date().toISOString());
    is.asama = "Hazır";
    is.yuzde = 100;
  };

  // ------------------------------------------------ seslendirme işçisi (model bellekte kalır)
  let isci = null;
  let bekleyen = new Map();
  let siraNo = 0;
  const isciAl = () => {
    if (isci && !isci.killed) return isci;
    const bin = process.env.SHORTSCU_PY || pyBin;
    const cevrimdisi = sesMotoruDurum().modelInik ? { HF_HUB_OFFLINE: "1" } : {};
    isci = spawn(bin, [path.join(BURASI, "ses_isci.py")], { env: { ...process.env, ...pyEnv, ...cevrimdisi }, windowsHide: true });
    const rl = readline.createInterface({ input: isci.stdout });
    rl.on("line", (s) => {
      let m;
      try {
        m = JSON.parse(s);
      } catch {
        return;
      }
      const b = bekleyen.get(m.id);
      if (!b) return;
      bekleyen.delete(m.id);
      m.hata ? b.red(new Error(m.hata)) : b.coz(m);
    });
    let hataMetni = "";
    isci.stderr.on("data", (d) => (hataMetni = (hataMetni + d.toString()).slice(-3000)));
    isci.on("close", () => {
      for (const b of bekleyen.values()) b.red(new Error("Ses motoru kapandı.\n" + hataMetni.slice(-1200)));
      bekleyen = new Map();
      isci = null;
    });
    return isci;
  };
  const isciIstek = (komut) =>
    new Promise((coz, red) => {
      const id = String(++siraNo);
      bekleyen.set(id, { coz, red });
      isciAl().stdin.write(JSON.stringify({ id, ...komut }) + "\n");
    });

  /** Tek cümleyi verilen profil sesiyle WAV olarak üretir */
  const cumleUret = (metin, referans, cikti, ayar = {}) =>
    isciIstek({
      komut: "uret",
      metin,
      referans,
      cikti,
      exaggeration: ayar.coskunluk ?? 0.5,
      cfg: ayar.tempo ?? 0.5,
      temperature: ayar.cesitlilik ?? 0.8,
      seed: ayar.tohum ?? 0,
    });

  /** Cümle WAV'larını aralarına sessizlik koyarak birleştirir; hız atempo ile */
  const birlestir = async (parcalar, araMs, hiz, hedef) => {
    const args = ["-y", "-v", "error"];
    parcalar.forEach((p) => args.push("-i", p));
    const filtre = [];
    const zincir = [];
    parcalar.forEach((_, i) => {
      filtre.push(`[${i}:a]aresample=24000,aformat=channel_layouts=mono[a${i}]`);
      zincir.push(`[a${i}]`);
      if (i < parcalar.length - 1) {
        filtre.push(`anullsrc=r=24000:cl=mono,atrim=duration=${(araMs / 1000).toFixed(3)}[s${i}]`);
        zincir.push(`[s${i}]`);
      }
    });
    filtre.push(`${zincir.join("")}concat=n=${zincir.length}:v=0:a=1[c]`);
    const h = Math.max(0.5, Math.min(2, hiz || 1));
    filtre.push(Math.abs(h - 1) > 0.01 ? `[c]atempo=${h.toFixed(3)}[o]` : `[c]anull[o]`);
    args.push("-filter_complex", filtre.join(";"), "-map", "[o]", "-ar", "48000", hedef);
    await ffmpegCalistir(args);
  };

  // ------------------------------------------------ whisper.cpp
  const WHISPER_SURUM = "1.5.5";
  const whisperDurum = () => {
    const modeller = fs.existsSync(whisperDizin) ? fs.readdirSync(whisperDizin).filter((d) => /^ggml-.*\.bin$/.test(d)) : [];
    const exe = path.join(whisperDizin, process.platform === "win32" ? "main.exe" : "main");
    return { kurulu: fs.existsSync(exe), modeller: modeller.map((m) => m.replace(/^ggml-|\.bin$/g, "")) };
  };
  const whisperKur = async (is, model = "medium") => {
    const w = await import("@remotion/install-whisper-cpp");
    is.asama = "Yazıya dökme motoru kuruluyor";
    await w.installWhisperCpp({ to: whisperDizin, version: WHISPER_SURUM, printOutput: false });
    is.asama = `Dil modeli indiriliyor (${model})`;
    await w.downloadWhisperModel({
      model,
      folder: whisperDizin,
      printOutput: false,
      onProgress: (indirilen, toplam) => (is.yuzde = toplam ? Math.round((indirilen / toplam) * 100) : 0),
    });
    is.asama = "Hazır";
    is.yuzde = 100;
  };
  /** Ses dosyasını kelime kelime zamanlı metne çevirir */
  const yaziyaDok = async (is, sesYolu, model) => {
    const w = await import("@remotion/install-whisper-cpp");
    const d = whisperDurum();
    const m = d.modeller.includes(model) ? model : d.modeller.includes("medium") ? "medium" : d.modeller[0];
    if (!d.kurulu || !m) throw new Error("Önce yazıya dökme motorunu kur.");
    is.asama = "Ses hazırlanıyor";
    const wav = path.join(os.tmpdir(), `shortscu-${Date.now()}.wav`);
    await ffmpegCalistir(["-y", "-v", "error", "-i", sesYolu, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    is.asama = "Konuşma yazıya dökülüyor";
    try {
      const sonuc = await w.transcribe({
        inputPath: wav,
        whisperPath: whisperDizin,
        whisperCppVersion: WHISPER_SURUM,
        model: m,
        tokenLevelTimestamps: true,
        splitOnWord: true,
        language: "tr",
        printOutput: false,
        onProgress: (p) => (is.yuzde = Math.round(p * 100)),
      });
      const { captions } = w.toCaptions({ whisperCppOutput: sonuc });
      // alt kelime parçalarını (başında boşluk olmayan) önceki kelimeye ekle
      const kelimeler = [];
      for (const c of captions) {
        if (/^\s*\[.*\]\s*$/.test(c.text)) continue;
        const yeni = /^\s/.test(c.text) || !kelimeler.length;
        if (yeni) kelimeler.push({ metin: c.text.trim(), bas: c.startMs, son: c.endMs });
        else {
          const k = kelimeler[kelimeler.length - 1];
          k.metin += c.text.trim();
          k.son = c.endMs;
        }
      }
      return kelimeler.filter((k) => k.metin);
    } finally {
      await fsp.rm(wav, { force: true });
    }
  };

  const kapat = () => {
    if (isci) isci.kill();
  };

  return { sesMotoruDurum, sesMotoruKur, cumleUret, birlestir, whisperDurum, whisperKur, yaziyaDok, kapat };
};
