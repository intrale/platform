// =============================================================================
// circuit-breaker-auto-resume.test.js — #3940 EP5-H3
//
// Auto-resume del circuit breaker de infra tras N prechecks OK consecutivos.
// Cubre CA-1..CA-8 + requisitos SEC-R1..SEC-R4 del análisis de seguridad.
//
// Apuntamos CB_INFRA_STATE_FILE a un archivo temporal ANTES de require para no
// tocar el estado real del pipeline en producción.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-autoresume-'));
const STATE_FILE = path.join(TMP_DIR, 'circuit-breaker-infra.json');
process.env.CB_INFRA_STATE_FILE = STATE_FILE;

const cb = require('../circuit-breaker-infra');

/** Resetea el estado a un CB abierto con un streak persistido dado. */
function abrirCB({ ok_prechecks = 0, last_auto_resume_at = null, auto_resume_count = 0, auto_resume_suspended = false } = {}) {
  cb.writeState({
    state: 'open',
    consecutive_failures: 3,
    last_error_code: 'ENOTFOUND',
    last_issue_trigger: 1234,
    opened_at: new Date().toISOString(),
    alert_sent: true,
    consecutive_ok_prechecks: ok_prechecks,
    auto_resume_count,
    last_auto_resume_at,
    auto_resume_suspended,
  });
}

function limpiar() {
  try { fs.unlinkSync(STATE_FILE); } catch {}
}

test.afterEach(() => limpiar());
test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {} });

// --- CA-1: auto-cierre tras streak >= N ----------------------------------------

test('CB open + streak >= N → shouldAutoResume true y resume("auto") cierra con auditoría', () => {
  abrirCB();
  const N = 3;
  assert.equal(
    cb.shouldAutoResume({ precheckOk: true, cbOpen: cb.isOpen(), streak: 3, threshold: N, suspended: false }),
    true,
  );
  const { changed, state } = cb.resume('auto');
  assert.equal(changed, true);
  assert.equal(state.state, 'closed');
  assert.equal(state.resumed_by, 'auto');           // SEC-R4
  assert.ok(state.resumed_at, 'resumed_at debe quedar seteado'); // SEC-R4
  assert.equal(state.auto_resume_count, 1);          // SEC-R3
  assert.ok(state.last_auto_resume_at, 'last_auto_resume_at seteado'); // SEC-R3
});

// --- CA-1: streak < N no cierra ------------------------------------------------

test('CB open + streak < N → shouldAutoResume false (no cierra)', () => {
  abrirCB();
  assert.equal(
    cb.shouldAutoResume({ precheckOk: true, cbOpen: true, streak: 2, threshold: 3, suspended: false }),
    false,
  );
  assert.equal(cb.isOpen(), true, 'el CB sigue abierto');
});

test('precheck NO ok → shouldAutoResume false aunque streak alto', () => {
  assert.equal(
    cb.shouldAutoResume({ precheckOk: false, cbOpen: true, streak: 99, threshold: 3, suspended: false }),
    false,
  );
});

// --- CA-2: idempotencia --------------------------------------------------------

test('CB closed + streak >= N → resume("auto") es no-op (changed:false)', () => {
  cb.writeState({ state: 'closed' });
  assert.equal(
    cb.shouldAutoResume({ precheckOk: true, cbOpen: false, streak: 10, threshold: 3, suspended: false }),
    false,
  );
  const { changed } = cb.resume('auto');
  assert.equal(changed, false);
});

// --- CA-4: override manual intacto (resume sin args = manual) -------------------

test('resume() sin args mantiene firma manual y audita resumed_by:manual', () => {
  abrirCB();
  const { changed, state } = cb.resume(); // como lo llama resume.js
  assert.equal(changed, true);
  assert.equal(state.state, 'closed');
  assert.equal(state.resumed_by, 'manual');
  assert.equal(state.auto_resume_count, 0, 'el resume manual NO incrementa auto_resume_count');
});

test('resume("manual") tras flapping limpia auto_resume_suspended (rehabilita auto-cierre)', () => {
  abrirCB({ auto_resume_suspended: true, auto_resume_count: 1 });
  const { state } = cb.resume('manual');
  assert.equal(state.auto_resume_suspended, false);
});

// --- CA-5 / SEC-R1: threshold validado -----------------------------------------

test('threshold inválido (0, negativo, string, ausente) → fallback 3', () => {
  for (const bad of [0, -1, '3', 'abc', null, undefined, 2.5, NaN]) {
    const { value, fellBack } = cb.sanitizeAutoResumeThreshold(bad, 3);
    assert.equal(value, 3, `valor ${JSON.stringify(bad)} debe caer al default 3`);
    assert.equal(fellBack, true, `valor ${JSON.stringify(bad)} debe marcar fellBack`);
  }
});

test('threshold válido (entero >= 1) se respeta', () => {
  for (const good of [1, 3, 5, 10]) {
    const { value, fellBack } = cb.sanitizeAutoResumeThreshold(good, 3);
    assert.equal(value, good);
    assert.equal(fellBack, false);
  }
});

// --- CA-6 / SEC-R2: estado persistido corrupto sanitizado ----------------------

test('consecutive_ok_prechecks corrupto/inválido en disco → sanitizado a 0 al leer', () => {
  // Valores que NO representan un entero ≥ 0 → 0.
  for (const bad of [-5, 3.5, 'cien', null, { x: 1 }, [1, 2]]) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ state: 'open', consecutive_ok_prechecks: bad }));
    const st = cb.readState();
    assert.equal(st.consecutive_ok_prechecks, 0, `valor ${JSON.stringify(bad)} debe sanitizarse a 0`);
    limpiar();
  }
});

test('auto_resume_count corrupto en disco → sanitizado a 0 al leer', () => {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ state: 'open', auto_resume_count: 'XXL' }));
  assert.equal(cb.readState().auto_resume_count, 0);
});

test('sanitizeCounter sólo acepta enteros >= 0', () => {
  assert.equal(cb.sanitizeCounter(5), 5);
  assert.equal(cb.sanitizeCounter(0), 0);
  assert.equal(cb.sanitizeCounter(-1), 0);
  assert.equal(cb.sanitizeCounter('7'), 7); // Number('7') es entero
  assert.equal(cb.sanitizeCounter('abc'), 0);
  assert.equal(cb.sanitizeCounter(2.5), 0);
  assert.equal(cb.sanitizeCounter(null), 0);
});

// --- CA-7 / SEC-R3: anti-flapping ----------------------------------------------

test('reapertura dentro de la ventana post-auto-resume → flapping + suspensión', () => {
  // CB cerrado por auto-resume recién (last_auto_resume_at = ahora).
  cb.writeState({
    state: 'closed',
    consecutive_failures: 0,
    auto_resume_count: 1,
    last_auto_resume_at: new Date().toISOString(),
    auto_resume_suspended: false,
  });
  // 3 fallos consecutivos reabren el CB.
  let res;
  for (let i = 0; i < 3; i++) res = cb.registerInfraFailure(7777, 'ETIMEDOUT');
  assert.equal(res.opened, true);
  assert.equal(res.flapping, true, 'debe detectar flapping');
  assert.equal(res.state.auto_resume_suspended, true, 'debe suspender el auto-resume');

  // Con suspended=true, shouldAutoResume devuelve false aun con streak alto.
  assert.equal(
    cb.shouldAutoResume({ precheckOk: true, cbOpen: true, streak: 99, threshold: 3, suspended: true }),
    false,
  );
});

test('reapertura FUERA de la ventana → NO flapping (auto-resume sigue habilitado)', () => {
  const viejo = new Date(Date.now() - (cb.AUTO_RESUME_FLAP_WINDOW_MS + 60_000)).toISOString();
  cb.writeState({ state: 'closed', auto_resume_count: 1, last_auto_resume_at: viejo });
  let res;
  for (let i = 0; i < 3; i++) res = cb.registerInfraFailure(8888, 'ECONNRESET');
  assert.equal(res.opened, true);
  assert.equal(res.flapping, false, 'fuera de ventana no es flapping');
  assert.equal(res.state.auto_resume_suspended, false);
});

test('reapertura sin auto-resume previo (last_auto_resume_at null) → NO flapping', () => {
  cb.writeState({ state: 'closed' });
  let res;
  for (let i = 0; i < 3; i++) res = cb.registerInfraFailure(9999, 'ENOTFOUND');
  assert.equal(res.opened, true);
  assert.equal(res.flapping, false);
});

// --- CA-8 / SEC-R4: auditoría del cierre ---------------------------------------

test('auto y manual quedan diferenciados en resumed_by', () => {
  abrirCB();
  assert.equal(cb.resume('auto').state.resumed_by, 'auto');
  abrirCB();
  assert.equal(cb.resume('manual').state.resumed_by, 'manual');
  // origin inválido cae a manual (defensa).
  abrirCB();
  assert.equal(cb.resume('weird').state.resumed_by, 'manual');
});
