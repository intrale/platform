// =============================================================================
// stt-confidence-gate.test.js — Gate de confirmación por baja confianza (#3918, CA-2)
//
// Cobertura (100% ramas del evaluador de confianza):
//   - assessSttConfidence: low (avgLogprob / noSpeechProb), ok, unknown (RS-6).
//   - assessConsolidatedConfidence: cualquier low → low; ok; todos unknown.
//   - isConfirmationText: afirmativos cortos sí; embebidos / negativos no.
//   - isPendingConfirmationFresh: vigencia 5 min y expiración (RS-4).
//   - RS-4: el gate es ADITIVO — la confianza no es señal de autorización ni
//     acopla con el cooldown destructivo.
//   - RS-6: confianza desconocida → eco sí, confirmación no (verdict unknown).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const stt = require('../lib/commander/stt-confidence');
const { CONFIDENCE } = stt;
const transcriptEcho = require('../lib/commander/transcript-echo');

// --- assessSttConfidence ---

test('low por avgLogprob bajo el umbral (-0.7)', () => {
    assert.equal(stt.assessSttConfidence({ avgLogprob: -0.9 }), CONFIDENCE.LOW);
});

test('low por noSpeechProb sobre el umbral (0.5)', () => {
    assert.equal(stt.assessSttConfidence({ avgLogprob: -0.1, noSpeechProb: 0.8 }), CONFIDENCE.LOW);
});

test('ok cuando ambas métricas están en rango bueno', () => {
    assert.equal(stt.assessSttConfidence({ avgLogprob: -0.2, noSpeechProb: 0.1 }), CONFIDENCE.OK);
});

test('umbral exacto avgLogprob = -0.7 → ok (estricto <)', () => {
    assert.equal(stt.assessSttConfidence({ avgLogprob: -0.7 }), CONFIDENCE.OK);
});

test('umbral exacto noSpeechProb = 0.5 → ok (estricto >)', () => {
    assert.equal(stt.assessSttConfidence({ avgLogprob: -0.1, noSpeechProb: 0.5 }), CONFIDENCE.OK);
});

test('RS-6: sin objeto → unknown', () => {
    assert.equal(stt.assessSttConfidence(null), CONFIDENCE.UNKNOWN);
    assert.equal(stt.assessSttConfidence(undefined), CONFIDENCE.UNKNOWN);
    assert.equal(stt.assessSttConfidence('mal'), CONFIDENCE.UNKNOWN);
});

test('RS-6: métricas no finitas → unknown', () => {
    assert.equal(stt.assessSttConfidence({ avgLogprob: Infinity }), CONFIDENCE.UNKNOWN);
    assert.equal(stt.assessSttConfidence({ avgLogprob: NaN, noSpeechProb: NaN }), CONFIDENCE.UNKNOWN);
    assert.equal(stt.assessSttConfidence({}), CONFIDENCE.UNKNOWN);
});

test('una sola métrica finita basta para evaluar', () => {
    assert.equal(stt.assessSttConfidence({ avgLogprob: -1.2 }), CONFIDENCE.LOW);
    assert.equal(stt.assessSttConfidence({ noSpeechProb: 0.9 }), CONFIDENCE.LOW);
    assert.equal(stt.assessSttConfidence({ avgLogprob: -0.3 }), CONFIDENCE.OK);
});

// --- assessConsolidatedConfidence ---

test('cualquier audio low → consolidado low', () => {
    const v = stt.assessConsolidatedConfidence([{ avgLogprob: -0.2 }, { avgLogprob: -0.9 }, null]);
    assert.equal(v, CONFIDENCE.LOW);
});

test('ninguno low pero alguno ok → ok', () => {
    const v = stt.assessConsolidatedConfidence([null, { avgLogprob: -0.2 }]);
    assert.equal(v, CONFIDENCE.OK);
});

test('todos desconocidos → unknown', () => {
    assert.equal(stt.assessConsolidatedConfidence([null, {}, 'x']), CONFIDENCE.UNKNOWN);
});

test('lista vacía o no-array → unknown', () => {
    assert.equal(stt.assessConsolidatedConfidence([]), CONFIDENCE.UNKNOWN);
    assert.equal(stt.assessConsolidatedConfidence(null), CONFIDENCE.UNKNOWN);
});

// --- isConfirmationText ---

test('afirmativos cortos → true', () => {
    for (const s of ['sí', 'si', 'Sí', 'dale', 'OK', 'okay', 'confirmo', 'de una', 'hacelo', 'adelante', 'listo', 'sí!']) {
        assert.equal(stt.isConfirmationText(s), true, `esperaba confirmación: "${s}"`);
    }
});

test('negativos / instrucciones nuevas → false', () => {
    for (const s of ['no', 'mejor no', 'sí, pero cambiá el título', 'creá un issue nuevo', 'esperá', '']) {
        assert.equal(stt.isConfirmationText(s), false, `no debía ser confirmación: "${s}"`);
    }
});

test('no-string → false', () => {
    assert.equal(stt.isConfirmationText(null), false);
    assert.equal(stt.isConfirmationText(42), false);
});

// --- isPendingConfirmationFresh (RS-4: expiración 5 min) ---

test('confirmación dentro de la ventana de 5 min → fresca', () => {
    const now = 1_000_000_000_000;
    const ts = now - 4 * 60 * 1000; // hace 4 min
    assert.equal(stt.isPendingConfirmationFresh(ts, now), true);
});

test('RS-4: confirmación vencida (> 5 min) → no fresca, la acción NO se ejecuta', () => {
    const now = 1_000_000_000_000;
    const ts = now - 6 * 60 * 1000; // hace 6 min
    assert.equal(stt.isPendingConfirmationFresh(ts, now), false);
});

test('borde exacto a 5 min → fresca (<=)', () => {
    const now = 1_000_000_000_000;
    assert.equal(stt.isPendingConfirmationFresh(now - stt.PENDING_CONFIRMATION_TTL_MS, now), true);
});

test('ts inválido → no fresca', () => {
    assert.equal(stt.isPendingConfirmationFresh(0), false);
    assert.equal(stt.isPendingConfirmationFresh(NaN), false);
    assert.equal(stt.isPendingConfirmationFresh(-5), false);
});

// --- RS-1/RS-2 (rebote rev-1): la acción citada en el confirmMsg del gate ---
// El gate de baja confianza cita la acción dictada DENTRO del confirmMsg que se
// envía en vivo a Telegram con parse_mode 'Markdown'. Esa cita (`accionTextual`)
// se construye con `formatActionLabel`, que debe aplicar las mismas defensas que
// el eco: escapar Markdown (RS-1) y redactar secretos (RS-2) ANTES de enviar.

test('RS-1: metacaracteres Markdown en la transcripción quedan escapados (no rompen el parseo)', () => {
    const label = transcriptEcho.formatActionLabel(['creá un issue *urgente* con `código` y _énfasis_ [link]']);
    // Cada metacaracter legacy de Telegram queda precedido por backslash.
    assert.match(label, /\\\*urgente\\\*/);
    assert.match(label, /\\`código\\`/);
    assert.match(label, /\\_énfasis\\_/);
    assert.match(label, /\\\[link\]/);
    // No queda ningún metacaracter sin escapar (sin backslash previo).
    assert.ok(!/(^|[^\\])[_*`\[]/.test(label), `quedaron metacaracteres sin escapar: ${label}`);
});

test('RS-2: un secreto dictado se redacta en la acción citada (no se ecoa en plano)', () => {
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dumm_sig';
    const label = transcriptEcho.formatActionLabel([`la clave es ${awsKey} y el token ${jwt}`]);
    assert.ok(!label.includes(awsKey), `la AWS key quedó en plano: ${label}`);
    assert.ok(!label.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), `el JWT quedó en plano: ${label}`);
});

test('RS-1+RS-2 combinados: secreto rodeado de metacaracteres → redactado Y escapado', () => {
    const label = transcriptEcho.formatActionLabel(['*AKIAIOSFODNN7EXAMPLE*']);
    assert.ok(!label.includes('AKIAIOSFODNN7EXAMPLE'), `secreto en plano: ${label}`);
    assert.ok(!/(^|[^\\])\*/.test(label), `asterisco sin escapar: ${label}`);
});

test('formatActionLabel: entradas vacías / no-array → string vacío (sin throw)', () => {
    assert.equal(transcriptEcho.formatActionLabel([]), '');
    assert.equal(transcriptEcho.formatActionLabel(null), '');
    assert.equal(transcriptEcho.formatActionLabel(['', '   ']), '');
});

test('RS-5: la acción citada respeta el cap total con elipsis', () => {
    const label = transcriptEcho.formatActionLabel(['a'.repeat(500)], { maxLen: 50 });
    assert.ok(label.length <= 51, `excede el cap: ${label.length}`);
    assert.ok(label.endsWith('…'), `falta elipsis: ${label}`);
});

// --- RS-4: aditividad — el evaluador es puro y no acopla con el cooldown ---

test('RS-4: el evaluador de confianza no recibe ni consulta estado de cooldown', () => {
    // assessSttConfidence/assessConsolidatedConfidence deciden SÓLO sobre métricas
    // STT. No existe parámetro de cooldown ni efecto colateral: el gate de
    // confianza es independiente y ADITIVO al cooldown destructivo #3253 (que se
    // evalúa por separado en el camino determinístico). Confianza 'ok' NO implica
    // bypass de ningún otro control.
    assert.equal(stt.assessSttConfidence.length, 1);
    assert.equal(stt.assessConsolidatedConfidence.length, 1);
    // 'ok' es sólo "no requiere confirmación STT", no "autorizado".
    assert.equal(stt.assessSttConfidence({ avgLogprob: -0.1, noSpeechProb: 0.1 }), CONFIDENCE.OK);
});
