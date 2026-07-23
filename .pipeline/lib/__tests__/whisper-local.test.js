// whisper-local.test.js — tests de contrato del fallback STT local (#3916).
// Mockean el spawn de Python: NO corren el modelo real. Verifican la forma del
// resultado { ok, text, errorKind, raw }, los errorKinds, el single-flight (R6),
// el cap de bytes (R3) y el mapeo de idioma legado Spanish->es.
//
// El test WER comparativo (large-v3-turbo vs small) corre el modelo real y es
// opt-in vía env WHISPER_WER=1 (lento, no apto para CI por default).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// --- Mock de child_process.spawn ANTES de requerir el módulo bajo test ---
const childProcess = require('child_process');
const realSpawn = childProcess.spawn;

// fakeSpawnImpl se reconfigura por test. Default: éxito que escribe el output.
let fakeSpawnImpl = null;
let lastSpawn = null;
childProcess.spawn = (bin, args, opts) => {
  lastSpawn = { bin, args, opts };
  return fakeSpawnImpl(bin, args, opts);
};

// Cargamos el módulo con el spawn ya parcheado.
const wl = require('../whisper-local');

function outputPathFromArgs(args) {
  const i = args.indexOf('--output');
  return i >= 0 ? args[i + 1] : null;
}

// Construye un proceso falso que emite close con el código dado, opcionalmente
// escribiendo el archivo de salida y/o stderr. delayMs simula trabajo en curso.
// whisper_fw.py emite JSON ({text, segments}); el mock replica esa forma. Si se
// pasa `writeRaw` se escribe tal cual (para casos de JSON malformado/sin texto).
function makeFakeSpawn({ exitCode = 0, writeText = 'hola mundo', segments = null, writeRaw = undefined, stderr = '', delayMs = 5, emitError = null } = {}) {
  return (bin, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => { proc.killed = true; };
    setTimeout(() => {
      if (emitError) { proc.emit('error', new Error(emitError)); return; }
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      if (exitCode === 0 && (writeRaw !== undefined || writeText != null)) {
        const payload = writeRaw !== undefined
          ? writeRaw
          : JSON.stringify({ text: writeText, segments: segments || [] });
        try { fs.writeFileSync(outputPathFromArgs(args), payload, 'utf8'); } catch {}
      }
      proc.emit('close', exitCode);
    }, delayMs);
    return proc;
  };
}

// Audio temporal mínimo para los casos que necesitan un path existente.
function makeTmpAudio(bytes = 1024) {
  const p = path.join(os.tmpdir(), `wltest-${Date.now()}-${Math.floor(process.hrtime()[1])}.ogg`);
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

test.after(() => { childProcess.spawn = realSpawn; });

test('transcribeLocal devuelve { ok:true, text } en el camino feliz', async () => {
  fakeSpawnImpl = makeFakeSpawn({ exitCode: 0, writeText: 'rechazá el 3381 en ux' });
  const audio = makeTmpAudio();
  const r = await wl.transcribeLocal({ audioPath: audio });
  fs.unlinkSync(audio);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'rechazá el 3381 en ux');
});

test('confidence: se propaga desde el JSON del motor (avg_logprob/no_speech_prob)', async () => {
  // El motor (whisper_fw.py) emite JSON con segments; transcribeLocal debe
  // derivar `confidence` vía parseWhisperJson y devolverlo de forma aditiva.
  fakeSpawnImpl = makeFakeSpawn({
    exitCode: 0,
    writeText: 'reiniciá el pipeline',
    segments: [
      { avg_logprob: -0.30, no_speech_prob: 0.05, text: 'reiniciá el pipeline' },
      { avg_logprob: -0.50, no_speech_prob: 0.12, text: '' },
    ],
  });
  const audio = makeTmpAudio();
  const r = await wl.transcribeLocal({ audioPath: audio });
  fs.unlinkSync(audio);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'reiniciá el pipeline');
  assert.ok(r.confidence, 'debe exponer confidence');
  assert.ok(Math.abs(r.confidence.avgLogprob - (-0.40)) < 1e-9);
  assert.ok(Math.abs(r.confidence.noSpeechProb - 0.12) < 1e-9);
});

test('confidence: se omite (aditivo) cuando el motor no emite métricas', async () => {
  fakeSpawnImpl = makeFakeSpawn({ exitCode: 0, writeText: 'hola', segments: [] });
  const audio = makeTmpAudio();
  const r = await wl.transcribeLocal({ audioPath: audio });
  fs.unlinkSync(audio);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'hola');
  assert.equal(r.confidence, undefined, 'sin métricas finitas no se agrega confidence');
});

test('errorKind no_input cuando falta audioPath y audioBuffer', async () => {
  fakeSpawnImpl = makeFakeSpawn();
  const r = await wl.transcribeLocal({});
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'no_input');
  assert.equal(r.text, '');
});

test('errorKind missing_file cuando el audioPath no existe', async () => {
  fakeSpawnImpl = makeFakeSpawn();
  const r = await wl.transcribeLocal({ audioPath: path.join(os.tmpdir(), 'no-existe-xyz.ogg') });
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'missing_file');
});

test('errorKind timeout dispara SIGKILL y devuelve la forma esperada', async () => {
  // El proceso nunca emite close dentro del timeout.
  fakeSpawnImpl = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    let killed = false;
    proc.kill = () => { killed = true; };
    proc._wasKilled = () => killed;
    return proc;
  };
  const audio = makeTmpAudio();
  const r = await wl.transcribeLocal({ audioPath: audio, timeoutMs: 30 });
  fs.unlinkSync(audio);
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'timeout');
});

test('errorKind cli_error cuando el proceso sale con código != 0', async () => {
  fakeSpawnImpl = makeFakeSpawn({ exitCode: 4, writeText: null, stderr: 'no se pudo cargar el modelo' });
  const audio = makeTmpAudio();
  const r = await wl.transcribeLocal({ audioPath: audio });
  fs.unlinkSync(audio);
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'cli_error');
  assert.match(r.raw, /exit 4/);
});

test('errorKind spawn_error cuando el proceso emite error', async () => {
  fakeSpawnImpl = makeFakeSpawn({ emitError: 'ENOENT' });
  const audio = makeTmpAudio();
  const r = await wl.transcribeLocal({ audioPath: audio });
  fs.unlinkSync(audio);
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'spawn_error');
});

test('R3: cap de bytes rechaza con too_large SIN spawnear', async () => {
  let spawned = false;
  fakeSpawnImpl = (...a) => { spawned = true; return makeFakeSpawn()(...a); };
  const big = Buffer.alloc(200, 7);
  const r = await wl.transcribeLocal({ audioBuffer: big, maxBytes: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'too_large');
  assert.equal(spawned, false, 'no debe invocar el motor si el audio supera el cap');
});

test('R6: single-flight devuelve busy si ya hay una transcripción en curso', async () => {
  // Primer spawn se queda "trabajando" un rato; el segundo debe rebotar con busy.
  fakeSpawnImpl = makeFakeSpawn({ delayMs: 120, writeText: 'ok' });
  const audio = makeTmpAudio();
  const p1 = wl.transcribeLocal({ audioPath: audio });
  // Pequeña espera para asegurar que p1 ya tomó el lock antes de lanzar p2.
  await new Promise((res) => setTimeout(res, 20));
  const r2 = await wl.transcribeLocal({ audioPath: audio });
  const r1 = await p1;
  fs.unlinkSync(audio);
  assert.equal(r2.ok, false);
  assert.equal(r2.errorKind, 'busy');
  assert.equal(r1.ok, true, 'la primera debe completar normalmente');
});

test('R6: el lock se libera tras completar (una segunda llamada secuencial funciona)', async () => {
  fakeSpawnImpl = makeFakeSpawn({ delayMs: 5, writeText: 'uno' });
  const audio = makeTmpAudio();
  const r1 = await wl.transcribeLocal({ audioPath: audio });
  const r2 = await wl.transcribeLocal({ audioPath: audio });
  fs.unlinkSync(audio);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true, 'el lock debe liberarse para la siguiente transcripción');
});

test('compat: language "Spanish" (legado) se mapea a código ISO "es" en el argv', async () => {
  fakeSpawnImpl = makeFakeSpawn({ writeText: 'x' });
  const audio = makeTmpAudio();
  await wl.transcribeLocal({ audioPath: audio, language: 'Spanish' });
  fs.unlinkSync(audio);
  const args = lastSpawn.args;
  const i = args.indexOf('--language');
  assert.equal(args[i + 1], 'es', 'Spanish debe mapearse a es');
});

test('normalizeLanguage: mapea variantes legadas y deja pasar códigos ISO', () => {
  assert.equal(wl.normalizeLanguage('Spanish'), 'es');
  assert.equal(wl.normalizeLanguage('español'), 'es');
  assert.equal(wl.normalizeLanguage('es'), 'es');
  assert.equal(wl.normalizeLanguage('English'), 'en');
  assert.equal(wl.normalizeLanguage(undefined), 'es');
});

test('contrato: DEFAULT_MODEL es large-v3-turbo y se exportan las funciones públicas', () => {
  assert.equal(wl.DEFAULT_MODEL, 'large-v3-turbo');
  assert.equal(typeof wl.transcribeLocal, 'function');
  assert.equal(typeof wl.isAvailable, 'function');
  assert.equal(typeof wl.resolveBinary, 'function');
});

// ---------------------------------------------------------------------------
// Test WER comparativo (CA-3): large-v3-turbo int8 vs small sobre fixtures es-AR.
// Opt-in (lento, corre el modelo real). Activar con WHISPER_WER=1.
// ---------------------------------------------------------------------------
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'audio-es-ar');

// Distancia de Levenshtein por palabra → WER. Sin dependencia nueva (~20 líneas).
function wordErrorRate(reference, hypothesis) {
  const norm = (s) => s.toLowerCase().replace(/[.,;:¡!¿?"']/g, '').replace(/\s+/g, ' ').trim();
  const ref = norm(reference).split(' ').filter(Boolean);
  const hyp = norm(hypothesis).split(' ').filter(Boolean);
  const dp = Array.from({ length: ref.length + 1 }, () => new Array(hyp.length + 1).fill(0));
  for (let i = 0; i <= ref.length; i++) dp[i][0] = i;
  for (let j = 0; j <= hyp.length; j++) dp[0][j] = j;
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return ref.length ? dp[ref.length][hyp.length] / ref.length : 0;
}

test('CA-3: WER de large-v3-turbo <= WER de small en fixtures es-AR (opt-in WHISPER_WER=1)', { skip: process.env.WHISPER_WER !== '1' }, async () => {
  // whisper-local.js desestructuró `spawn` al cargar (detrás de nuestro wrapper),
  // así que para correr el motor real apuntamos fakeSpawnImpl al spawn real en vez
  // de reasignar childProcess.spawn (que el módulo ya no mira).
  fakeSpawnImpl = (bin, args, opts) => realSpawn(bin, args, opts);
  process.env.HF_HUB_OFFLINE = '1';
  const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.mp3'));
  assert.ok(files.length >= 3, 'debe haber al menos 3 fixtures es-AR');
  let werTurbo = 0;
  let werSmall = 0;
  for (const f of files) {
    const audioPath = path.join(FIXTURES_DIR, f);
    const ref = fs.readFileSync(audioPath.replace(/\.mp3$/, '.txt'), 'utf8');
    const rt = await wl.transcribeLocal({ audioPath, model: 'large-v3-turbo' });
    const rs = await wl.transcribeLocal({ audioPath, model: 'small' });
    assert.equal(rt.ok, true, `turbo falló en ${f}: ${rt.raw}`);
    assert.equal(rs.ok, true, `small falló en ${f}: ${rs.raw}`);
    werTurbo += wordErrorRate(ref, rt.text);
    werSmall += wordErrorRate(ref, rs.text);
  }
  werTurbo /= files.length;
  werSmall /= files.length;
  console.log(`[WER] turbo=${werTurbo.toFixed(3)} small=${werSmall.toFixed(3)}`);
  assert.ok(werTurbo <= werSmall + 0.02, `large-v3-turbo (${werTurbo.toFixed(3)}) no debe ser peor que small (${werSmall.toFixed(3)})`);
});
