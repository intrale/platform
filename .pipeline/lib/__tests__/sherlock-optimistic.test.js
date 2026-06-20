// =============================================================================
// Tests del modelo optimista de Sherlock (#4105 · EP2-H5b)
//
// Cubre el corazón fail-closed del feature: registry background con cap atómico
// + hard-timeout ≤90s (CA-3/CA-10), enqueueCorrection idempotente (CA-6),
// resolveVerdict fail-closed (CA-7), decideCorrection por canal (CA-5/CA-8) y
// audit sin contenido crudo (CA-12).
//
// Convención: sin red, sin credenciales, reloj inyectable (determinístico).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const opt = require('../sherlock-optimistic');

// -----------------------------------------------------------------------------
// decideCorrection — CA-5 + CA-8
// -----------------------------------------------------------------------------
test('decideCorrection: texto con edición disponible ⇒ editMessageText (CA-5)', () => {
  assert.equal(
    opt.decideCorrection({ channel: 'text', editAvailable: true }),
    opt.CORRECTION_EDIT,
  );
});

test('decideCorrection: voz ⇒ follow-up SIEMPRE, aunque editAvailable=true (CA-5)', () => {
  assert.equal(
    opt.decideCorrection({ channel: 'voice', editAvailable: true }),
    opt.CORRECTION_FOLLOWUP,
  );
});

test('decideCorrection: texto sin edición disponible ⇒ fallback follow-up (CA-8)', () => {
  assert.equal(
    opt.decideCorrection({ channel: 'text', editAvailable: false }),
    opt.CORRECTION_FOLLOWUP,
  );
});

test('decideCorrection: canal desconocido ⇒ fail-safe follow-up (nunca se pierde)', () => {
  assert.equal(opt.decideCorrection({ channel: 'xxx', editAvailable: true }), opt.CORRECTION_FOLLOWUP);
  assert.equal(opt.decideCorrection({}), opt.CORRECTION_FOLLOWUP);
});

// -----------------------------------------------------------------------------
// shouldRemoveDisclaimer — CA-7 fail-closed
// -----------------------------------------------------------------------------
test('shouldRemoveDisclaimer: SOLO approved explícito remueve el ⏳ (CA-7)', () => {
  assert.equal(opt.shouldRemoveDisclaimer('approved'), true);
  assert.equal(opt.shouldRemoveDisclaimer('rejected'), false);
  assert.equal(opt.shouldRemoveDisclaimer('error'), false);
  assert.equal(opt.shouldRemoveDisclaimer('timeout'), false);
  assert.equal(opt.shouldRemoveDisclaimer(null), false);
  assert.equal(opt.shouldRemoveDisclaimer(undefined), false);
  assert.equal(opt.shouldRemoveDisclaimer('Approved'), false, 'case-sensitive: no fail-open');
  assert.equal(opt.shouldRemoveDisclaimer(''), false);
});

// -----------------------------------------------------------------------------
// normalizeChannel
// -----------------------------------------------------------------------------
test('normalizeChannel: esAudio=true ⇒ voice; resto ⇒ text', () => {
  assert.equal(opt.normalizeChannel(true), opt.CHANNEL_VOICE);
  assert.equal(opt.normalizeChannel('voice'), opt.CHANNEL_VOICE);
  assert.equal(opt.normalizeChannel('voz'), opt.CHANNEL_VOICE);
  assert.equal(opt.normalizeChannel(false), opt.CHANNEL_TEXT);
  assert.equal(opt.normalizeChannel('text'), opt.CHANNEL_TEXT);
  assert.equal(opt.normalizeChannel(undefined), opt.CHANNEL_TEXT);
});

// -----------------------------------------------------------------------------
// createBackgroundRegistry — register + cap (CA-10)
// -----------------------------------------------------------------------------
test('register: acepta una tarea nueva y registra el ⏳ en background', () => {
  const reg = opt.createBackgroundRegistry({ cap: 2, hardTimeoutMs: 90_000 });
  const r = reg.register({ verificationId: 'v1', correlationId: 'cmd-1', channel: 'text' });
  assert.equal(r.accepted, true);
  assert.equal(reg.pendingCount(), 1);
});

test('register: dedupe por verificationId (idempotente)', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  assert.equal(reg.register({ verificationId: 'v1' }).accepted, true);
  const dup = reg.register({ verificationId: 'v1' });
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, 'duplicate');
  assert.equal(reg.pendingCount(), 1);
});

test('register: verificationId inválido ⇒ rechazado', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  assert.equal(reg.register({ verificationId: '' }).reason, 'invalid');
  assert.equal(reg.register({}).reason, 'invalid');
  assert.equal(reg.register({ verificationId: 123 }).reason, 'invalid');
});

test('cap de concurrencia: la tarea N+1 sobre cap N degrada, NUNCA spawnea ilimitado (CA-10)', () => {
  const reg = opt.createBackgroundRegistry({ cap: 2 });
  assert.equal(reg.register({ verificationId: 'v1' }).accepted, true);
  assert.equal(reg.register({ verificationId: 'v2' }).accepted, true);
  const over = reg.register({ verificationId: 'v3' });
  assert.equal(over.accepted, false);
  assert.equal(over.reason, 'cap_exceeded');
  assert.equal(reg.pendingCount(), 2, 'el cap se mantiene exacto');
});

test('cap por defecto cuando no se pasa o es inválido', () => {
  assert.equal(opt.createBackgroundRegistry({}).cap, opt.DEFAULT_CAP);
  assert.equal(opt.createBackgroundRegistry({ cap: 0 }).cap, opt.DEFAULT_CAP);
  assert.equal(opt.createBackgroundRegistry({ cap: -3 }).cap, opt.DEFAULT_CAP);
  assert.equal(opt.createBackgroundRegistry({ cap: 5 }).cap, 5);
});

// -----------------------------------------------------------------------------
// hard-timeout / reap — CA-3 + CA-10 (clamp ≤90s + limpieza fail-closed)
// -----------------------------------------------------------------------------
test('hardTimeoutMs se clampa al techo de 90s (CA-3)', () => {
  assert.equal(opt.createBackgroundRegistry({ hardTimeoutMs: 500_000 }).hardTimeoutMs, opt.HARD_TIMEOUT_CEILING_MS);
  assert.equal(opt.createBackgroundRegistry({ hardTimeoutMs: 30_000 }).hardTimeoutMs, 30_000);
  assert.equal(opt.createBackgroundRegistry({}).hardTimeoutMs, opt.HARD_TIMEOUT_CEILING_MS);
});

test('reap: tarea colgada se limpia a ≤90s y queda timeout (fail-closed, deja ⏳)', () => {
  let clock = 1000;
  const reg = opt.createBackgroundRegistry({ cap: 4, hardTimeoutMs: 90_000, now: () => clock });
  reg.register({ verificationId: 'v1', channel: 'text' });
  // antes del timeout: no reapea
  clock = 1000 + 89_000;
  assert.equal(reg.reap(clock).length, 0);
  assert.equal(reg.get('v1').status, 'pending');
  // al cruzar 90s: reapea y marca timeout (NO resolved → ⏳ persiste)
  clock = 1000 + 90_000;
  const expired = reg.reap(clock);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].verificationId, 'v1');
  assert.equal(reg.get('v1').status, 'timeout');
  // libera un slot del cap
  assert.equal(reg.pendingCount(), 0);
});

// -----------------------------------------------------------------------------
// resolveVerdict — CA-7 fail-closed
// -----------------------------------------------------------------------------
test('resolveVerdict approved ⇒ removeDisclaimer=true, sin corrección (CA-7)', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  reg.register({ verificationId: 'v1', channel: 'text' });
  const r = reg.resolveVerdict({ verificationId: 'v1', verdict: 'approved' });
  assert.equal(r.ok, true);
  assert.equal(r.removeDisclaimer, true);
  assert.equal(r.needsCorrection, false);
});

test('resolveVerdict rejected ⇒ ⏳ persiste + needsCorrection (CA-7)', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  reg.register({ verificationId: 'v1', channel: 'voice' });
  const r = reg.resolveVerdict({ verificationId: 'v1', verdict: 'rejected' });
  assert.equal(r.removeDisclaimer, false);
  assert.equal(r.needsCorrection, true);
  assert.equal(r.channel, 'voice');
});

test('resolveVerdict error/timeout/null ⇒ ⏳ persiste (fail-closed, no fail-open)', () => {
  for (const v of ['error', 'timeout', null, undefined, 'weird']) {
    const reg = opt.createBackgroundRegistry({ cap: 4 });
    reg.register({ verificationId: 'v1' });
    const r = reg.resolveVerdict({ verificationId: 'v1', verdict: v });
    assert.equal(r.removeDisclaimer, false, `verdict=${v} NO debe remover ⏳`);
    assert.equal(r.needsCorrection, true);
  }
});

test('resolveVerdict idempotente: no re-resuelve una tarea ya resuelta', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  reg.register({ verificationId: 'v1' });
  reg.resolveVerdict({ verificationId: 'v1', verdict: 'approved' });
  const again = reg.resolveVerdict({ verificationId: 'v1', verdict: 'rejected' });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already_resolved');
});

test('resolveVerdict de tarea desconocida ⇒ ok=false sin remover ⏳', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  const r = reg.resolveVerdict({ verificationId: 'nope', verdict: 'approved' });
  assert.equal(r.ok, false);
  assert.equal(r.removeDisclaimer, false);
});

// -----------------------------------------------------------------------------
// fail-closed cuando el background "muere" — el ⏳ persiste
// -----------------------------------------------------------------------------
test('bg muere (timeout vía reap) ⇒ el ⏳ persiste; solo approved lo remueve', () => {
  let clock = 0;
  const reg = opt.createBackgroundRegistry({ cap: 4, hardTimeoutMs: 90_000, now: () => clock });
  reg.register({ verificationId: 'v1', channel: 'text' });
  clock = 90_000;
  reg.reap(clock);
  // tras el reap (timeout), un intento de resolver no aplica (ya no es pending)
  const r = reg.resolveVerdict({ verificationId: 'v1', verdict: 'approved' });
  assert.equal(r.ok, false, 'una tarea ya timeouteada no puede ser aprobada tarde');
  assert.equal(reg.get('v1').status, 'timeout');
});

// -----------------------------------------------------------------------------
// attachMessageId — CA-6 captura async idempotente
// -----------------------------------------------------------------------------
test('attachMessageId: liga el message_id y es idempotente (no pisa, CA-6)', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  reg.register({ verificationId: 'v1', correlationId: 'cmd-1', channel: 'text' });
  assert.equal(reg.attachMessageId({ verificationId: 'v1', messageId: 555 }).ok, true);
  assert.equal(reg.get('v1').messageId, 555);
  // segunda llegada (fuera de orden / duplicada) no pisa
  const second = reg.attachMessageId({ verificationId: 'v1', messageId: 999 });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already_set');
  assert.equal(reg.get('v1').messageId, 555);
});

test('attachMessageId: tarea desconocida / id inválido ⇒ no liga', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  reg.register({ verificationId: 'v1' });
  assert.equal(reg.attachMessageId({ verificationId: 'x', messageId: 1 }).reason, 'unknown');
  assert.equal(reg.attachMessageId({ verificationId: 'v1', messageId: 'NaN' }).reason, 'invalid');
});

// -----------------------------------------------------------------------------
// enqueueCorrection — CA-6 idempotencia + CA-5/CA-8 decisión
// -----------------------------------------------------------------------------
test('enqueueCorrection texto editable ⇒ action=editMessageText, una sola vez (CA-6)', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  reg.register({ verificationId: 'v1', correlationId: 'cmd-1', channel: 'text' });
  const r1 = reg.enqueueCorrection({ verificationId: 'v1', correlationId: 'cmd-1', editAvailable: true });
  assert.equal(r1.accepted, true);
  assert.equal(r1.action, opt.CORRECTION_EDIT);
  // recibo duplicado / fuera de orden: dedupe atómico → NO doble edición
  const r2 = reg.enqueueCorrection({ verificationId: 'v1', correlationId: 'cmd-1', editAvailable: true });
  assert.equal(r2.accepted, false);
  assert.equal(r2.reason, 'duplicate');
});

test('enqueueCorrection voz ⇒ action=followup (CA-5)', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  reg.register({ verificationId: 'v1', correlationId: 'cmd-1', channel: 'voice' });
  const r = reg.enqueueCorrection({ verificationId: 'v1', correlationId: 'cmd-1' });
  assert.equal(r.action, opt.CORRECTION_FOLLOWUP);
});

test('enqueueCorrection texto sin edición ⇒ fallback followup (CA-8)', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  reg.register({ verificationId: 'v1', correlationId: 'cmd-1', channel: 'text' });
  const r = reg.enqueueCorrection({ verificationId: 'v1', correlationId: 'cmd-1', editAvailable: false });
  assert.equal(r.action, opt.CORRECTION_FOLLOWUP);
});

test('enqueueCorrection deriva el canal de la tarea registrada si no se pasa', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  reg.register({ verificationId: 'v1', correlationId: 'cmd-1', channel: 'voice' });
  const r = reg.enqueueCorrection({ verificationId: 'v1', correlationId: 'cmd-1', editAvailable: true });
  assert.equal(r.action, opt.CORRECTION_FOLLOWUP, 'voz: ignora editAvailable');
});

test('enqueueCorrection verificationId inválido ⇒ rechazado', () => {
  const reg = opt.createBackgroundRegistry({ cap: 4 });
  assert.equal(reg.enqueueCorrection({ verificationId: '' }).reason, 'invalid');
});

// -----------------------------------------------------------------------------
// buildAuditPayload — CA-12 sin contenido crudo
// -----------------------------------------------------------------------------
test('buildAuditPayload hashea el verificationId y nunca incluye contenido crudo (CA-12)', () => {
  const p = opt.buildAuditPayload({
    event: opt.AUDIT_BACKGROUND_VERDICT,
    channel: 'text',
    verificationId: 'v-secreto-123',
    verdict: 'rejected',
  });
  assert.equal(p.event, opt.AUDIT_BACKGROUND_VERDICT);
  assert.equal(p.channel, 'text');
  assert.equal(p.verdict, 'rejected');
  assert.match(p.verificationHash, /^[0-9a-f]{16}$/, 'SHA-256 truncado 16 hex');
  assert.equal(p.verificationHash, opt.hashFor('v-secreto-123'));
  assert.ok(!('verificationId' in p), 'NUNCA el id crudo');
});

test('buildAuditPayload editOutcome para sherlock_edit_result', () => {
  for (const outcome of ['success', 'fail', 'fallback']) {
    const p = opt.buildAuditPayload({ event: opt.AUDIT_EDIT_RESULT, verificationId: 'v1', editOutcome: outcome });
    assert.equal(p.event, 'sherlock_edit_result');
    assert.equal(p.editOutcome, outcome);
  }
});

test('nombres de eventos de audit son los canónicos (CA-12)', () => {
  assert.equal(opt.AUDIT_OPTIMISTIC_SEND, 'sherlock_optimistic_send');
  assert.equal(opt.AUDIT_BACKGROUND_VERDICT, 'sherlock_background_verdict');
  assert.equal(opt.AUDIT_EDIT_RESULT, 'sherlock_edit_result');
});

// -----------------------------------------------------------------------------
// hashFor — SHA-256 truncado
// -----------------------------------------------------------------------------
test('hashFor: SHA-256 truncado, determinístico, sin filtrar el original', () => {
  const h = opt.hashFor('hola');
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(h, opt.hashFor('hola'));
  assert.notEqual(h, opt.hashFor('chau'));
  assert.equal(opt.hashFor(null), opt.hashFor(''));
});
