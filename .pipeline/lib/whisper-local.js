// whisper-local.js — Fallback STT con whisper local (faster-whisper / CTranslate2)
// Cuando la API de OpenAI falla por cuota/auth/network, transcribimos offline con
// faster-whisper `large-v3-turbo` int8 (script `whisper_fw.py` spawneado con python).
// Cero dependencia de cuota; el audio del operador nunca sale de la máquina.
//
// Migrado desde el CLI openai-whisper (PyTorch, modelo `small`) en el issue #3916
// (EP1-H1). El contrato hacia los consumidores NO cambia (CA-4): misma firma y
// misma forma de retorno:
//   { ok: true,  text: string, confidence?: {avgLogprob, noSpeechProb} }
//   { ok: false, text: '', errorKind: string, raw: string }
//
// #5336 (CA-1): el corte por duracion dejo de ser mecanismo de falla. Se mata por
// AUSENCIA DE PROGRESO (`stalled`), no por tardar. `timeout` queda solo como
// guarda absoluta de ultimo recurso. Ver el bloque de constantes mas abajo.
// errorKind nuevo: 'stalled'. Los consumidores que no lo conozcan caen en el
// `default` de transcriptionFailureMessage (degradacion segura).
//
// #3918/#3995 (EP1-H3, CA-2): `whisper_fw.py` emite JSON con
// `segments[].avg_logprob` y `no_speech_prob`, que alimentan el gate de
// confirmación por baja confianza. La extensión es ADITIVA: `confidence` sólo
// aparece cuando el parseo defensivo (RS-6) pudo derivar métricas finitas; si el
// JSON viene malformado o sin métricas, se omite `confidence` (→ "confianza
// desconocida" aguas abajo) y el `text` sigue saliendo igual. La interfaz no
// cambia para los consumidores existentes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Modelo por defecto: large-v3-turbo int8 (~1,5-2 GB de RAM). Reemplaza a `small`:
// mejor calidad que la API paga (WER 0,244 < 0,280). La transcripción tarda
// ~45 s/min en la CPU del pipeline (CA-1 flexibilizado por decisión de producto,
// 2026-06-13: se prioriza calidad sobre latencia). La máquina (i5, 16 GB) lo
// soporta con el lock single-flight de abajo. Pisar con WHISPER_LOCAL_MODEL
// (tiny/small/medium/large-v3-turbo/large-v3) si hace falta.
const DEFAULT_MODEL = process.env.WHISPER_LOCAL_MODEL || 'large-v3-turbo';

// Idioma por defecto: código ISO `es` (lo exige la API de faster-whisper). El CLI
// viejo usaba `Spanish`; mantenemos compat hacia atrás para no romper instalaciones
// con WHISPER_LOCAL_LANGUAGE ya seteado en el formato anterior.
const LANGUAGE_COMPAT = {
  spanish: 'es',
  'español': 'es',
  espanol: 'es',
  english: 'en',
  'inglés': 'en',
  ingles: 'en',
  portuguese: 'pt',
  'português': 'pt',
};
function normalizeLanguage(lang) {
  if (!lang) return 'es';
  const key = String(lang).trim().toLowerCase();
  if (!key) return 'es';
  return LANGUAGE_COMPAT[key] || key; // si ya viene 'es'/'en', pasa derecho
}
const DEFAULT_LANGUAGE = normalizeLanguage(process.env.WHISPER_LOCAL_LANGUAGE || 'es');

const DEFAULT_THREADS = Number(process.env.WHISPER_LOCAL_THREADS || 4);

// Issue #5336 (CA-1) — El corte por DURACION deja de ser un mecanismo de falla.
//
// Antes: 5 min de reloj de pared y SIGKILL. Con la maquina cargada de agentes,
// un audio normal de ~2 min superaba ese tope y se perdia trabajo perfectamente
// valido (incidente del 2026-08-01: dos audios del operador descartados que al
// reprocesarlos con la maquina libre salieron completos).
//
// Ahora hay dos relojes con roles distintos:
//
//  1. IDLE (el que realmente decide): matamos solo si el motor dejo de dar
//     senales de vida durante esta ventana. Mientras emita latidos por stderr
//     (`[fw-progress]` de whisper_fw.py) el proceso sigue vivo sin importar
//     cuanto lleve. Distingue "lento" de "colgado", que es la distincion que
//     el reloj de pared no podia hacer.
//     La ventana cubre el peor caso de carga del modelo, que es la etapa mas
//     larga sin latidos posibles (llamada nativa bloqueante).
//
//  2. GUARDA ABSOLUTA: red de seguridad de ultimo recurso contra un proceso que
//     late pero nunca termina. Deliberadamente un orden de magnitud sobre el
//     peor caso medido, para no volver a ser el que descarta trabajo valido.
//
// Ambos pisables por env. `timeoutMs` (parametro) sigue mapeando a la guarda
// absoluta por compat con los callers historicos.
const DEFAULT_TIMEOUT_MS = Number(process.env.WHISPER_LOCAL_TIMEOUT_MS || 6 * 60 * 60 * 1000); // 6 h (guarda)
const DEFAULT_IDLE_TIMEOUT_MS = Number(process.env.WHISPER_LOCAL_IDLE_TIMEOUT_MS || 15 * 60 * 1000); // 15 min sin latidos

// Latidos que emite whisper_fw.py. NO son errores: se excluyen del `raw` que se
// le muestra al usuario/log ante exit != 0 para que el tail muestre la causa real
// y no las ultimas 3 lineas de progreso. Contrato acoplado a PROGRESS_PREFIX.
const PROGRESS_LINE_RE = /^\s*\[fw-progress\]/;

// Frecuencia de chequeo del watchdog. Las ventanas son de minutos/horas, asi que
// 5 s sobra y el costo es despreciable. Pisable solo para que los tests no tengan
// que esperar segundos reales.
const WATCHDOG_TICK_MS = Number(process.env.WHISPER_LOCAL_WATCHDOG_TICK_MS || 5000);
// R3 (security): cap de tamaño del audio de entrada antes de spawnear el motor.
// Telegram limita las voice notes, pero el módulo acepta audioPath/audioBuffer
// arbitrarios de otros consumidores. Default ~25 MB.
const DEFAULT_MAX_BYTES = Number(process.env.WHISPER_LOCAL_MAX_BYTES || 25 * 1024 * 1024);

// Path del wrapper Python que invoca faster-whisper. Vive junto a este módulo.
const FW_SCRIPT = path.join(__dirname, 'whisper_fw.py');

// R6 (security): lock single-flight a nivel módulo. Dos transcripciones concurrentes
// con large-v3-turbo int8 (~2 GB c/u) pueden tirar la máquina del pipeline que
// también corre builds. Una sola transcripción a la vez; el resto recibe `busy`.
let inFlight = false;

// Resolución del intérprete Python: WHISPER_LOCAL_BIN > rutas conocidas > "python".
// (CA-4) Se mantiene el nombre `resolveBinary` en el contrato público: antes resolvía
// whisper.exe, ahora resuelve el intérprete que ejecuta whisper_fw.py.
function resolveBinary() {
  if (process.env.WHISPER_LOCAL_BIN && fs.existsSync(process.env.WHISPER_LOCAL_BIN)) {
    return process.env.WHISPER_LOCAL_BIN;
  }
  const candidates = [
    'C:/Python314/python.exe',
    'C:/Python313/python.exe',
    'C:/Python312/python.exe',
    'C:/Python311/python.exe',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'python'; // confiamos en PATH
}

function isAvailable() {
  try {
    if (!fs.existsSync(FW_SCRIPT)) return false; // sin el wrapper no hay motor
    const bin = resolveBinary();
    if (bin === 'python') return true; // asumimos PATH; el spawn fallará limpio si no
    return fs.existsSync(bin);
  } catch { return false; }
}

// #3918 (RS-6) — Parseo DEFENSIVO del JSON que produce `whisper_fw.py`. La forma
// esperada es:
//   { "text": "…", "segments": [{ "avg_logprob": -0.3, "no_speech_prob": 0.1, … }], … }
// Nada de esto está garantizado: el proceso es externo, puede cambiar de versión
// o emitir output corrupto. Reglas:
//   - `JSON.parse` dentro de try/catch; cualquier excepción → texto null.
//   - El texto sale aunque la confianza falle (degradación independiente).
//   - La confianza sólo se devuelve si pudimos derivar al menos UNA métrica
//     finita; si todos los segmentos traen basura → confidence omitida
//     ("confianza desconocida"). NUNCA NaN/Infinity hacia afuera.
//
// @param {string} raw - contenido del .json producido por whisper_fw.py.
// @returns {{text: string|null, confidence: {avgLogprob: number, noSpeechProb: number}|null}}
function parseWhisperJson(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { text: null, confidence: null };
  }
  if (!data || typeof data !== 'object') return { text: null, confidence: null };

  const text = typeof data.text === 'string' ? data.text.trim() : null;

  let confidence = null;
  try {
    const segments = Array.isArray(data.segments) ? data.segments : [];
    const logprobs = [];
    const noSpeechProbs = [];
    for (const seg of segments) {
      if (!seg || typeof seg !== 'object') continue;
      const lp = seg.avg_logprob;
      const ns = seg.no_speech_prob;
      if (typeof lp === 'number' && Number.isFinite(lp)) logprobs.push(lp);
      if (typeof ns === 'number' && Number.isFinite(ns)) noSpeechProbs.push(ns);
    }
    // avgLogprob: promedio de los segmentos válidos (señal global de confianza).
    // noSpeechProb: máximo (el segmento más "silencioso" es el más sospechoso).
    const partial = {};
    if (logprobs.length > 0) {
      partial.avgLogprob = logprobs.reduce((a, b) => a + b, 0) / logprobs.length;
    }
    if (noSpeechProbs.length > 0) {
      partial.noSpeechProb = Math.max(...noSpeechProbs);
    }
    if (
      (typeof partial.avgLogprob === 'number' && Number.isFinite(partial.avgLogprob)) ||
      (typeof partial.noSpeechProb === 'number' && Number.isFinite(partial.noSpeechProb))
    ) {
      confidence = partial;
    }
  } catch {
    confidence = null; // RS-6: jamás romper por el parseo de confianza.
  }

  return { text, confidence };
}

// Transcribe un audio offline. Acepta tanto un path en disco como un buffer.
// Si recibe buffer, lo escribe a un .ogg temporal antes de invocar el motor.
async function transcribeLocal({ audioPath, audioBuffer, model, language, threads, timeoutMs, idleTimeoutMs, maxBytes, logger, onProgress } = {}) {
  const log = logger || (() => {});
  const bin = resolveBinary();
  if (bin !== 'python' && !fs.existsSync(bin)) {
    return { ok: false, text: '', errorKind: 'no_binary', raw: `intérprete Python no encontrado (probé ${bin})` };
  }
  if (!fs.existsSync(FW_SCRIPT)) {
    return { ok: false, text: '', errorKind: 'no_binary', raw: `wrapper no encontrado (${FW_SCRIPT})` };
  }

  // Validaciones baratas ANTES de tomar el lock (no consumen el motor).
  if (!audioPath && !audioBuffer) {
    return { ok: false, text: '', errorKind: 'no_input', raw: 'falta audioPath o audioBuffer' };
  }
  if (audioPath && !audioBuffer && !fs.existsSync(audioPath)) {
    return { ok: false, text: '', errorKind: 'missing_file', raw: `no existe ${audioPath}` };
  }

  // R3: cap de tamaño antes de cualquier spawn. Para buffer, medimos en memoria;
  // para path, con stat. Rechazamos sin tocar el motor.
  const cap = Number(maxBytes || DEFAULT_MAX_BYTES);
  let inputBytes = 0;
  try {
    inputBytes = audioBuffer ? audioBuffer.length : fs.statSync(audioPath).size;
  } catch (e) {
    return { ok: false, text: '', errorKind: 'missing_file', raw: e.message };
  }
  if (cap > 0 && inputBytes > cap) {
    return { ok: false, text: '', errorKind: 'too_large', raw: `audio ${inputBytes}B supera el cap de ${cap}B` };
  }

  // R6: single-flight. Si ya hay una transcripción en curso, devolvemos `busy`
  // sin encolar (el caller decide reintentar). Tomamos el lock acá, ya pasadas las
  // validaciones, y lo liberamos sí o sí en el finally de abajo.
  if (inFlight) {
    return { ok: false, text: '', errorKind: 'busy', raw: 'ya hay una transcripción local en curso' };
  }
  inFlight = true;

  // Si nos pasan un buffer, materializamos a temp para que el motor lo lea.
  let inputPath = audioPath;
  let cleanupInput = false;
  let outDir = null;
  try {
    if (!inputPath) {
      const tmpName = `wlocal-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.ogg`;
      inputPath = path.join(os.tmpdir(), tmpName);
      fs.writeFileSync(inputPath, audioBuffer);
      cleanupInput = true;
    }

    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlocal-out-'));
    // whisper_fw.py escribe JSON (text + segments con avg_logprob/no_speech_prob)
    // en este path explícito. El parseo de confianza vive en parseWhisperJson.
    const outputPath = path.join(outDir, 'out.json');
    const args = [
      FW_SCRIPT,
      inputPath,
      '--model', model || DEFAULT_MODEL,
      '--language', normalizeLanguage(language || DEFAULT_LANGUAGE),
      '--output', outputPath,
      '--threads', String(threads || DEFAULT_THREADS),
    ];

    log(`[whisper-local] bin=${bin} model=${model || DEFAULT_MODEL} input=${path.basename(inputPath)} (${inputBytes}B)`);

    const t0 = Date.now();
    const result = await new Promise((resolve) => {
      let proc;
      try {
        // R5: spawn sin shell, argv como array. Nada se interpola en un shell.
        proc = spawn(bin, args, { windowsHide: true });
      } catch (e) {
        resolve({ ok: false, text: '', errorKind: 'spawn_error', raw: e.message });
        return;
      }

      const guardMs = Number(timeoutMs || DEFAULT_TIMEOUT_MS);
      const idleMs = Number(idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS);

      let stderr = '';
      // Cualquier byte del motor cuenta como senal de vida, no solo los latidos
      // con prefijo: un traceback a medio escribir tambien prueba que el proceso
      // esta vivo. El prefijo solo sirve para separar progreso de error real.
      let lastProgressAt = Date.now();
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        resolve(value);
      };

      proc.stderr.on('data', (c) => {
        lastProgressAt = Date.now();
        const chunk = c.toString();
        // Los latidos NO se acumulan en `stderr`: una transcripcion larga emite
        // miles y harian crecer el buffer sin cota (y taparian el error real en
        // el tail de 3 lineas).
        const meaningful = chunk
          .split(/\r?\n/)
          .filter((ln) => ln.trim() && !PROGRESS_LINE_RE.test(ln))
          .join('\n');
        if (meaningful) stderr += meaningful + '\n';
        if (onProgress) {
          for (const ln of chunk.split(/\r?\n/)) {
            if (PROGRESS_LINE_RE.test(ln)) {
              try { onProgress(ln.trim()); } catch { /* nunca romper por el callback */ }
            }
          }
        }
      });
      proc.stdout.on('data', () => { lastProgressAt = Date.now(); });

      // Un solo timer periodico cubre los dos relojes. Se chequea cada 5 s: no
      // hace falta mas precision para ventanas de minutos/horas y es barato.
      const watchdog = setInterval(() => {
        const now = Date.now();
        if (now - lastProgressAt >= idleMs) {
          try { proc.kill('SIGKILL'); } catch {}
          finish({
            ok: false, text: '', errorKind: 'stalled',
            raw: `el motor dejó de dar señales de vida por ${Math.round(idleMs / 1000)}s`,
          });
          return;
        }
        if (now - t0 >= guardMs) {
          try { proc.kill('SIGKILL'); } catch {}
          finish({
            ok: false, text: '', errorKind: 'timeout',
            raw: `superó la guarda absoluta de ${Math.round(guardMs / 1000)}s`,
          });
        }
      }, WATCHDOG_TICK_MS);
      // No mantener vivo el event loop del proceso Node por este interval.
      if (typeof watchdog.unref === 'function') watchdog.unref();

      proc.on('error', (e) => {
        finish({ ok: false, text: '', errorKind: 'spawn_error', raw: e.message });
      });

      proc.on('close', (code) => {
        if (settled) return; // ya lo mato el watchdog; no pisar el errorKind real
        if (code !== 0) {
          const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 400);
          finish({ ok: false, text: '', errorKind: 'cli_error', raw: `exit ${code}: ${tail}` });
          return;
        }
        try {
          if (!fs.existsSync(outputPath)) {
            finish({ ok: false, text: '', errorKind: 'no_output', raw: `no se generó ${path.basename(outputPath)}` });
            return;
          }
          const raw = fs.readFileSync(outputPath, 'utf8');
          const parsed = parseWhisperJson(raw);
          if (parsed.text === null) {
            // No pudimos siquiera extraer texto → salida vacía. No inventamos
            // confianza (RS-6).
            finish({ ok: false, text: '', errorKind: 'no_output', raw: 'JSON de whisper sin campo `text` utilizable' });
            return;
          }
          const out = { ok: true, text: parsed.text };
          if (parsed.confidence) out.confidence = parsed.confidence; // aditivo
          finish(out);
        } catch (e) {
          finish({ ok: false, text: '', errorKind: 'read_error', raw: e.message });
        }
      });
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (result.ok) {
      log(`[whisper-local] OK en ${elapsed}s — "${result.text.slice(0, 80)}"`);
    } else {
      log(`[whisper-local] FAIL (${result.errorKind}) en ${elapsed}s — ${result.raw}`);
    }
    return result;
  } finally {
    // Cleanup de temporales (R5) + liberación idempotente del lock (R6).
    if (outDir) { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {} }
    if (cleanupInput && inputPath) { try { fs.unlinkSync(inputPath); } catch {} }
    inFlight = false;
  }
}

module.exports = {
  transcribeLocal,
  isAvailable,
  resolveBinary,
  normalizeLanguage,
  parseWhisperJson,
  DEFAULT_MODEL,
  // #5336 (CA-1): expuestos para que los tests y el orquestador (multimedia.js)
  // razonen sobre los relojes sin duplicar los defaults.
  DEFAULT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
};
