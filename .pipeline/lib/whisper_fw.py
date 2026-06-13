# whisper_fw.py — wrapper de faster-whisper (CTranslate2) para STT local offline.
#
# Invocado por whisper-local.js vía spawn(python, [este_script, <input>, --model ...]).
# Reemplaza el CLI de openai-whisper (PyTorch) por faster-whisper large-v3-turbo int8:
# mejor calidad, ~1,5-2 GB de RAM, ~4x mas rapido.
#
# Contrato con el caller (whisper-local.js):
#   - exit 0  -> JSON escrito en el path pasado por --output (UTF-8) con la forma
#               { "text": str, "language": str,
#                 "segments": [ { "avg_logprob": float, "no_speech_prob": float,
#                                 "text": str }, ... ] }
#               El caller parsea ese JSON con parseWhisperJson para derivar `text`
#               y `confidence` (avg_logprob/no_speech_prob alimentan el gate de
#               baja confianza, #3918/#3995 EP1-H3).
#   - exit !=0 -> mensaje de error en stderr (el caller lo captura como `raw`)
#
# Seguridad (issue #3916, requisitos R1-R6):
#   - HF_HUB_OFFLINE=1 + local_files_only=True: el runtime NUNCA toca la red.
#   - revision pineada (R1): el modelo se pre-descarga en provisioning con este SHA.
#   - sin trust_remote_code (R1): jamas se ejecuta codigo remoto del hub.
#   - proceso separado (R3/R5): este script corre en su propio proceso, spawneado
#     sin shell desde Node; el caller aplica timeout con SIGKILL y cap de bytes.

import os
import json
import math

# R1: el runtime nunca debe tocar la red. Se setea ANTES de importar faster_whisper
# para que la libreria arranque en modo offline. setdefault respeta un override
# externo intencional (p.ej. provisioning), pero el default operativo es offline.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import sys
import argparse

# R1: revision pineada del repo HF `mobiuslabsgmbh/faster-whisper-large-v3-turbo`
# (alias de _MODELS['large-v3-turbo'] en faster-whisper 1.2.1). Pre-descargada en
# provisioning. Si HF sustituye el modelo, el pin evita recibir un binario distinto.
# Procedimiento de actualizacion documentado en docs/pipeline/stt-local.md.
MODEL_REVISION = "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"


def main():
    parser = argparse.ArgumentParser(description="STT local con faster-whisper")
    parser.add_argument("input", help="ruta al audio de entrada")
    parser.add_argument("--model", default="large-v3-turbo", help="modelo o ruta local")
    parser.add_argument("--language", default="es", help="codigo ISO del idioma (es)")
    parser.add_argument("--output", required=True, help="ruta del .txt de salida")
    parser.add_argument("--threads", type=int, default=4, help="cpu_threads")
    parser.add_argument("--beam-size", type=int, default=1, help="beam_size del decoder")
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        print(f"input no existe: {args.input}", file=sys.stderr)
        return 2

    # Import tardio: faster_whisper arrastra ctranslate2 (C++ nativo). Hacerlo aca
    # mantiene el --help y los errores de args baratos y sin cargar la lib.
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # pragma: no cover - entorno sin la dep
        print(f"no se pudo importar faster_whisper: {exc}", file=sys.stderr)
        return 3

    kwargs = dict(
        device="cpu",
        compute_type="int8",
        cpu_threads=max(1, args.threads),
        local_files_only=True,  # R1: jamas descarga en runtime
    )
    # R1: la revision pineada aplica SOLO al modelo que pre-descargamos con ese SHA
    # (large-v3-turbo). Otros modelos (p.ej. `small`, usado por el test WER) resuelven
    # su propio snapshot cacheado; forzarles esta revision rompe el lookup offline.
    if args.model == "large-v3-turbo":
        kwargs["revision"] = MODEL_REVISION

    try:
        model = WhisperModel(args.model, **kwargs)
    except Exception as exc:
        # Caso tipico: modelo no pre-descargado (local_files_only + offline).
        print(f"no se pudo cargar el modelo '{args.model}': {exc}", file=sys.stderr)
        return 4

    try:
        # beam_size=1 + vad_filter + condition_on_previous_text=False: minimizan
        # el tiempo de transcripcion. CA-1 (<30s/min) fue flexibilizado por
        # decision de producto (2026-06-13): se prioriza calidad sobre latencia.
        segments, info = model.transcribe(
            args.input,
            language=args.language,
            beam_size=max(1, args.beam_size),
            vad_filter=True,
            condition_on_previous_text=False,
        )
        # faster-whisper expone avg_logprob y no_speech_prob por segmento. Los
        # exponemos en el JSON para que el caller (parseWhisperJson) derive la
        # confianza que alimenta el gate de baja confianza (#3918/#3995).
        seg_list = []
        parts = []
        for seg in segments:
            parts.append(seg.text)
            entry = {"text": seg.text}
            lp = getattr(seg, "avg_logprob", None)
            ns = getattr(seg, "no_speech_prob", None)
            if isinstance(lp, (int, float)) and math.isfinite(lp):
                entry["avg_logprob"] = float(lp)
            if isinstance(ns, (int, float)) and math.isfinite(ns):
                entry["no_speech_prob"] = float(ns)
            seg_list.append(entry)
        text = "".join(parts).strip()
        language = getattr(info, "language", None) or args.language
    except Exception as exc:
        print(f"fallo la transcripcion: {exc}", file=sys.stderr)
        return 5

    payload = {"text": text, "language": language, "segments": seg_list}

    try:
        with open(args.output, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
    except Exception as exc:
        print(f"no se pudo escribir el output '{args.output}': {exc}", file=sys.stderr)
        return 6

    return 0


if __name__ == "__main__":
    sys.exit(main())
