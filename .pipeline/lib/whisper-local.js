// whisper-local.js — Fallback STT con whisper local (Python OpenAI Whisper CLI)
// Cuando la API de OpenAI falla por cuota/auth/network, transcribimos offline
// con el binario `whisper.exe` instalado vía pip. Cero dependencia de cuota.
//
// Devuelve siempre la misma forma que el wrapper de la API:
//   { ok: true,  text: string, confidence?: {avgLogprob, noSpeechProb} }
//   { ok: false, text: '', errorKind: string, raw: string }
//
// #3918 (EP1-H3, CA-2): cambiamos `--output_format txt` → `json` para exponer
// `segments[].avg_logprob` y `no_speech_prob`, que alimentan el gate de
// confirmación por baja confianza. La extensión es ADITIVA: `confidence` sólo
// aparece cuando el parseo defensivo (RS-6) pudo derivar métricas finitas; si el
// JSON viene malformado o sin métricas, se omite `confidence` (→ "confianza
// desconocida" aguas abajo) y el `text` sigue saliendo igual. La interfaz no
// cambia para los consumidores existentes (compat con #3916/H1).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Modelo por defecto: small — la máquina con pipeline+builds tiene <3 GB libres
// habitualmente, y medium (~5 GB) hace timeout o crashea (ACCESS_VIOLATION) cuando
// el audio es largo. small (~2 GB) entra siempre y transcribe español rioplatense
// con calidad aceptable. Si la máquina está libre y se quiere más calidad, pisar
// con WHISPER_LOCAL_MODEL (small/medium/large-v3-turbo/large-v3).
const DEFAULT_MODEL = process.env.WHISPER_LOCAL_MODEL || 'small';
const DEFAULT_LANGUAGE = process.env.WHISPER_LOCAL_LANGUAGE || 'Spanish';
const DEFAULT_THREADS = Number(process.env.WHISPER_LOCAL_THREADS || 4);
const DEFAULT_TIMEOUT_MS = Number(process.env.WHISPER_LOCAL_TIMEOUT_MS || 300000); // 5 min

// Resolución del binario: WHISPER_LOCAL_BIN > rutas conocidas > "whisper" en PATH
function resolveBinary() {
  if (process.env.WHISPER_LOCAL_BIN && fs.existsSync(process.env.WHISPER_LOCAL_BIN)) {
    return process.env.WHISPER_LOCAL_BIN;
  }
  const candidates = [
    'C:/Python314/Scripts/whisper.exe',
    'C:/Python313/Scripts/whisper.exe',
    'C:/Python312/Scripts/whisper.exe',
    'C:/Python311/Scripts/whisper.exe',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'whisper'; // confiamos en PATH
}

function isAvailable() {
  try {
    const bin = resolveBinary();
    if (bin === 'whisper') return true; // asumimos PATH; el spawn fallará limpio si no
    return fs.existsSync(bin);
  } catch { return false; }
}

// #3918 (RS-6) — Parseo DEFENSIVO del JSON que produce el CLI de whisper con
// `--output_format json`. La forma esperada es:
//   { "text": "…", "segments": [{ "avg_logprob": -0.3, "no_speech_prob": 0.1, … }], … }
// Nada de esto está garantizado: el proceso es externo, puede cambiar de versión
// o emitir output corrupto. Reglas:
//   - `JSON.parse` dentro de try/catch; cualquier excepción → texto null.
//   - El texto sale aunque la confianza falle (degradación independiente).
//   - La confianza sólo se devuelve si pudimos derivar al menos UNA métrica
//     finita; si todos los segmentos traen basura → confidence omitida
//     ("confianza desconocida"). NUNCA NaN/Infinity hacia afuera.
//
// @param {string} raw - contenido del .json del CLI.
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
// Si recibe buffer, lo escribe a un .ogg temporal antes de invocar el CLI.
async function transcribeLocal({ audioPath, audioBuffer, model, language, threads, timeoutMs, logger } = {}) {
  const log = logger || (() => {});
  const bin = resolveBinary();
  if (bin !== 'whisper' && !fs.existsSync(bin)) {
    return { ok: false, text: '', errorKind: 'no_binary', raw: `whisper CLI no encontrado (probé ${bin})` };
  }

  // Si nos pasan un buffer, materializamos a temp para que el CLI lo lea.
  let inputPath = audioPath;
  let cleanupInput = false;
  if (!inputPath) {
    if (!audioBuffer) {
      return { ok: false, text: '', errorKind: 'no_input', raw: 'falta audioPath o audioBuffer' };
    }
    const tmpName = `wlocal-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.ogg`;
    inputPath = path.join(os.tmpdir(), tmpName);
    fs.writeFileSync(inputPath, audioBuffer);
    cleanupInput = true;
  } else if (!fs.existsSync(inputPath)) {
    return { ok: false, text: '', errorKind: 'missing_file', raw: `no existe ${inputPath}` };
  }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlocal-out-'));
  const args = [
    inputPath,
    '--model', model || DEFAULT_MODEL,
    '--language', language || DEFAULT_LANGUAGE,
    '--output_dir', outDir,
    '--output_format', 'json',
    '--fp16', 'False',
    '--threads', String(threads || DEFAULT_THREADS),
    '--verbose', 'False',
  ];

  log(`[whisper-local] bin=${bin} model=${model || DEFAULT_MODEL} input=${path.basename(inputPath)}`);

  const t0 = Date.now();
  const result = await new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, text: '', errorKind: 'spawn_error', raw: e.message });
      return;
    }

    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.stdout.on('data', () => {});

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve({ ok: false, text: '', errorKind: 'timeout', raw: `superó ${timeoutMs || DEFAULT_TIMEOUT_MS}ms` });
    }, timeoutMs || DEFAULT_TIMEOUT_MS);

    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, text: '', errorKind: 'spawn_error', raw: e.message });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 400);
        resolve({ ok: false, text: '', errorKind: 'cli_error', raw: `exit ${code}: ${tail}` });
        return;
      }
      // El CLI escribe <basename(input, no ext)>.json en outDir.
      const base = path.basename(inputPath).replace(/\.[^.]+$/, '');
      const jsonPath = path.join(outDir, `${base}.json`);
      try {
        if (!fs.existsSync(jsonPath)) {
          resolve({ ok: false, text: '', errorKind: 'no_output', raw: `no se generó ${path.basename(jsonPath)}` });
          return;
        }
        const raw = fs.readFileSync(jsonPath, 'utf8');
        const parsed = parseWhisperJson(raw);
        if (parsed.text === null) {
          // No pudimos siquiera extraer texto → tratamos como salida vacía. No
          // inventamos confianza (RS-6).
          resolve({ ok: false, text: '', errorKind: 'no_output', raw: 'JSON de whisper sin campo `text` utilizable' });
          return;
        }
        const out = { ok: true, text: parsed.text };
        if (parsed.confidence) out.confidence = parsed.confidence; // aditivo
        resolve(out);
      } catch (e) {
        resolve({ ok: false, text: '', errorKind: 'read_error', raw: e.message });
      }
    });
  });

  // Cleanup
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  if (cleanupInput) { try { fs.unlinkSync(inputPath); } catch {} }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (result.ok) {
    log(`[whisper-local] OK en ${elapsed}s — "${result.text.slice(0, 80)}"`);
  } else {
    log(`[whisper-local] FAIL (${result.errorKind}) en ${elapsed}s — ${result.raw}`);
  }
  return result;
}

module.exports = {
  transcribeLocal,
  isAvailable,
  resolveBinary,
  parseWhisperJson,
  DEFAULT_MODEL,
};
