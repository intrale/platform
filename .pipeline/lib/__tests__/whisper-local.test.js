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

// #5336 — El watchdog chequea cada WATCHDOG_TICK_MS (5 s en producción). Los tests
// no pueden esperar segundos reales por caso, así que bajamos el tick ANTES de
// requerir el módulo (las constantes se leen del env en el require).
process.env.WHISPER_LOCAL_WATCHDOG_TICK_MS = '20';

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

// ---------------------------------------------------------------------------
// Issue #5336 — Transcripción sin límite de tiempo: no perder audios por reloj,
// reintentar ante fallo y comunicar el fallo como fallo (no como "no te entendí").
//
// El incidente que originó el issue: dos audios de ~2m13s del operador se
// descartaron por el tope de 5 min mientras la máquina estaba cargada de agentes.
// Al reprocesarlos con la máquina libre salieron completos: el trabajo era válido,
// lo que fallaba era el criterio de corte.
// ---------------------------------------------------------------------------

// Proceso falso que emite latidos por stderr durante `aliveMs` y recién ahí cierra.
// Simula el motor real trabajando: tarda mucho, pero da señales de vida.
function makeHeartbeatingSpawn({ aliveMs, beatEveryMs = 20, exitCode = 0, writeText = 'audio largo transcripto' }) {
  return (bin, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = () => { proc.killed = true; };
    const started = Date.now();
    const beat = setInterval(() => {
      if (proc.killed) { clearInterval(beat); return; }
      proc.stderr.emit('data', Buffer.from(`[fw-progress] segment t=${((Date.now() - started) / 1000).toFixed(1)}s\n`));
    }, beatEveryMs);
    const done = setTimeout(() => {
      clearInterval(beat);
      if (proc.killed) return;
      if (exitCode === 0) {
        try { fs.writeFileSync(outputPathFromArgs(args), JSON.stringify({ text: writeText, segments: [] }), 'utf8'); } catch {}
      }
      proc.emit('close', exitCode);
    }, aliveMs);
    // Los casos que simulan un motor "eterno" usan aliveMs enorme. Sin unref, esos
    // timers mantienen vivo el event loop y la suite tarda lo que dure el mock.
    if (typeof beat.unref === 'function') beat.unref();
    if (typeof done.unref === 'function') done.unref();
    return proc;
  };
}

test('#5336 CA-1: un audio que TARDA pero sigue dando señales de vida NO se corta', async () => {
  // El motor late durante 300 ms con una ventana de inactividad de sólo 80 ms.
  // Con el criterio viejo (reloj de pared) esto moría; con el criterio nuevo
  // (ausencia de progreso) tiene que terminar bien: tardar no es fallar.
  fakeSpawnImpl = makeHeartbeatingSpawn({ aliveMs: 300, beatEveryMs: 20 });
  const audio = makeTmpAudio();
  const r = await wl.transcribeLocal({ audioPath: audio, idleTimeoutMs: 80, timeoutMs: 60000 });
  fs.unlinkSync(audio);
  assert.equal(r.ok, true, `no debió cortarse: ${r.errorKind} ${r.raw}`);
  assert.equal(r.text, 'audio largo transcripto');
});

test('#5336 CA-1: se mata por AUSENCIA de progreso (stalled), no por duración', async () => {
  // Proceso que arranca, late un poco y se cuelga: deja de emitir y nunca cierra.
  fakeSpawnImpl = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = () => { proc.killed = true; };
    setTimeout(() => proc.stderr.emit('data', Buffer.from('[fw-progress] model-load-start\n')), 10);
    return proc; // nunca cierra ni vuelve a latir
  };
  const audio = makeTmpAudio();
  const r = await wl.transcribeLocal({ audioPath: audio, idleTimeoutMs: 100, timeoutMs: 60000 });
  fs.unlinkSync(audio);
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'stalled', 'un proceso colgado debe distinguirse de uno lento');
  assert.match(r.raw, /señales de vida/);
});

test('#5336 CA-1: la guarda absoluta sigue existiendo para un proceso que late para siempre', async () => {
  // Late sin parar y nunca termina: la inactividad nunca dispara, así que la red
  // de seguridad de último recurso es la que tiene que cerrar el caso.
  fakeSpawnImpl = makeHeartbeatingSpawn({ aliveMs: 60000, beatEveryMs: 10 });
  const audio = makeTmpAudio();
  const r = await wl.transcribeLocal({ audioPath: audio, idleTimeoutMs: 60000, timeoutMs: 120 });
  fs.unlinkSync(audio);
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'timeout');
  assert.match(r.raw, /guarda absoluta/);
});

test('#5336 CA-1: los latidos no contaminan el motivo de error que ve el usuario', async () => {
  // Ante exit != 0 el `raw` debe mostrar la causa real, no las últimas 3 líneas
  // de progreso (que es lo que pasaría si los latidos se acumularan en stderr).
  fakeSpawnImpl = (bin, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setTimeout(() => {
      for (let i = 0; i < 5; i++) proc.stderr.emit('data', Buffer.from(`[fw-progress] segment t=${i}.0s\n`));
      proc.stderr.emit('data', Buffer.from('MemoryError: no entra el modelo\n'));
      proc.emit('close', 1);
    }, 5);
    return proc;
  };
  const audio = makeTmpAudio();
  const r = await wl.transcribeLocal({ audioPath: audio });
  fs.unlinkSync(audio);
  assert.equal(r.errorKind, 'cli_error');
  assert.match(r.raw, /MemoryError/, 'el error real tiene que sobrevivir al tail');
  assert.ok(!/fw-progress/.test(r.raw), 'los latidos no son errores y no deben aparecer');
});

test('#5336 CA-1: onProgress recibe los latidos del motor', async () => {
  fakeSpawnImpl = makeHeartbeatingSpawn({ aliveMs: 120, beatEveryMs: 20 });
  const beats = [];
  const audio = makeTmpAudio();
  const r = await wl.transcribeLocal({ audioPath: audio, onProgress: (l) => beats.push(l), idleTimeoutMs: 5000 });
  fs.unlinkSync(audio);
  assert.equal(r.ok, true);
  assert.ok(beats.length > 0, 'el orquestador necesita saber que el motor arrancó de verdad');
  assert.match(beats[0], /^\[fw-progress\]/);
});

// ---------------------------------------------------------------------------
// #5336 — Orquestación (multimedia.js): reintentos, cola sin descarte y ruteo
// del mensaje de fallo. Se inyecta un DOBLE del motor en la caché de require
// antes de cargar multimedia, para controlar ok/busy/error por llamada sin
// depender de python ni del modelo real.
// ---------------------------------------------------------------------------

// Guion de respuestas del motor, consumido de a una por llamada.
let engineScript = [];
let engineCalls = 0;

const whisperLocalModulePath = require.resolve('../whisper-local');
const realWhisperLocalExports = require.cache[whisperLocalModulePath].exports;
require.cache[whisperLocalModulePath].exports = Object.assign({}, realWhisperLocalExports, {
  isAvailable: () => true,
  transcribeLocal: async () => {
    const next = engineScript[engineCalls] || engineScript[engineScript.length - 1];
    engineCalls++;
    return typeof next === 'function' ? next(engineCalls) : next;
  },
});

// Backoff y umbrales chicos: los tests verifican COMPORTAMIENTO, no relojes.
process.env.WHISPER_RETRY_BACKOFF_MS = '5,5';
process.env.WHISPER_BUSY_RETRY_DELAY_MS = '5';
process.env.WHISPER_QUEUE_NOTICE_MS = '40';
process.env.WHISPER_ENGINE_NOTICE_MS = '40';
process.env.WHISPER_NOTICE_TICK_MS = '10';

const multimedia = require('../../multimedia');
const commanderDet = require('../commander-deterministic');

// Restauramos el motor real al terminar para no contaminar otras suites.
test.after(() => { require.cache[whisperLocalModulePath].exports = realWhisperLocalExports; });

function resetEngine(script) { engineScript = script; engineCalls = 0; }

test('#5336 CA-3: un fallo transitorio se reintenta y el audio se salva', async () => {
  // Primer intento crashea (típico: presión de memoria), el segundo sale bien.
  resetEngine([
    { ok: false, text: '', errorKind: 'cli_error', raw: 'exit 1: MemoryError' },
    { ok: true, text: 'reiniciá el pipeline' },
  ]);
  const r = await multimedia.transcribeAudioWithFallback(Buffer.alloc(10), null, 'a.ogg');
  assert.equal(r.ok, true, 'no puede darse por vencido al primer error');
  assert.equal(r.text, 'reiniciá el pipeline');
  assert.equal(engineCalls, 2, 'debe haber reintentado exactamente una vez');
});

test('#5336 CA-3: se reintenta al menos 2 veces antes de declarar el fallo', async () => {
  resetEngine([{ ok: false, text: '', errorKind: 'stalled', raw: 'sin señales de vida' }]);
  const r = await multimedia.transcribeAudioWithFallback(Buffer.alloc(10), null, 'a.ogg');
  assert.equal(r.ok, false);
  assert.equal(engineCalls, 3, '1 intento + 2 reintentos como mínimo');
  assert.ok(multimedia.TRANSCRIBE_MAX_ATTEMPTS >= 3);
});

test('#5336 CA-3: un fallo determinístico NO se reintenta (reintentar no cambia nada)', async () => {
  // Si falta el binario, repetir da exactamente lo mismo: reintentar sólo retrasa
  // el aviso al operador.
  resetEngine([{ ok: false, text: '', errorKind: 'no_binary', raw: 'no está python' }]);
  const r = await multimedia.transcribeAudioWithFallback(Buffer.alloc(10), null, 'a.ogg');
  assert.equal(r.ok, false);
  assert.equal(engineCalls, 1, 'un fallo no reintentable se reporta de una');
});

test('#5336 CA-7: la espera en cola NO descarta el audio', async () => {
  // El motor está ocupado muchas más veces de las que el presupuesto viejo (6 min
  // / 3 s = 120 polls) toleraba antes de rendirse con `busy`. Igual tiene que
  // terminar transcribiendo: la cola espera su turno, no vence.
  const busyTimes = 150;
  const script = [];
  for (let i = 0; i < busyTimes; i++) script.push({ ok: false, text: '', errorKind: 'busy', raw: 'ocupado' });
  script.push({ ok: true, text: 'audio que esperó su turno' });
  resetEngine(script);
  const r = await multimedia.transcribeAudioWithFallback(Buffer.alloc(10), null, 'a.ogg');
  assert.equal(r.ok, true, 'un audio encolado no puede fallar por esperar');
  assert.equal(r.text, 'audio que esperó su turno');
  assert.notEqual(r.errorKind, 'busy');
});

test('#5336 CA-2/CA-8: el aviso de cola y el de motor son distinguibles', async () => {
  const avisos = [];
  // Ocupado un rato (dispara el aviso de COLA) y después transcribe.
  const script = [];
  for (let i = 0; i < 20; i++) script.push({ ok: false, text: '', errorKind: 'busy', raw: 'ocupado' });
  script.push({ ok: true, text: 'listo' });
  resetEngine(script);
  const r = await multimedia.transcribeAudioWithFallback(Buffer.alloc(10), null, 'a.ogg', {
    notify: (texto, stage) => avisos.push({ texto, stage }),
  });
  assert.equal(r.ok, true);
  const cola = avisos.filter((a) => a.stage === 'queue');
  assert.equal(cola.length, 1, 'un solo aviso de cola, nada de spam');
  assert.equal(cola[0].texto, multimedia.QUEUE_NOTICE_TEXT);
  assert.notEqual(multimedia.QUEUE_NOTICE_TEXT, multimedia.ENGINE_NOTICE_TEXT,
    'usar el mismo texto para los dos estados comunica mal');
  assert.match(multimedia.QUEUE_NOTICE_TEXT, /adelante/);
  assert.match(multimedia.ENGINE_NOTICE_TEXT, /transcribiendo/);
});

test('#5336 CA-8: no se avisa "estoy procesando" si la transcripción ya cerró', async () => {
  const avisos = [];
  resetEngine([{ ok: true, text: 'rapidísimo' }]);
  await multimedia.transcribeAudioWithFallback(Buffer.alloc(10), null, 'a.ogg', {
    notify: (texto, stage) => avisos.push({ texto, stage }),
  });
  // Esperamos bastante más que el umbral: si el timer no se cancela, acá aparece
  // un aviso posterior a la respuesta final (peor que el silencio).
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(avisos.length, 0, 'un aviso que llega después de la respuesta es peor que ninguno');
});

test('#5336 CA-2: un fallo del notificador jamás rompe la transcripción', async () => {
  const script = [];
  for (let i = 0; i < 20; i++) script.push({ ok: false, text: '', errorKind: 'busy', raw: 'ocupado' });
  script.push({ ok: true, text: 'igual salió' });
  resetEngine(script);
  const r = await multimedia.transcribeAudioWithFallback(Buffer.alloc(10), null, 'a.ogg', {
    notify: () => { throw new Error('telegram caído'); },
  });
  assert.equal(r.ok, true, 'el aviso es aditivo: si falla, la transcripción sigue');
  assert.equal(r.text, 'igual salió');
});

test('#5336 CA-4: el marcador de audio fallido se rutea al fallo real, no a "no te entendí"', () => {
  // Reproduce el bug exacto del issue: multimedia deja el texto vacío + marcador,
  // y el router lo clasificaba `unknown` → plantilla "🤔 No te entendí, Leito".
  const intent = commanderDet.classify('(audio sin transcribir: timeout)');
  assert.equal(intent.audioFailed, true, 'el router tiene que reconocer el marcador');
  assert.equal(intent.audioErrorKind, 'timeout', 'y propagar el motivo');
});

test('#5336 CA-4: el marcador se detecta ANTES del strip de anotaciones', () => {
  // El strip borra el marcador y deja string vacío. Si la detección corriera
  // después, la señal se perdería y volveríamos al fallback genérico.
  assert.deepEqual(commanderDet.detectAudioFailure('(audio sin transcribir: stalled)'), { errorKind: 'stalled' });
  assert.deepEqual(commanderDet.detectAudioFailure('(audio no disponible)'), { errorKind: 'download_failed' });
  assert.equal(commanderDet.detectAudioFailure('(mensaje de voz transcripto · whisper local)'), null,
    'un audio transcripto OK no es un fallo');
});

test('#5336 CA-4: un comando por voz transcripto OK sigue ruteando igual (sin regresión)', () => {
  const intent = commanderDet.classify('/wave (mensaje de voz transcripto · whisper local)');
  assert.equal(intent.class, 'deterministic');
  assert.equal(intent.command, 'wave');
  assert.ok(!intent.audioFailed);
});

test('#5336 CA-4/CA-9: el copy dice que falló la infra, y nunca "no te entendí"', () => {
  for (const kind of Object.keys(multimedia.TRANSCRIPTION_FAILURE_REASONS)) {
    const msg = multimedia.transcriptionFailureMessage(kind);
    assert.match(msg, /no pude transcribirlo/, `[${kind}] debe decir que no pudo transcribir`);
    assert.ok(!/no te entend/i.test(msg), `[${kind}] jamás el fallback de comprensión`);
    // CA-9: ningún consejo que dejó de aplicar tras eliminar el corte por tiempo.
    assert.ok(!/cortito/i.test(msg), `[${kind}] "reenvialo más cortito" ya no aplica`);
    assert.ok(!/openai-whisper/i.test(msg), `[${kind}] el motor ya no es openai-whisper`);
  }
});

test('#5336 CA-9: sólo se menciona el reintento cuando realmente se reintentó', () => {
  assert.match(multimedia.transcriptionFailureMessage('cli_error'), /reintenté/,
    'un fallo reintentable debe explicar que ya se insistió');
  assert.ok(!/reintenté/.test(multimedia.transcriptionFailureMessage('no_binary')),
    'decir que se reintentó cuando no se reintentó es mentira');
});

test('#5336 CA-5: todo errorKind produce un mensaje explícito (nunca silencio)', () => {
  // Incluye kinds que el motor puede emitir y los caminos de excepción.
  const kinds = ['timeout', 'stalled', 'queue_stuck', 'busy', 'cli_error', 'spawn_error',
    'no_output', 'read_error', 'no_input', 'missing_file', 'too_large', 'download_failed',
    'unavailable', 'no_binary', 'un_kind_que_no_existe'];
  for (const k of kinds) {
    const msg = multimedia.transcriptionFailureMessage(k);
    assert.ok(typeof msg === 'string' && msg.trim().length > 20, `[${k}] sin mensaje utilizable`);
  }
});

test('#5336 SEC: el copy de fallo no interpola datos crudos del error', () => {
  // El enum es cerrado: pasar un "errorKind" con payload no puede filtrarlo al chat.
  const msg = multimedia.transcriptionFailureMessage('C:\\Users\\secreto\\token-abc123.ogg');
  assert.ok(!msg.includes('secreto'), 'nunca interpolar paths ni raw en el mensaje al usuario');
  assert.ok(!msg.includes('token-abc123'));
});
