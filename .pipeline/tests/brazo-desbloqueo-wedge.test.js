// =============================================================================
// brazo-desbloqueo-wedge.test.js — Tests de regresión del wedge silencioso
// del brazo de desbloqueo del pulpo (issue #3059).
//
// Cubre los CAs del issue:
//   CA-1: watchdog libera el guard cuando wedge > UNBLOCK_WEDGE_TIMEOUT_MS,
//         resetea lastUnblockTime a 0 y mata el pid wedged.
//   CA-2: re-entry log con cooldown de 10 min — la primera invocación logea,
//         las siguientes dentro del cooldown son silenciadas.
//   CA-3: _ghCallWithTimeout rechaza la promise al timeout y mata al proceso
//         hijo con taskkill /F /T /PID. Distingue "matado por timeout" vs
//         "ya había muerto solo". cleartTimeout en happy path (no leak).
//   CA-4(d): el proceso hijo simulado fue matado, no solo el guard liberado.
//   CA-3 (security): _sanitizeGhArgs redacta valores tras flags sensibles.
//
// Ejecución: `node --test .pipeline/tests/brazo-desbloqueo-wedge.test.js`
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execSync } = require('child_process');

process.env.PULPO_NO_AUTOSTART = '1';
const pulpo = require(path.join(__dirname, '..', 'pulpo.js'));

const {
  _ghCallWithTimeout,
  _sanitizeGhArgs,
  _checkAndResetUnblockWedge,
  _maybeLogReentrySkip,
  UNBLOCK_WEDGE_TIMEOUT_MS,
  REENTRY_LOG_COOLDOWN_MS,
  _getUnblockState,
  _setUnblockState,
  _getLastUnblockTime,
  _setLastUnblockTime,
} = pulpo;

const isWindows = process.platform === 'win32';

// --- helpers ---

function captureLogs() {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  return {
    lines,
    restore: () => { console.log = orig; },
  };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (isWindows) {
    try {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf8', windowsHide: true });
      // tasklist sin match dice "No tasks are running...". Si match, contiene el pid.
      return new RegExp(`\\b${pid}\\b`).test(out);
    } catch { return false; }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function resetState() {
  _setUnblockState({ running: false, startedAt: 0, activePid: null, reentryLastWarn: 0 });
  _setLastUnblockTime(0);
}

// =============================================================================
// CA-3 (security): sanitización de args sensibles
// =============================================================================

test('_sanitizeGhArgs redacta valores tras flags sensibles', () => {
  const out = _sanitizeGhArgs(['issue', 'list', '--token', 'ghp_supersecret123', '--limit', '50']);
  assert.match(out, /--token \*\*\*/);
  assert.doesNotMatch(out, /ghp_supersecret123/);
  assert.match(out, /issue list/);
  assert.match(out, /--limit 50/);
});

test('_sanitizeGhArgs preserva args sin flags sensibles', () => {
  const out = _sanitizeGhArgs(['issue', 'view', '3059', '--json', 'state']);
  assert.equal(out, 'issue view 3059 --json state');
});

test('_sanitizeGhArgs redacta multiples flags sensibles', () => {
  const out = _sanitizeGhArgs(['--auth', 'pass1', 'cmd', '--password', 'pass2']);
  assert.match(out, /--auth \*\*\*/);
  assert.match(out, /--password \*\*\*/);
  assert.doesNotMatch(out, /pass1/);
  assert.doesNotMatch(out, /pass2/);
});

// =============================================================================
// CA-3 + CA-4(d): _ghCallWithTimeout rechaza al timeout y mata al child
// =============================================================================

test('_ghCallWithTimeout rechaza con GH_CALL_TIMEOUT cuando el child no responde', async () => {
  const start = Date.now();
  // Spawn de un Node hijo que nunca termina — simula gh.exe wedged.
  const hangScript = 'setInterval(()=>{},10000);';
  let err = null;
  try {
    await _ghCallWithTimeout(process.execPath, ['-e', hangScript], 600);
  } catch (e) { err = e; }
  const elapsed = Date.now() - start;

  assert.ok(err, 'la promise debe rechazar');
  assert.equal(err.code, 'GH_CALL_TIMEOUT', 'error.code debe ser GH_CALL_TIMEOUT');
  assert.ok(elapsed < 5000, `debe rechazar rápido, no cuelga: ${elapsed}ms`);
  assert.ok(Number.isInteger(err.pid) && err.pid > 0, `pid del child debe ser numérico positivo (got ${err.pid})`);
  assert.match(String(err.killStatus), /(matado por timeout|ya había muerto)/);
});

test('_ghCallWithTimeout: el proceso hijo wedged queda muerto después del timeout (CA-4 d)', { skip: !isWindows ? 'Windows-only (taskkill)' : false }, async () => {
  const hangScript = 'setInterval(()=>{},10000);';
  let pid = null;
  try {
    await _ghCallWithTimeout(process.execPath, ['-e', hangScript], 600);
    assert.fail('debió rechazar');
  } catch (e) {
    pid = e.pid;
    assert.equal(e.code, 'GH_CALL_TIMEOUT');
  }

  // Esperar a que taskkill termine de propagar. En Windows, `taskkill /F /T`
  // sí mata el proceso de inmediato, pero la propagación a `tasklist` puede
  // tardar varios cientos de ms cuando el sistema está bajo carga (típico
  // cuando se corre la suite completa de ~2573 tests Node en paralelo:
  // rebote intermitente #2958-rev1 — el test originalmente esperaba 400ms
  // fijos y eso resultó insuficiente bajo carga).
  //
  // Solución: polling con backoff hasta MAX_KILL_PROPAGATION_MS. Apenas el
  // pid deja de aparecer en tasklist, salimos. Si excede el tope, asertamos
  // false y dejamos que la asserción siguiente reporte el pid zombi.
  const MAX_KILL_PROPAGATION_MS = 5000;
  const POLL_INTERVAL_MS = 100;
  const deadline = Date.now() + MAX_KILL_PROPAGATION_MS;
  let stillAlive = true;
  while (Date.now() < deadline) {
    stillAlive = pidAlive(pid);
    if (!stillAlive) break;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  assert.equal(stillAlive, false, `pid ${pid} debe estar muerto, no quedan zombis (CA-4 d)`);
});

test('_ghCallWithTimeout: happy path resuelve y NO deja timer pendiente', async () => {
  // Comando que termina rápido — node con `--version` o un -e que sale.
  const start = Date.now();
  const result = await _ghCallWithTimeout(process.execPath, ['-e', 'process.exit(0)'], 30000);
  const elapsed = Date.now() - start;
  assert.ok(typeof result.stdout === 'string');
  assert.ok(elapsed < 10000, 'happy path resuelve rápido sin esperar el timeout');
  // Nota: la garantía de "no leak de timer" se logra con clearTimeout.
  // Si no se cancelara, el test runner se quedaría esperando 30s al cerrar.
});

// =============================================================================
// CA-1: watchdog libera el guard cuando hay wedge > UNBLOCK_WEDGE_TIMEOUT_MS
// =============================================================================

test('_checkAndResetUnblockWedge: NO actua si no hay wedge', () => {
  resetState();
  const cap = captureLogs();
  try {
    _setUnblockState({ running: true, startedAt: Date.now() - 60_000 }); // 1 min, no wedge
    const result = _checkAndResetUnblockWedge();
    assert.equal(result, null, 'sin wedge, no hace nada');
    const state = _getUnblockState();
    assert.equal(state.running, true, 'el guard sigue puesto');
    assert.equal(cap.lines.filter(l => l.includes('wedged')).length, 0, 'no logea warning');
  } finally {
    cap.restore();
    resetState();
  }
});

test('_checkAndResetUnblockWedge: libera el guard, resetea lastUnblockTime y logea cuando wedge > timeout', () => {
  resetState();
  const cap = captureLogs();
  try {
    const wedgeStart = Date.now() - (UNBLOCK_WEDGE_TIMEOUT_MS + 60_000); // 11 min atras
    _setUnblockState({ running: true, startedAt: wedgeStart, activePid: null });
    _setLastUnblockTime(Date.now() - 100); // recién corrió, normalmente no se podría re-entrar 30 min

    const result = _checkAndResetUnblockWedge();
    assert.ok(result, 'debe detectar wedge');
    assert.ok(result.wedgeMs > UNBLOCK_WEDGE_TIMEOUT_MS, `wedgeMs debe superar el timeout (got ${result.wedgeMs})`);

    const state = _getUnblockState();
    assert.equal(state.running, false, 'CA-1: _unblockRunning liberado');
    assert.equal(state.startedAt, 0, 'CA-1: _unblockStartedAt reseteado');
    assert.equal(state.activePid, null, 'CA-1: _unblockActivePid reseteado');
    assert.equal(_getLastUnblockTime(), 0, 'CA-1: lastUnblockTime reseteado a 0 para arrancar inmediato');

    const warnLine = cap.lines.find(l => l.includes('wedged') && l.includes('forzando reset'));
    assert.ok(warnLine, `CA-1: log warning emitido. Lineas: ${JSON.stringify(cap.lines)}`);
    assert.match(warnLine, /\[WARN\]/);
  } finally {
    cap.restore();
    resetState();
  }
});

test('_checkAndResetUnblockWedge: con activePid intenta taskkill y reporta resultado', { skip: !isWindows ? 'Windows-only (taskkill)' : false }, () => {
  resetState();
  const cap = captureLogs();
  try {
    // Spawn un child real que nunca termina, registrarlo como activePid.
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},10000);'], { windowsHide: true, stdio: 'ignore' });
    const pid = child.pid;
    assert.ok(Number.isInteger(pid) && pid > 0);

    // Wedge desde hace > 10 min.
    _setUnblockState({
      running: true,
      startedAt: Date.now() - (UNBLOCK_WEDGE_TIMEOUT_MS + 60_000),
      activePid: pid,
    });

    const result = _checkAndResetUnblockWedge();
    assert.ok(result);
    assert.equal(result.killedPid, pid);
    assert.match(result.killMsg, /mato pid|ya estaba muerto/);

    // Permitir que taskkill propague.
    const wait = Date.now() + 600;
    while (Date.now() < wait && pidAlive(pid)) { /* spin */ }

    assert.equal(pidAlive(pid), false, `pid ${pid} debe haber sido matado por el watchdog`);

    // Cleanup defensivo en caso de que algo falle.
    try { child.kill('SIGKILL'); } catch {}
  } finally {
    cap.restore();
    resetState();
  }
});

test('_checkAndResetUnblockWedge: pid corrupto (no integer) NO ejecuta taskkill', () => {
  resetState();
  const cap = captureLogs();
  try {
    _setUnblockState({
      running: true,
      startedAt: Date.now() - (UNBLOCK_WEDGE_TIMEOUT_MS + 60_000),
      activePid: null, // sin pid valido (defense-in-depth)
    });
    const result = _checkAndResetUnblockWedge();
    assert.ok(result);
    assert.equal(result.killedPid, null);
    assert.match(result.killMsg, /sin pid activo/);
  } finally {
    cap.restore();
    resetState();
  }
});

// =============================================================================
// CA-2: re-entry log con cooldown
// =============================================================================

test('_maybeLogReentrySkip: primera invocacion logea, segunda en cooldown no', () => {
  resetState();
  const cap = captureLogs();
  try {
    _setUnblockState({ running: true, startedAt: Date.now() - 5 * 60_000, reentryLastWarn: 0 });
    const first = _maybeLogReentrySkip();
    const second = _maybeLogReentrySkip();
    const third = _maybeLogReentrySkip();

    assert.equal(first, true, 'CA-2: primer skip logea');
    assert.equal(second, false, 'CA-2: segundo skip silenciado por cooldown');
    assert.equal(third, false, 'CA-2: tercer skip silenciado por cooldown');

    const skipLines = cap.lines.filter(l => l.includes('skip') && l.includes('ciclo anterior sigue activo'));
    assert.equal(skipLines.length, 1, 'CA-2: un solo log emitido en cooldown');
    assert.match(skipLines[0], /\[INFO\]/);
    assert.match(skipLines[0], /hace \d+ min/);
  } finally {
    cap.restore();
    resetState();
  }
});

test('_maybeLogReentrySkip: vuelve a logear pasado el cooldown', () => {
  resetState();
  const cap = captureLogs();
  try {
    const oldWarn = Date.now() - (REENTRY_LOG_COOLDOWN_MS + 60_000); // hace 11 min
    _setUnblockState({
      running: true,
      startedAt: Date.now() - 12 * 60_000,
      reentryLastWarn: oldWarn,
    });
    const result = _maybeLogReentrySkip();
    assert.equal(result, true, 'CA-2: pasado el cooldown, vuelve a logear');

    const skipLines = cap.lines.filter(l => l.includes('skip') && l.includes('ciclo anterior'));
    assert.equal(skipLines.length, 1);
  } finally {
    cap.restore();
    resetState();
  }
});

// =============================================================================
// CA-1 + CA-2 integración: secuencia wedge → recovery
// =============================================================================

test('flujo wedge → watchdog libera guard → siguiente ciclo arranca normal (CA-1 + integración)', () => {
  resetState();
  const cap = captureLogs();
  try {
    // 1) Simulamos wedge desde hace 11 min sin pid activo.
    _setUnblockState({
      running: true,
      startedAt: Date.now() - (UNBLOCK_WEDGE_TIMEOUT_MS + 60_000),
      activePid: null,
    });
    _setLastUnblockTime(Date.now() - 30 * 60_000);

    // 2) Watchdog corre, detecta wedge, libera guard.
    const wedgeResult = _checkAndResetUnblockWedge();
    assert.ok(wedgeResult, 'detecta wedge');

    // 3) Estado post-watchdog: guard libre, lastUnblockTime=0 (arranque inmediato).
    assert.equal(_getUnblockState().running, false);
    assert.equal(_getLastUnblockTime(), 0);

    // 4) Siguiente "tick" del loop principal: el brazo encuentra guard libre.
    // (el resto de brazoDesbloqueo no lo testeamos por integración con
    // partialPause/gh, lo cubre la verificación operativa CA-5).
    const nextWatchdog = _checkAndResetUnblockWedge();
    assert.equal(nextWatchdog, null, 'sin wedge en estado libre, watchdog no actúa');

    // El log refleja el wedge.
    const wedgeLines = cap.lines.filter(l => l.includes('wedged') && l.includes('forzando reset'));
    assert.equal(wedgeLines.length, 1, 'un solo log de wedge en la secuencia');
  } finally {
    cap.restore();
    resetState();
  }
});
