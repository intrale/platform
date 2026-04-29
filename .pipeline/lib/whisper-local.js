// whisper-local.js — Fallback STT con whisper local (Python OpenAI Whisper CLI)
// Cuando la API de OpenAI falla por cuota/auth/network, transcribimos offline
// con el binario `whisper.exe` instalado vía pip. Cero dependencia de cuota.
//
// Devuelve siempre la misma forma que el wrapper de la API:
//   { ok: true,  text: string }
//   { ok: false, text: '', errorKind: string, raw: string }

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Modelo por defecto: large-v3-turbo — calidad casi igual a large-v3 pero ~5x
// más rápido y con buen reconocimiento de español rioplatense. Se puede pisar
// con WHISPER_LOCAL_MODEL (small/medium/large-v3-turbo/large-v3).
const DEFAULT_MODEL = process.env.WHISPER_LOCAL_MODEL || 'large-v3-turbo';
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
    '--output_format', 'txt',
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
      // El CLI escribe <basename(input, no ext)>.txt en outDir.
      const base = path.basename(inputPath).replace(/\.[^.]+$/, '');
      const txtPath = path.join(outDir, `${base}.txt`);
      try {
        if (!fs.existsSync(txtPath)) {
          resolve({ ok: false, text: '', errorKind: 'no_output', raw: `no se generó ${path.basename(txtPath)}` });
          return;
        }
        const text = fs.readFileSync(txtPath, 'utf8').trim();
        resolve({ ok: true, text });
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
  DEFAULT_MODEL,
};
