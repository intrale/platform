'use strict';
const fs = require('fs');
const { patch } = require('./patch');
const B = '`';

// ── 1 · request-classify.test.js ───────────────────────────────────────────
patch('.pipeline/lib/commander/__tests__/request-classify.test.js', [
  [
`//   T-8  robustez: input vacío / parcial no tira.`,
`//   T-8  robustez: input vacío / parcial no tira.
//   T-9  #6459 — ${B}huerfano${B}: valor del enum, precedencia y back-compat.`],
]);

fs.appendFileSync('.pipeline/lib/commander/__tests__/request-classify.test.js', `
// --- T-9 #6459 · resultado \`huerfano\` -----------------------------------------
// El turno se ejecutó ENTERO y su respuesta nunca se confirmó como entregada.

test('#6459: huerfano es un valor válido del enum cerrado RESULTADOS', () => {
  assert.ok(RESULTADOS.includes('huerfano'), 'falta huerfano en el enum');
  assert.equal(RESULTADOS.length, 5);
  // R-7: el valor va SIN tilde — de acá sale la clase CSS \`cmd-result-\${v}\`.
  assert.ok(!RESULTADOS.some((v) => /[áéíóúÁÉÍÓÚ]/.test(v)), 'ningún valor del enum lleva tilde');
});

test('#6459: deliveryUnconfirmed true y sin error ⇒ huerfano', () => {
  assert.equal(classifyCommanderResult({ deliveryUnconfirmed: true }).resultado, 'huerfano');
});

test('#6459: error GANA a huerfano — el operador necesita saber que falló', () => {
  // La guarda del arquitecto es \`hadError !== true\`; acá se extiende a TODAS las
  // condiciones de error, que es lo que dice su propia justificación.
  assert.equal(classifyCommanderResult({ deliveryUnconfirmed: true, hadError: true }).resultado, 'error');
  assert.equal(classifyCommanderResult({ deliveryUnconfirmed: true, emptyResponse: true }).resultado, 'error');
  assert.equal(
    classifyCommanderResult({ deliveryUnconfirmed: true, sherlockDisclaimerType: 'timeout' }).resultado,
    'error');
});

test('#6459: huerfano GANA a ajustada y a fallback', () => {
  assert.equal(classifyCommanderResult({
    deliveryUnconfirmed: true,
    sherlockVerdict: { verdict: 'rechazado' },
    dispatchResolution: { provider: 'anthropic', crossProvider: true, fallbackUsed: 'cerebras' },
  }).resultado, 'huerfano');
});

test('#6459: sin el flag la clasificación es IDÉNTICA a la de antes (back-compat)', () => {
  assert.equal(classifyCommanderResult({}).resultado, 'ok');
  assert.equal(classifyCommanderResult({ deliveryUnconfirmed: false }).resultado, 'ok');
  assert.equal(classifyCommanderResult({ sherlockVerdict: { verdict: 'rechazado' } }).resultado, 'ajustada');
  assert.equal(classifyCommanderResult({ dispatchResolution: { crossProvider: true } }).resultado, 'fallback');
  assert.equal(classifyCommanderResult({ hadError: true }).resultado, 'error');
  // Un valor no-boolean tampoco activa el estado nuevo (comparación estricta).
  assert.equal(classifyCommanderResult({ deliveryUnconfirmed: 'sí' }).resultado, 'ok');
  assert.equal(classifyCommanderResult({ deliveryUnconfirmed: 1 }).resultado, 'ok');
});
`);
console.log('OK request-classify.test.js (append)');

// ── 2 · result-badge.test.js ───────────────────────────────────────────────
patch('.pipeline/lib/commander/__tests__/result-badge.test.js', [
  [
`//   T-6  escape HTML de TODO campo dinámico (CA-4, stored XSS).`,
`//   T-6  escape HTML de TODO campo dinámico (CA-4, stored XSS).
//   T-7  #6459 — el badge \`huerfano\` renderiza propio y no reusa el de error.`],
]);

fs.appendFileSync('.pipeline/lib/commander/__tests__/result-badge.test.js', `
// --- T-7 #6459 · badge \`huerfano\` ---------------------------------------------
test('#6459: huerfano renderiza badge PROPIO (no cadena vacía) con su clase', () => {
  const html = buildResultBadges({ resultado: 'huerfano' }, escapeHtml);
  assert.notEqual(html, '', 'el badge no puede quedar vacío: sería indistinguible de un log viejo');
  assert.ok(html.includes('cmd-result-huerfano'), 'falta la clase semántica');
  assert.ok(html.includes('∅'), 'falta el glifo');
  assert.ok(html.includes('hu&#233;rfano') || html.includes('huérfano'), 'falta la etiqueta');
  // CA-4: el color no es la única señal — glifo + etiqueta siempre presentes.
  assert.ok(!html.includes('cmd-result-error'), 'no reusa el badge de error');
});

test('#6459: R-7 — la clase CSS sale del enum SIN tilde, la tilde vive en el texto', () => {
  const { glyph, label, title } = RESULT_BADGES.huerfano;
  assert.equal(glyph, '∅');
  assert.equal(label, 'huérfano');       // texto para el operador: CON tilde
  assert.ok(/nunca se confirm/.test(title));
  const html = buildResultBadges({ resultado: 'huerfano' }, escapeHtml);
  assert.ok(!html.includes('cmd-result-huérfano'), 'la clase NO puede llevar tilde');
});
`);
console.log('OK result-badge.test.js (append)');

// ── 3 · commander-inflight-fallback.test.js ────────────────────────────────
fs.appendFileSync('.pipeline/lib/__tests__/commander-inflight-fallback.test.js', `
// =============================================================================
// #6459 — \`fallback_delivery_resolved\` con desenlace EXPLÍCITO (R-1).
//
// El entry de \`noteFallbackDeliveryResolved\` no tenía \`success\` ni \`error_code\`,
// y los literales \`'delivered'\`/\`'not_delivered'\` que proponía el body de #6459 no
// existen en \`DELIVERY_STATES\`: \`_normalizeDeliveryState\` los colapsa a \`null\` en
// silencio. Sin los dos campos nuevos, CA-2 y CA-3 son inverificables.
// =============================================================================

test('#6459 CA-3: entrega CONFIRMADA cierra a éxito, sin regresión de #4309', () => {
    const dir = mkTmpPipelineDir();
    try {
        inflight.noteFallbackDeliveryResolved({
            pipelineDir: dir, deliveryState: 'delivery_observed', resolvedBy: 'orphan_sweep',
            success: true, commanderReqId: 'h-ok', chatId: 'c', requestId: 'r-ok',
        });
        const ev = readAuditLines(dir).find(e => e.event === 'inflight_fallback_delivery_resolved');
        assert.equal(ev.delivery_state, 'delivery_observed');
        assert.equal(ev.success, true);
        assert.equal(ev.error_code, null);
        assert.equal(ev.commander_req_id, 'h-ok');
    } finally { cleanup(dir); }
});

test('#6459 CA-2: entrega NO confirmada cierra con delivered=false, distinguible de empty_output', () => {
    const dir = mkTmpPipelineDir();
    try {
        inflight.noteFallbackDeliveryResolved({
            pipelineDir: dir, deliveryState: 'delivery_failed', resolvedBy: 'orphan_sweep',
            success: false, errorCode: 'delivered=false',
            commanderReqId: 'h-no', chatId: 'c', requestId: 'r-no',
        });
        const ev = readAuditLines(dir).find(e => e.event === 'inflight_fallback_delivery_resolved');
        assert.equal(ev.delivery_state, 'delivery_failed');
        assert.equal(ev.success, false);
        assert.equal(ev.error_code, 'delivered=false');
        assert.notEqual(ev.error_code, 'empty_output');
    } finally { cleanup(dir); }
});

test('#6459: sin los campos nuevos el desenlace queda NO OBSERVADO (null), no false', () => {
    const dir = mkTmpPipelineDir();
    try {
        inflight.noteFallbackDeliveryResolved({
            pipelineDir: dir, deliveryState: 'delivery_pending', resolvedBy: 'reconciler',
            commanderReqId: 'h-null', chatId: 'c', requestId: 'r-null',
        });
        const ev = readAuditLines(dir).find(e => e.event === 'inflight_fallback_delivery_resolved');
        assert.equal(ev.success, null, '"no observado" y "observado como fallo" son cosas distintas');
        assert.equal(ev.error_code, null);
    } finally { cleanup(dir); }
});

test('#6459: error_code es texto ACOTADO (anti log-forging)', () => {
    const dir = mkTmpPipelineDir();
    try {
        inflight.noteFallbackDeliveryResolved({
            pipelineDir: dir, deliveryState: 'delivery_failed', resolvedBy: 'orphan_sweep',
            success: false, errorCode: 'x'.repeat(500),
            commanderReqId: 'h-long', chatId: 'c', requestId: 'r-long',
        });
        const ev = readAuditLines(dir).find(e => e.event === 'inflight_fallback_delivery_resolved');
        assert.equal(ev.error_code.length, 64);
        // Un errorCode no-string no se persiste crudo.
        assert.equal(ev.success, false);
    } finally { cleanup(dir); }
});

test('#6459 CA-4: una entrada VIEJA sin los campos nuevos sigue verificando la hash-chain', () => {
    const dir = mkTmpPipelineDir();
    try {
        // Entradas "viejas" (sin success/error_code en el resolved) y nuevas,
        // encadenadas en el mismo archivo: los campos aditivos AL FINAL no
        // rompen el hash de las que no los traen.
        inflight.noteInflightCompleted({
            pipelineDir: dir, primaryProvider: 'anthropic', secondaryProvider: 'openai-codex',
            success: true, chatId: 'c', requestId: 'r-1',
        });
        inflight.noteFallbackDeliveryResolved({
            pipelineDir: dir, deliveryState: 'delivery_failed', resolvedBy: 'reconciler',
            commanderReqId: 'h-viejo', chatId: 'c', requestId: 'r-1',
        });
        inflight.noteFallbackDeliveryResolved({
            pipelineDir: dir, deliveryState: 'delivery_failed', resolvedBy: 'orphan_sweep',
            success: false, errorCode: 'delivered=false',
            commanderReqId: 'h-nuevo', chatId: 'c', requestId: 'r-2',
        });
        const res = auditLog.verifyChain(inflight._auditFile(dir));
        assert.equal(res.ok, true, JSON.stringify(res));
        assert.equal(res.entriesChecked, 3);
    } finally { cleanup(dir); }
});
`);
console.log('OK commander-inflight-fallback.test.js (append)');
