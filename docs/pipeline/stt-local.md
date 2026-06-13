# STT local (faster-whisper) — `lib/whisper-local.js`

Fallback de transcripción de voz a texto (STT) que corre **offline** en la máquina
del pipeline. Se usa cuando la API paga de OpenAI falla por cuota/auth/red. El audio
del operador (voice notes de Telegram, `/rechazar` por audio) **nunca sale de la
máquina**.

Migrado en el issue **#3916** (épica #3915) desde el CLI `openai-whisper` (PyTorch,
modelo `small`) a **faster-whisper (CTranslate2)** con `large-v3-turbo` int8.

## Componentes

| Archivo | Rol |
|---|---|
| `.pipeline/lib/whisper-local.js` | Wrapper Node: contrato `{ok,text,confidence?,errorKind,raw}`, `isAvailable()`, `resolveBinary()`, `parseWhisperJson()`, single-flight, cap de bytes, timeout. |
| `.pipeline/lib/whisper_fw.py` | Wrapper Python spawneado: carga el modelo CTranslate2 y transcribe. Emite **JSON** (`{text, language, segments:[{avg_logprob, no_speech_prob, text}]}`). |
| `.pipeline/lib/__tests__/whisper-local.test.js` | Tests de contrato (spawn mockeado) + WER comparativo (opt-in). |
| `.pipeline/lib/__tests__/fixtures/audio-es-ar/` | Audios es-AR de referencia + transcripción canónica `.txt`. |

## Dependencias pineadas (R2 — supply chain)

Instaladas en `C:/Python314` (Python 3.14.3). **Cero deps pip nuevas** respecto del
estado previo. Versiones exactas a registrar para reaccionar ante CVEs:

```
faster-whisper   1.2.1
ctranslate2      4.7.1   (C++ nativo, wheel binario)
av               17.0.0  (PyAV / libav — decodifica el audio de entrada)
```

## Modelo y revisión pineada (R1 — supply chain del modelo)

- Repo HF: `mobiuslabsgmbh/faster-whisper-large-v3-turbo`
  (alias de `_MODELS['large-v3-turbo']` en faster-whisper 1.2.1).
- **Revisión pineada (commit SHA):** `0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`
  - Declarada en `whisper_fw.py` (`MODEL_REVISION`).
  - El runtime corre con `HF_HUB_OFFLINE=1` + `local_files_only=True` → **nunca toca
    la red** ni puede recibir un modelo sustituido.
  - Prohibido `trust_remote_code=True`.
- Formato CTranslate2 (binario, no-pickle): menor superficie de ataque que los `.pt`
  de PyTorch (pickles deserializables).

### Provisioning del modelo (una vez, ~1.6 GB, requiere red)

```bash
/c/Python314/python.exe -c "
from huggingface_hub import snapshot_download
snapshot_download('mobiuslabsgmbh/faster-whisper-large-v3-turbo',
    revision='0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
    allow_patterns=['config.json','model.bin','preprocessor_config.json','tokenizer.json','vocabulary.json'])
"
```

Queda cacheado en
`~/.cache/huggingface/hub/models--mobiuslabsgmbh--faster-whisper-large-v3-turbo/snapshots/<sha>/`.

### Actualizar la revisión pineada

1. Resolver el nuevo SHA con `HfApi().repo_info(<repo>).sha`.
2. Pre-descargar con ese `revision`.
3. Actualizar `MODEL_REVISION` en `whisper_fw.py` y este doc.
4. Correr el test WER (`WHISPER_WER=1`) para verificar no-regresión de calidad.

## Variables de entorno

| Var | Default | Descripción |
|---|---|---|
| `WHISPER_LOCAL_MODEL` | `large-v3-turbo` | Modelo a usar (tiny/small/medium/large-v3-turbo/large-v3). |
| `WHISPER_LOCAL_LANGUAGE` | `es` | Idioma. Acepta legado `Spanish` → mapeado a `es`. |
| `WHISPER_LOCAL_THREADS` | `4` | `cpu_threads` de CTranslate2. |
| `WHISPER_LOCAL_TIMEOUT_MS` | `300000` | Timeout con SIGKILL (5 min). |
| `WHISPER_LOCAL_MAX_BYTES` | `26214400` (~25 MB) | Cap de tamaño del audio de entrada (R3). |
| `WHISPER_LOCAL_BIN` | — | Override del intérprete Python (config local; no leer de fuentes remotas). |

## Invariantes de seguridad implementados (R1–R6 del análisis de security)

- **R1**: revisión pineada + `HF_HUB_OFFLINE=1` + `local_files_only=True`, sin
  `trust_remote_code`.
- **R3**: audio de entrada decodificado en **proceso separado** (spawn), con
  **timeout + SIGKILL** y **cap de bytes** antes de invocar el motor.
- **R5**: `spawn(bin, args[])` **sin shell** (argv como array); cleanup de temporales
  (`.ogg` de entrada + output dir) en `finally`.
- **R6**: **lock single-flight** a nivel módulo — una sola transcripción a la vez;
  concurrentes reciben `errorKind: 'busy'`. Evita que dos cargas de ~2 GB tiren la
  máquina que también corre builds.
- **R4**: contrato `{ok,text,errorKind,raw}` + firma `transcribeLocal/isAvailable`
  intactos (CA-4). El test de no-regresión `commander-rechazar.test.js` (CA-9 /
  SEC-1.2) corre verde **sin modificación**.

## Confianza STT (`confidence`) — integración con EP1-H3 (#3918/#3995)

El gate de confirmación por baja confianza del Commander consume
`confidence: {avgLogprob, noSpeechProb}`. faster-whisper expone esas métricas por
segmento (`avg_logprob`, `no_speech_prob`): `whisper_fw.py` las vuelca al JSON de
salida y `whisper-local.js` las deriva con `parseWhisperJson` (promedio de
`avg_logprob`, máximo de `no_speech_prob`). La extensión es **aditiva**: si el JSON
viene sin métricas finitas, `confidence` se omite ("confianza desconocida") y el
`text` sale igual. Tests: `whisper-local-confidence.test.js`,
`stt-confidence-gate.test.js`, `transcript-echo.test.js` (no-regresión).

## Tests

```bash
# Contrato (spawn mockeado, sin modelo real) — apto para CI:
node --test .pipeline/lib/__tests__/whisper-local.test.js

# No-regresión del contrato (commander):
node --test .pipeline/lib/__tests__/commander-rechazar.test.js

# WER comparativo turbo vs small (corre el modelo real, LENTO ~2 min) — opt-in:
HF_HUB_OFFLINE=1 WHISPER_WER=1 node --test .pipeline/lib/__tests__/whisper-local.test.js
```

## Benchmark (máquina del pipeline — i5-1145G7, 4C/8T, idle)

Audio es-AR de **57,4 s** (`edge-tts`, voz `es-AR-ElenaNeural`), `large-v3-turbo`
int8, `beam_size=1`, `vad_filter=True`, `condition_on_previous_text=False`,
`cpu_threads=4`:

| Métrica | Valor | Criterio | Resultado |
|---|---|---|---|
| **RAM pico** | **2084 MB** | CA-2: < 2,5 GB | ✅ **CUMPLE** |
| **Tiempo total** (carga + transcripción) | **~45,5 s** | CA-1: < 30 s / min | ❌ **NO CUMPLE** |
| — desglose: import faster_whisper | ~2,2 s | | |
| — desglose: carga del modelo (SSD) | ~3,7 s | | |
| — desglose: **transcripción pura** | **~40 s** | | |
| **WER** (turbo vs `small`, 4 fixtures es-AR) | turbo **0,244** / small 0,280 | CA-3: turbo ≤ small | ✅ **CUMPLE** |

### CA-1 — hallazgo: infeasible en este hardware con este modelo

El benchmark (obligatorio por la receta del issue antes de dar CA-1 por cumplido)
muestra que **CA-1 no se cumple y no es alcanzable por tuning** en la máquina del
pipeline:

- La **transcripción pura** ya tarda **~40 s** (> 30 s del budget), antes de sumar
  import (~2 s) y carga del modelo (~4 s).
- El modelo `small` transcribe el **mismo** audio en **~13 s** (~4,4× realtime).
  `large-v3-turbo` tarda **~40 s** (~1,4× realtime): es **~3× más lento** que `small`
  pese a tener menos capas de decoder, porque su **encoder grande (32 capas)** domina
  el costo en CPU.
- Probado y descartado como mitigación: `cpu_threads` 4 vs 8 (8 es peor, contención
  de hyperthreading), `vad_filter` on/off (~2 s de diferencia), `compute_type`
  `int8` / `int8_float32` (iguales) / `int16` (mucho peor). `int8` + `threads=4` es
  el óptimo.
- **Plan B (worker Python persistente) NO resuelve CA-1**: solo ahorra el import +
  carga (~6 s); la transcripción sola (~40 s) ya excede el budget.

La predicción de definición (`guru`: 3–6× realtime → ~10–20 s) sobreestimó el
rendimiento del encoder turbo en una CPU U-series de laptop. El resto de la migración
(privacidad, calidad superior a la API, offline, seguridad R1–R6, CA-2/CA-3/CA-4)
se cumple. **CA-1 requiere una decisión de producto** (relajar el budget de latencia
para un path de fallback, o elegir un modelo más liviano que balancee
velocidad/calidad, p.ej. `distil-large-v3` o mantener `small`).
