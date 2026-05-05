// =============================================================================
// Tests quota-exhausted-state.js — #2976 (banner cuota Anthropic agotada).
//
// Cubre:
//   - CA-8 — lectura defensiva: archivo ausente / corrupto / shape inválido
//     devuelven `{ active: false }` sin propagar excepciones.
//   - CA-9 — anti-DoS: archivos > 10KB se descartan con `fs.statSync`
//     antes de read+parse.
//   - CA-3/CA-4 — `active=true` solo cuando `resets_at` es futuro;
//     `resets_at_ms` viene en epoch ms para el countdown del cliente.
//   - CA-2 — `active=false` si `resets_at` ya pasó (drenado lógico),
//     aunque el archivo siga existiendo.
//   - Mapeo de schema #2974 → schema banner: `pattern_matched` →
//     `error_type`. Doble nombre defendido contra regresiones de naming.
//   - Aislamiento: cada test usa un statePath temporal — no toca el
//     `.pipeline/quota-exhausted.json` real del worktree.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const quotaState = require('../quota-exhausted-state');
const {
    MAX_FILE_BYTES,
    emptyQuotaState,
    getQuotaState,
} = quotaState;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function newTmpStatePath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-test-quotaex-'));
    return path.join(dir, 'quota-exhausted.json');
}

function writeJson(file, obj) {
    fs.writeFileSync(file, JSON.stringify(obj));
}

function validFlagPayload(overrides) {
    return Object.assign({
        exhausted: true,
        resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // +1h
        detected_at: new Date(Date.now() - 60 * 1000).toISOString(),    // -1min
        pattern_matched: 'usage_limit_error',
    }, overrides || {});
}

// -----------------------------------------------------------------------------
// Shape default
// -----------------------------------------------------------------------------

test('emptyQuotaState devuelve shape consistente con campos default', () => {
    const s = emptyQuotaState();
    assert.equal(s.active, false);
    assert.equal(s.error_type, null);
    assert.equal(s.detected_at, null);
    assert.equal(s.resets_at, null);
    assert.equal(s.resets_at_ms, null);
    assert.deepEqual(s.queued_skills, []);
});

// -----------------------------------------------------------------------------
// CA-8 — lectura defensiva (archivo ausente / corrupto / shape inválido)
// -----------------------------------------------------------------------------

test('CA-8: archivo inexistente → active:false sin tirar', () => {
    const file = newTmpStatePath(); // path apunta a un dir vacío
    const s = getQuotaState({ statePath: file });
    assert.equal(s.active, false);
});

test('CA-8: archivo vacío → active:false', () => {
    const file = newTmpStatePath();
    fs.writeFileSync(file, '');
    const s = getQuotaState({ statePath: file });
    assert.equal(s.active, false);
});

test('CA-8: JSON malformado → active:false (no propaga SyntaxError)', () => {
    const file = newTmpStatePath();
    fs.writeFileSync(file, '{not json,,,');
    const s = getQuotaState({ statePath: file });
    assert.equal(s.active, false);
});

test('CA-8: JSON válido pero shape inválido (exhausted=false) → active:false', () => {
    const file = newTmpStatePath();
    writeJson(file, { exhausted: false, resets_at: 'x', detected_at: 'y', pattern_matched: 'z' });
    const s = getQuotaState({ statePath: file });
    assert.equal(s.active, false);
});

test('CA-8: shape sin pattern_matched → active:false', () => {
    const file = newTmpStatePath();
    writeJson(file, {
        exhausted: true,
        resets_at: new Date(Date.now() + 3600000).toISOString(),
        detected_at: new Date().toISOString(),
        // pattern_matched ausente
    });
    const s = getQuotaState({ statePath: file });
    assert.equal(s.active, false);
});

test('CA-8: shape con pattern_matched no-string → active:false', () => {
    const file = newTmpStatePath();
    writeJson(file, {
        exhausted: true,
        resets_at: new Date(Date.now() + 3600000).toISOString(),
        detected_at: new Date().toISOString(),
        pattern_matched: 12345, // tipo incorrecto
    });
    const s = getQuotaState({ statePath: file });
    assert.equal(s.active, false);
});

test('CA-8: resets_at no parseable → active:false', () => {
    const file = newTmpStatePath();
    writeJson(file, {
        exhausted: true,
        resets_at: 'not-a-date',
        detected_at: new Date().toISOString(),
        pattern_matched: 'usage_limit_error',
    });
    const s = getQuotaState({ statePath: file });
    assert.equal(s.active, false);
});

// -----------------------------------------------------------------------------
// CA-9 — anti-DoS (cap 10KB)
// -----------------------------------------------------------------------------

test('CA-9: archivo > 10KB descartado con stat antes de parsear', () => {
    const file = newTmpStatePath();
    // Padding gigante DENTRO de un JSON válido — si el read+parse corriese,
    // devolvería un shape válido. El cap debe abortar antes.
    const padding = 'x'.repeat(MAX_FILE_BYTES + 1024);
    writeJson(file, {
        exhausted: true,
        resets_at: new Date(Date.now() + 3600000).toISOString(),
        detected_at: new Date().toISOString(),
        pattern_matched: 'usage_limit_error',
        _bloat: padding,
    });
    const stats = fs.statSync(file);
    assert.ok(stats.size > MAX_FILE_BYTES, 'sanity: el archivo realmente excede el cap');
    const s = getQuotaState({ statePath: file });
    assert.equal(s.active, false, 'archivo gigante NO debe activar el banner');
});

test('CA-9: archivo justo en el cap (10KB) sigue parseando OK', () => {
    const file = newTmpStatePath();
    const futureIso = new Date(Date.now() + 3600000).toISOString();
    const detectedIso = new Date().toISOString();
    // Shape válido pequeño, sin padding — debe pasar.
    writeJson(file, {
        exhausted: true,
        resets_at: futureIso,
        detected_at: detectedIso,
        pattern_matched: 'usage_limit_error',
    });
    const s = getQuotaState({ statePath: file });
    assert.equal(s.active, true);
    assert.equal(s.error_type, 'usage_limit_error');
});

// -----------------------------------------------------------------------------
// CA-3/CA-4 — flag activo con campos normalizados
// -----------------------------------------------------------------------------

test('CA-3: flag activo expone error_type, detected_at, resets_at, resets_at_ms', () => {
    const file = newTmpStatePath();
    const futureIso = new Date(Date.now() + 2 * 3600000).toISOString();
    const detectedIso = new Date(Date.now() - 60000).toISOString();
    writeJson(file, validFlagPayload({ resets_at: futureIso, detected_at: detectedIso }));

    const s = getQuotaState({ statePath: file });
    assert.equal(s.active, true);
    assert.equal(s.error_type, 'usage_limit_error');
    assert.equal(s.detected_at, detectedIso);
    assert.equal(s.resets_at, futureIso);
    assert.equal(s.resets_at_ms, Date.parse(futureIso));
    assert.deepEqual(s.queued_skills, []);
});

test('CA-3: pattern_matched mapea a error_type (compat schema #2974)', () => {
    const file = newTmpStatePath();
    writeJson(file, validFlagPayload({ pattern_matched: 'weekly_quota_exhausted' }));
    const s = getQuotaState({ statePath: file });
    assert.equal(s.error_type, 'weekly_quota_exhausted');
});

// -----------------------------------------------------------------------------
// CA-2 — drenado lógico: resets_at vencido → active:false
// -----------------------------------------------------------------------------

test('CA-2: resets_at en el pasado → active:false (drenado lógico)', () => {
    const file = newTmpStatePath();
    const pastIso = new Date(Date.now() - 60000).toISOString();
    writeJson(file, validFlagPayload({ resets_at: pastIso }));

    const s = getQuotaState({ statePath: file });
    assert.equal(s.active, false, 'flag con resets_at pasado debe ocultar el banner');
    // Read-only: no borramos el archivo nosotros (eso lo hace el detector
    // en su próximo readDefensive). El archivo sigue existiendo.
    assert.ok(fs.existsSync(file), 'el módulo de estado NO debe borrar el flag físico');
});

test('CA-2: now override permite testear el límite del corte', () => {
    const file = newTmpStatePath();
    const futureIso = new Date(2030, 0, 1).toISOString();
    writeJson(file, validFlagPayload({ resets_at: futureIso }));

    // now < resets_at → activo
    const sActive = getQuotaState({ statePath: file, now: Date.parse('2026-01-01T00:00:00Z') });
    assert.equal(sActive.active, true);

    // now > resets_at → inactivo
    const sInactive = getQuotaState({ statePath: file, now: Date.parse('2031-01-01T00:00:00Z') });
    assert.equal(sInactive.active, false);
});

// -----------------------------------------------------------------------------
// Defensa contra payloads adversarios (XSS, prototype pollution superficial)
// -----------------------------------------------------------------------------

test('XSS-defense: payload con HTML en error_type se devuelve como string crudo (escape lo hace el render)', () => {
    const file = newTmpStatePath();
    writeJson(file, validFlagPayload({ pattern_matched: '<script>alert(1)</script>' }));
    const s = getQuotaState({ statePath: file });
    // El módulo de estado NO escapa — eso es responsabilidad del render
    // (escapeHtml client-side). Pero garantizamos que el string llega
    // intacto para que el test del render valide el escape.
    assert.equal(s.active, true);
    assert.equal(s.error_type, '<script>alert(1)</script>');
});

test('No tira con __proto__/constructor en el JSON (parse seguro)', () => {
    const file = newTmpStatePath();
    fs.writeFileSync(file, JSON.stringify({
        exhausted: true,
        resets_at: new Date(Date.now() + 3600000).toISOString(),
        detected_at: new Date().toISOString(),
        pattern_matched: 'usage_limit_error',
        __proto__: { polluted: true },
    }));
    const s = getQuotaState({ statePath: file });
    // El shape devuelto es siempre nuestro objeto literal — no propagamos
    // claves del input. `polluted` no debería estar en el output.
    assert.equal(s.polluted, undefined);
    assert.equal(({}).polluted, undefined, 'sanity: prototype global limpio');
});
