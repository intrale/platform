// =============================================================================
// Tests del modelo optimista de Sherlock (#4105 · EP2-H5b)
//
// Cubre el corazón fail-closed del feature (lógica de seguridad ≥85%):
//   - decideCorrection: texto ⇒ edit, voz ⇒ follow-up, fallback (CA-5/CA-8)
//   - resolveVerdict: SOLO approved remueve el disclaimer ⏳ (CA-7 / SEC-1)
//   - createBackgroundRegistry: cap de concurrencia (SEC-4), idempotencia (CA-6),
//     timeout duro de limpieza ≤90 s (CA-3/CA-10)
//   - audit: SHA-256 truncado, sin contenido crudo (CA-12 / SEC-6)
//
// Convención: sin credenciales, sin red, sin filesystem. Reloj inyectado.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const opt = require('../sherlock-optimistic');

// -----------------------------------------------------------------------------
// decideCorrection — CA-5 / CA-8
// -----------------------------------------------------------------------------
test('decideCorrection: voz SIEMPRE follow-up (voice note no editable)', () => {
  const r = opt.decideCorrection({ channel: opt.CHANNEL_VOICE, editAvailable: true });
  assert.equal(r.type, opt.CORRECTION_FOLLOWUP);
  assert.equal(r.channel, opt.CHANNEL_VOICE);
});

test('decideCorrection: texto editable ⇒ editMessageText', () => {
  const r = opt.decideCorrection({ channel: opt.CHANNEL_TEXT, editAvailable: true });
  assert.equal(r.type, opt.CORRECTION_EDIT);
});

test('decideCorrection: texto con edición fallida ⇒ fallback a follow-up (CA-8)', () => {
  const r = opt.decideCorrection({ channel: opt.CHANNEL_TEXT, editAvailable: false });
  assert.equal(r.type, opt.CORRECTION_FOLLOWUP);
  assert.equal(r.reason, 'edit-fallback');
});

test('decideCorrection: default editAvailable=true para texto', () => {
  const r = opt.decideCorrection({ channel: opt.CHANNEL_TEXT });
  assert.equal(r.type, opt.CORRECTION_EDIT);
});

test('decideCorrection: canal desconocido ⇒ degrada conservador a follow-up', () => {
  const r = opt.decideCorrection({ channel: 'sms' });
  assert.equal(r.type, opt.CORRECTION_FOLLOWUP);
  assert.equal(r.reason, 'unknown-channel');
});

test('decideCorrection: sin args no rompe', () => {
  const r = opt.decideCorrection();
  assert.equal(r.type, opt.CORRECTION_FOLLOWUP);
});

// -----------------------------------------------------------------------------
// resolveVerdict — CA-7 / SEC-1 (fail-closed)
// -----------------------------------------------------------------------------
test('resolveVerdict: approved ⇒ removeDisclaimer true', () => {
  const r = opt.resolveVerdict({ verificationId: 'v1', verdict: opt.VERDICT_APPROVED });
  assert.equal(r.removeDisclaimer, true);
  assert.equal(r.verdict, 'approved');
  assert.equal(r.needsCorrection, false);
});

test('resolveVerdict: rejected ⇒ NO remueve, needsCorrection true', () => {
  const r = opt.resolveVerdict({ verificationId: 'v1', verdict: opt.VERDICT_REJECTED });
  assert.equal(r.removeDisclaimer, false);
  assert.equal(r.needsCorrection, true);
});

test('resolveVerdict: error/timeout ⇒ NO remueve (fail-closed)', () => {
  assert.equal(opt.resolveVerdict({ verdict: opt.VERDICT_ERROR }).removeDisclaimer, false);
  assert.equal(opt.resolveVerdict({ verdict: opt.VERDICT_TIMEOUT }).removeDisclaimer, false);
});

test('resolveVerdict: verdict ausente/forjado ⇒ NO remueve, normaliza a error', () => {
  const missing = opt.resolveVerdict({ verificationId: 'v1' });
  assert.equal(missing.removeDisclaimer, false);
  assert.equal(missing.verdict, 'error');
  const forged = opt.resolveVerdict({ verdict: 'APPROVED ' }); // casi-approved
  assert.equal(forged.removeDisclaimer, false);
  assert.equal(forged.verdict, 'error');
  const obj = opt.resolveVerdict({ verdict: { approved: true } });
  assert.equal(obj.removeDisclaimer, false);
});

test('resolveVerdict: sin args no rompe', () => {
  const r = opt.resolveVerdict();
  assert.equal(r.removeDisclaimer, false);
});

// -----------------------------------------------------------------------------
// createBackgroundRegistry — alta / dedupe / cap / timeout
// -----------------------------------------------------------------------------
function fixedClock(start = 1_000_000) {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  return fn;
}

test('registry: enqueueCorrection acepta y crece size', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  const r = reg.enqueueCorrection({ verificationId: 'v1', correlationId: 'c1', channel: 'text' });
  assert.equal(r.status, opt.REGISTER_ACCEPTED);
  assert.equal(r.deduped, false);
  assert.equal(reg.size(), 1);
  assert.equal(reg.has('v1', 'c1'), true);
});

test('registry: dedupe idempotente por verificationId+correlationId (CA-6)', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  const a = reg.enqueueCorrection({ verificationId: 'v1', correlationId: 'c1', channel: 'text' });
  const b = reg.enqueueCorrection({ verificationId: 'v1', correlationId: 'c1', channel: 'text' });
  assert.equal(a.status, opt.REGISTER_ACCEPTED);
  assert.equal(b.status, opt.REGISTER_DEDUPED);
  assert.equal(b.deduped, true);
  assert.equal(reg.size(), 1, 'dedupe nunca produce doble alta');
});

test('registry: cap de concurrencia — N+1 sobre cap N degrada (SEC-4)', () => {
  const reg = opt.createBackgroundRegistry({ cap: 2 });
  assert.equal(reg.enqueueCorrection({ verificationId: 'v1', correlationId: 'c1', channel: 'text' }).status, opt.REGISTER_ACCEPTED);
  assert.equal(reg.enqueueCorrection({ verificationId: 'v2', correlationId: 'c2', channel: 'text' }).status, opt.REGISTER_ACCEPTED);
  const over = reg.enqueueCorrection({ verificationId: 'v3', correlationId: 'c3', channel: 'text' });
  assert.equal(over.status, opt.REGISTER_DEGRADED);
  assert.equal(over.reason, 'cap');
  assert.equal(reg.size(), 2, 'nunca spawnea ilimitado');
});

test('registry: timeout duro limpia zombi a ≤90 s y libera slot (CA-10)', () => {
  const clock = fixedClock();
  const reg = opt.createBackgroundRegistry({ cap: 1, hardTimeoutMs: 90_000, now: clock });
  assert.equal(reg.enqueueCorrection({ verificationId: 'v1', correlationId: 'c1', channel: 'text' }).status, opt.REGISTER_ACCEPTED);
  // cap lleno: el segundo degrada...
  assert.equal(reg.enqueueCorrection({ verificationId: 'v2', correlationId: 'c2', channel: 'text' }).status, opt.REGISTER_DEGRADED);
  // ...pero pasado el timeout duro, el zombi se barre y libera el slot.
  clock.advance(90_001);
  const after = reg.enqueueCorrection({ verificationId: 'v2', correlationId: 'c2', channel: 'text' });
  assert.equal(after.status, opt.REGISTER_ACCEPTED);
  assert.equal(reg.size(), 1);
  assert.equal(reg.has('v1', 'c1'), false, 'el zombi v1 fue barrido');
});

test('registry: sweep devuelve zombis con status timeout', () => {
  const clock = fixedClock();
  const reg = opt.createBackgroundRegistry({ hardTimeoutMs: 1000, now: clock });
  reg.enqueueCorrection({ verificationId: 'v1', correlationId: 'c1', channel: 'voice' });
  clock.advance(1001);
  const removed = reg.sweep();
  assert.equal(removed.length, 1);
  assert.equal(removed[0].status, 'timeout');
  assert.equal(reg.size(), 0);
});

test('registry: hardTimeoutMs se clampea al techo de 90 s (CA-3)', () => {
  const reg = opt.createBackgroundRegistry({ hardTimeoutMs: 5_000_000 });
  assert.equal(reg.hardTimeoutMs, opt.HARD_TIMEOUT_MAX_MS);
});

test('registry: cap/timeout inválidos caen a defaults (fail-safe)', () => {
  const reg = opt.createBackgroundRegistry({ cap: -3, hardTimeoutMs: NaN });
  assert.equal(reg.cap, opt.DEFAULT_CAP);
  assert.equal(reg.hardTimeoutMs, opt.DEFAULT_HARD_TIMEOUT_MS);
});

test('registry: ids/canal inválidos degradan sin alta', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  assert.equal(reg.enqueueCorrection({ verificationId: '', correlationId: 'c1', channel: 'text' }).reason, 'invalid-id');
  assert.equal(reg.enqueueCorrection({ verificationId: 'v1', correlationId: 'c1', channel: 'fax' }).reason, 'invalid-channel');
  assert.equal(reg.size(), 0);
});

test('registry: resolve approved remueve la tarea y habilita quitar disclaimer', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  reg.enqueueCorrection({ verificationId: 'v1', correlationId: 'c1', channel: 'text' });
  const r = reg.resolve({ verificationId: 'v1', correlationId: 'c1', verdict: 'approved' });
  assert.equal(r.found, true);
  assert.equal(r.removeDisclaimer, true);
  assert.equal(reg.size(), 0);
});

test('registry: resolve rejected mantiene disclaimer y marca needsCorrection', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  reg.enqueueCorrection({ verificationId: 'v1', correlationId: 'c1', channel: 'voice' });
  const r = reg.resolve({ verificationId: 'v1', correlationId: 'c1', verdict: 'rejected' });
  assert.equal(r.removeDisclaimer, false);
  assert.equal(r.needsCorrection, true);
  assert.equal(r.task.channel, 'voice');
});

test('registry: resolve de clave ausente es idempotente (found false)', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  const r = reg.resolve({ verificationId: 'nope', correlationId: 'nope', verdict: 'approved' });
  assert.equal(r.found, false);
});

test('registry: get devuelve copia, no referencia interna', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  reg.enqueueCorrection({ verificationId: 'v1', correlationId: 'c1', channel: 'text' });
  const t = reg.get('v1', 'c1');
  t.status = 'mutado';
  assert.equal(reg.get('v1', 'c1').status, 'pending', 'mutar la copia no afecta el registro');
  assert.equal(reg.get('zz', 'zz'), null);
});

// -----------------------------------------------------------------------------
// enqueueCorrection módulo-level
// -----------------------------------------------------------------------------
test('enqueueCorrection (módulo): delega en el registry', () => {
  const reg = opt.createBackgroundRegistry({ cap: 2 });
  const r = opt.enqueueCorrection(reg, { verificationId: 'v1', correlationId: 'c1', channel: 'text' });
  assert.equal(r.status, opt.REGISTER_ACCEPTED);
});

test('enqueueCorrection (módulo): sin registry válido lanza', () => {
  assert.throws(() => opt.enqueueCorrection(null, {}), /registry válido/);
  assert.throws(() => opt.enqueueCorrection({}, {}), /registry válido/);
});

// -----------------------------------------------------------------------------
// Audit — CA-12 / SEC-6 (SHA-256, sin contenido crudo)
// -----------------------------------------------------------------------------
test('audit: optimistic_send hashea el contenido, nunca lo expone crudo', () => {
  const ev = opt.auditOptimisticSend({
    verificationId: 'v1', correlationId: 'c1', channel: 'text', responseText: 'dato sensible PII',
  });
  assert.equal(ev.event, opt.AUDIT_OPTIMISTIC_SEND);
  assert.equal(ev.responseHash.length, 16);
  assert.ok(!JSON.stringify(ev).includes('dato sensible'));
});

test('audit: background_verdict normaliza verdict desconocido a error', () => {
  const ev = opt.auditBackgroundVerdict({ verificationId: 'v1', verdict: 'weird' });
  assert.equal(ev.event, opt.AUDIT_BACKGROUND_VERDICT);
  assert.equal(ev.verdict, 'error');
  assert.equal(ev.removeDisclaimer, false);
  const ok = opt.auditBackgroundVerdict({ verdict: 'approved' });
  assert.equal(ok.verdict, 'approved');
  assert.equal(ok.removeDisclaimer, true);
});

test('audit: edit_result outcome fail-closed por default + hash de la corrección', () => {
  const ev = opt.auditEditResult({ verificationId: 'v1', outcome: 'bogus', correctionText: 'x' });
  assert.equal(ev.event, opt.AUDIT_EDIT_RESULT);
  assert.equal(ev.outcome, 'fail');
  assert.equal(ev.correctionHash.length, 16);
  assert.equal(opt.auditEditResult({ outcome: 'success' }).outcome, 'success');
  assert.equal(opt.auditEditResult({ outcome: 'fallback' }).outcome, 'fallback');
});

test('hashFor: determinístico, 16 hex, maneja null/undefined', () => {
  assert.equal(opt._hashFor('abc'), opt._hashFor('abc'));
  assert.match(opt._hashFor('abc'), /^[0-9a-f]{16}$/);
  assert.equal(opt._hashFor(null).length, 16);
  assert.equal(opt._hashFor(undefined).length, 16);
});
