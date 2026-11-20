# Shortscu seslendirme işçisi.
# Satır satır JSON alır, her isteğe tek satır JSON cevap verir. Model bir kez yüklenir, bellekte kalır.
#   {"id": "1", "komut": "uret", "metin": "...", "referans": "profil.wav", "cikti": "c0.wav", ...}
#   -> {"id": "1", "tamam": true, "sure": 2.41}
# --indir ile çalışırsa yalnızca modeli indirip çıkar (kurulum sırasında).
import json
import os
import sys
import random


def cevap(veri):
    sys.stdout.write(json.dumps(veri, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def cihaz():
    import torch

    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


_model = None


def model():
    global _model
    if _model is None:
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        _model = ChatterboxMultilingualTTS.from_pretrained(device=cihaz())
    return _model


def uret(istek):
    import numpy as np
    import soundfile as sf
    import torch

    tohum = int(istek.get("seed") or 0)
    if tohum:
        random.seed(tohum)
        np.random.seed(tohum)
        torch.manual_seed(tohum)
    m = model()
    wav = m.generate(
        istek["metin"],
        language_id="tr",
        audio_prompt_path=istek.get("referans") or None,
        exaggeration=float(istek.get("exaggeration", 0.5)),
        cfg_weight=float(istek.get("cfg", 0.5)),
        temperature=float(istek.get("temperature", 0.8)),
    )
    ses = wav.squeeze(0).detach().cpu().numpy().astype("float32")
    # baştaki ve sondaki sessizliği kırp ki cümle araları bizim kontrolümüzde olsun
    esik = max(1e-3, float(np.abs(ses).max()) * 0.02)
    dolu = np.where(np.abs(ses) > esik)[0]
    if len(dolu):
        pay = int(m.sr * 0.04)
        ses = ses[max(0, dolu[0] - pay) : min(len(ses), dolu[-1] + pay)]
    os.makedirs(os.path.dirname(istek["cikti"]) or ".", exist_ok=True)
    sf.write(istek["cikti"], ses, m.sr, subtype="PCM_16")
    return {"sure": len(ses) / m.sr, "sr": m.sr}


def main():
    if "--indir" in sys.argv:
        from huggingface_hub import snapshot_download

        snapshot_download(
            repo_id="ResembleAI/chatterbox",
            repo_type="model",
            revision="main",
            allow_patterns=["ve.pt", "t3_mtl23ls_v2.safetensors", "s3gen.pt", "grapheme_mtl_merged_expanded_v1.json", "conds.pt", "Cangjie5_TC.json"],
        )
        print("model indirildi", flush=True)
        return
    for satir in sys.stdin:
        satir = satir.strip()
        if not satir:
            continue
        try:
            istek = json.loads(satir)
        except Exception:
            continue
        kimlik = istek.get("id")
        try:
            if istek.get("komut") == "uret":
                cevap({"id": kimlik, "tamam": True, **uret(istek)})
            elif istek.get("komut") == "durum":
                import torch

                cevap({"id": kimlik, "tamam": True, "cihaz": cihaz(), "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None})
            else:
                cevap({"id": kimlik, "hata": "bilinmeyen komut"})
        except Exception as e:  # noqa: BLE001
            mesaj = str(e)
            if "CUDA out of memory" in mesaj:
                mesaj = "Ekran kartı belleği yetmedi. Başka programları kapatıp tekrar dene."
            cevap({"id": kimlik, "hata": mesaj[:1500]})


if __name__ == "__main__":
    main()
