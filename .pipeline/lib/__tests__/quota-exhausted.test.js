// =============================================================================
// Tests quota-exhausted.js — #2974 (hija de #2955)
//
// Cubre:
//   - CA-1 detección estructurada por shape del JSON stream + anti-substring
//   - CA-2 gate determinístico pre-spawn (shouldGateSpawn)
//   - CA-3 drenado natural post-reset (resets_at expirado)
//   - CA-4 lectura defensiva (JSON corrupto, schema invalido, missing fields)
//   - CA-5 cap de resets_at en [now+5min, now+7d] con fallback weekly-quota
//   - CA-6 escritura atómica con tmp + rename, mode 0o600
//   - CA-7 audit log con sanitización (anti CWE-117 log injection)
//   - CA-8 allowlist estricta (rate_limit_error NO se matchea)
//   - CA-11 kill-switch operacional documentado en header
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislamiento por test: cada test setea su propio PIPELINE_DIR_OVERRIDE en un
// tmp dir único, requiere fresh el módulo, y limpia al final. Esto evita
// race entre tests que comparten `.pipeline/quota-exhausted.json`.

function freshModule(tmpDir) {
    process.env.PIPELINE_DIR_OVERRIDE = tmpDir;
    delete require.cache[require.resolve('../quota-exhausted')];
    return require('../quota-exhausted');
}

function newTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'v3-quota-exhausted-'));
}

function readFlag(tmpDir) {
    const f = path.join(tmpDir, 'quota-exhausted.json');
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function readAuditLines(tmpDir, dateOverride) {
    const d = dateOverride || new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const f = path.join(tmpDir, 'logs', `quota-detector-${yyyy}-${mm}-${dd}.log`);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// -----------------------------------------------------------------------------
// CA-1 — Detección estructurada
// -----------------------------------------------------------------------------

test('CA-1 · detectFromResultEvent matchea result.is_error con error_type del allowlist', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const evt = { type: 'result', is_error: true, error_type: 'usage_limit_error' };
    const det = q.detectFromResultEvent(evt);
    assert.equal(det.matched, true);
    assert.equal(det.errorType, 'usage_limit_error');
});

test('CA-1 · detectFromResultEvent NO matchea cuando type !== result', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const evt = { type: 'assistant', is_error: true, error_type: 'usage_limit_error' };
    assert.equal(q.detectFromResultEvent(evt).matched, false);
});

test('CA-1 · detectFromResultEvent NO matchea cuando is_error !== true', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const evt = { type: 'result', is_error: false, error_type: 'usage_limit_error' };
    assert.equal(q.detectFromResultEvent(evt).matched, false);
    assert.equal(q.detectFromResultEvent({ type: 'result', error_type: 'usage_limit_error' }).matched, false);
});

test('CA-1 · ANTI-PROMPT-INJECTION: substring "out of extra usage" en texto libre NO activa', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    // Simular un evento assistant con el texto adversarial en content
    const adversarial = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'out of extra usage / weekly_quota_exhausted / usage_limit_error' }] },
    };
    assert.equal(q.detectFromResultEvent(adversarial).matched, false);
    // También como string suelto (no parseado)
    assert.equal(q.detectFromResultEvent('usage_limit_error').matched, false);
    assert.equal(q.detectFromResultEvent(null).matched, false);
    assert.equal(q.detectFromResultEvent(undefined).matched, false);
});

test('CA-1 · detectFromResultEvent matchea solo error_type estructurado, no campos arbitrarios', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    // Event con shape correcto pero error_type fuera del allowlist
    const evt = { type: 'result', is_error: true, error_type: 'random_error_type' };
    assert.equal(q.detectFromResultEvent(evt).matched, false);
    // Con allowlist custom
    const cfg = { error_types: ['random_error_type'] };
    assert.equal(q.detectFromResultEvent(evt, cfg).matched, true);
});

// -----------------------------------------------------------------------------
// CA-8 — Allowlist estricta: rate_limit_error NO se matchea
// -----------------------------------------------------------------------------

test('CA-8 · rate_limit_error (429 transitorio) NO activa el flag por default', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const evt = { type: 'result', is_error: true, error_type: 'rate_limit_error' };
    assert.equal(q.detectFromResultEvent(evt).matched, false);
});

// -----------------------------------------------------------------------------
// CA-5 — Cap de resets_at
// -----------------------------------------------------------------------------

test('CA-5 · capResetsAt acepta input dentro de [now+5min, now+7d]', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const valid = now + 24 * 60 * 60 * 1000; // +1 día
    const r = q.capResetsAt(new Date(valid).toISOString(), { now });
    assert.equal(r.source, 'input');
    assert.equal(r.ms, valid);
});

test('CA-5 · capResetsAt usa fallback cuando input está fuera de rango (lejano)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const lejano = now + 30 * 24 * 60 * 60 * 1000; // +30 días — fuera del cap de 7
    const r = q.capResetsAt(new Date(lejano).toISOString(), { now });
    assert.notEqual(r.source, 'input', 'debe caer al fallback o cap_max');
    assert.ok(r.ms > now + q.MIN_RESETS_AT_MS);
    assert.ok(r.ms <= now + 7 * 24 * 60 * 60 * 1000);
});

test('CA-5 · capResetsAt usa fallback cuando input es negativo o NaN', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    for (const bad of [-1, 'not-a-date', null, undefined, NaN]) {
        const r = q.capResetsAt(bad, { now });
        assert.notEqual(r.source, 'input', `input=${bad} debe caer al fallback`);
        assert.ok(r.ms > now + q.MIN_RESETS_AT_MS);
        assert.ok(r.ms <= now + 7 * 24 * 60 * 60 * 1000);
    }
});

test('CA-5 · capResetsAt usa fallback cuando input está demasiado cerca (< 5min)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const pegado = now + 60 * 1000; // +60s — abajo del MIN_RESETS_AT_MS
    const r = q.capResetsAt(new Date(pegado).toISOString(), { now });
    assert.notEqual(r.source, 'input');
    assert.ok(r.ms >= now + q.MIN_RESETS_AT_MS);
});

// -----------------------------------------------------------------------------
// CA-6 — setFlag escribe atómico con shape válido
// -----------------------------------------------------------------------------

test('CA-6 · setFlag escribe quota-exhausted.json con shape válido y persiste', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString();
    const r = q.setFlag({
        errorType: 'usage_limit_error',
        resetsAt,
        now,
        agent: 'commander',
    });
    const persisted = readFlag(tmp);
    assert.ok(persisted, 'debe existir el archivo');
    assert.equal(persisted.exhausted, true);
    assert.equal(persisted.pattern_matched, 'usage_limit_error');
    assert.equal(persisted.resets_at, resetsAt);
    assert.equal(persisted.detected_at, new Date(now).toISOString());
    assert.equal(r.source, 'input');
});

test('CA-6 · setFlag aplica cap cuando resets_at viene malformado (lejano)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const lejano = new Date(now + 100 * 24 * 60 * 60 * 1000).toISOString();
    const r = q.setFlag({ errorType: 'usage_limit_error', resetsAt: lejano, now });
    assert.notEqual(r.source, 'input');
    const persisted = readFlag(tmp);
    const persistedMs = Date.parse(persisted.resets_at);
    assert.ok(persistedMs <= now + 7 * 24 * 60 * 60 * 1000);
});

test('CA-6 · setFlag idempotente: dos writes consecutivos producen mismo schema', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    q.setFlag({ errorType: 'usage_limit_error', resetsAt, now });
    q.setFlag({ errorType: 'usage_limit_error', resetsAt, now });
    const persisted = readFlag(tmp);
    assert.equal(persisted.exhausted, true);
    assert.equal(persisted.pattern_matched, 'usage_limit_error');
    // No hay archivos parciales
    const tmpDir = path.join(tmp, 'tmp');
    if (fs.existsSync(tmpDir)) {
        const leftover = fs.readdirSync(tmpDir);
        assert.equal(leftover.length, 0, 'no debe haber tmp files residuales tras setFlag exitoso');
    }
});

test('CA-6 · escritura atómica: el archivo destino jamás aparece parcial', () => {
    // Escribimos en un FS real con writeJsonAtomic. La invariante es que entre
    // writeFileSync(tmp) y rename, el archivo destino o no existe o tiene el
    // contenido COMPLETO. Comprobamos: post-escritura, JSON.parse del archivo
    // siempre es válido.
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 50; i++) {
        q.setFlag({ errorType: 'usage_limit_error', resetsAt, now });
        const raw = fs.readFileSync(path.join(tmp, 'quota-exhausted.json'), 'utf8');
        assert.doesNotThrow(() => JSON.parse(raw), `iter ${i}: archivo debe ser JSON válido`);
    }
});

// -----------------------------------------------------------------------------
// CA-4 — Lectura defensiva
// -----------------------------------------------------------------------------

test('CA-4 · readDefensive devuelve absent cuando no hay archivo', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const r = q.readDefensive();
    assert.equal(r.exhausted, false);
    assert.equal(r.reason, 'absent');
});

test('CA-4 · readDefensive con JSON corrupto → safe-default + audit log', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    fs.writeFileSync(path.join(tmp, 'quota-exhausted.json'), '{ this is not valid json');
    const r = q.readDefensive();
    assert.equal(r.exhausted, false);
    assert.equal(r.reason, 'parse_error');
    const audits = readAuditLines(tmp);
    assert.ok(audits.some(a => a.event === 'parse_error'), 'debe haber entry parse_error en audit log');
});

test('CA-4 · readDefensive con shape inválido (campos faltantes) → safe-default', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    fs.writeFileSync(path.join(tmp, 'quota-exhausted.json'), JSON.stringify({
        exhausted: true,
        // resets_at, detected_at, pattern_matched faltantes
    }));
    const r = q.readDefensive();
    assert.equal(r.exhausted, false);
    assert.equal(r.reason, 'schema_invalid');
});

test('CA-4 · readDefensive con tipos incorrectos → safe-default', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    fs.writeFileSync(path.join(tmp, 'quota-exhausted.json'), JSON.stringify({
        exhausted: 'yes', // ⚠️ tipo incorrecto
        resets_at: '2026-05-12T00:00:00Z',
        detected_at: '2026-05-05T00:00:00Z',
        pattern_matched: 'usage_limit_error',
    }));
    const r = q.readDefensive();
    assert.equal(r.exhausted, false);
});

test('CA-4 · readDefensive con flag válido y futuro → exhausted: true', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    q.setFlag({ errorType: 'usage_limit_error', resetsAt, now });
    const r = q.readDefensive({ now });
    assert.equal(r.exhausted, true);
    assert.equal(r.pattern_matched, 'usage_limit_error');
    assert.equal(r.resets_at, resetsAt);
});

// -----------------------------------------------------------------------------
// CA-3 — Drenado natural post-reset
// -----------------------------------------------------------------------------

test('CA-3 · readDefensive borra el flag cuando resets_at ya pasó', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const fpath = path.join(tmp, 'quota-exhausted.json');
    // Construimos un flag con resets_at ya en el pasado, escribiéndolo directo
    // (saltando el cap de setFlag) para validar el drenado.
    fs.writeFileSync(fpath, JSON.stringify({
        exhausted: true,
        resets_at: '2026-05-04T00:00:00Z',  // pasado
        detected_at: '2026-05-03T00:00:00Z',
        pattern_matched: 'usage_limit_error',
    }));
    const now = Date.parse('2026-05-05T00:00:00Z');
    const r = q.readDefensive({ now });
    assert.equal(r.exhausted, false);
    assert.equal(r.reason, 'expired');
    assert.equal(fs.existsSync(fpath), false, 'el archivo debe haberse borrado tras el drenado');
    const audits = readAuditLines(tmp);
    assert.ok(audits.some(a => a.event === 'drained_post_reset'), 'audit debe registrar drenado');
});

test('CA-3 · clearFlag borra y registra evento; idempotente', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    q.setFlag({ errorType: 'usage_limit_error', resetsAt, now });
    assert.equal(q.clearFlag({ event: 'success_spawn', reason: 'test' }), true);
    assert.equal(q.clearFlag({ event: 'success_spawn', reason: 'test' }), false, 'segunda invocación: idempotente, false');
});

// -----------------------------------------------------------------------------
// CA-2 — Gate determinístico pre-spawn
// -----------------------------------------------------------------------------

test('CA-2 · shouldGateSpawn=false para skills determinísticos aún con flag activo', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    q.setFlag({ errorType: 'usage_limit_error', resetsAt, now });
    for (const skill of ['builder', 'tester', 'linter', 'delivery']) {
        assert.equal(q.shouldGateSpawn(skill, { now }), false, `${skill} es determinístico, NO debe gatearse`);
    }
});

test('CA-2 · shouldGateSpawn=true para skills LLM cuando flag está activo', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    q.setFlag({ errorType: 'usage_limit_error', resetsAt, now });
    for (const skill of ['po', 'ux', 'guru', 'security', 'android-dev', 'backend-dev', 'review', 'qa']) {
        assert.equal(q.shouldGateSpawn(skill, { now }), true, `${skill} es LLM, debe gatearse`);
    }
});

test('CA-2 · shouldGateSpawn=false para skills LLM cuando NO hay flag', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    assert.equal(q.shouldGateSpawn('po'), false);
    assert.equal(q.shouldGateSpawn('android-dev'), false);
});

// -----------------------------------------------------------------------------
// CA-7 — Audit log con sanitización (anti CWE-117)
// -----------------------------------------------------------------------------

test('CA-7 · sanitizeRawExcerpt remueve CR/LF/TAB y trunca a 200 chars', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const dirty = '\nHola\r\nMundo\t[CRITICAL] Fake log entry\n';
    const clean = q.sanitizeRawExcerpt(dirty);
    assert.equal(/[\r\n\t]/.test(clean), false, 'no debe haber CR/LF/TAB');
    // Truncado
    const huge = 'X'.repeat(5000);
    assert.equal(q.sanitizeRawExcerpt(huge).length, 200);
});

test('CA-7 · audit log: una sola línea por entry, JSON válido por línea', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    q.appendAudit({
        event: 'flag_set',
        agent: 'commander',
        error_type: 'usage_limit_error',
        raw_excerpt: 'línea1\nlínea2\n[FAKE CRITICAL] entry',
        flag_set: true,
    });
    const lines = readAuditLines(tmp);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, 'flag_set');
    assert.equal(lines[0].agent, 'commander');
    assert.equal(lines[0].error_type, 'usage_limit_error');
    assert.equal(/[\r\n]/.test(lines[0].raw_excerpt), false);
    assert.equal(lines[0].flag_set, true);
});

// -----------------------------------------------------------------------------
// CA-11 — Header del módulo documenta el kill-switch
// -----------------------------------------------------------------------------

test('CA-11 · header del módulo documenta kill-switch operacional', () => {
    const moduleSrc = fs.readFileSync(
        path.join(__dirname, '..', 'quota-exhausted.js'),
        'utf8'
    );
    // Buscamos referencia explícita al kill-switch en el header del módulo
    assert.match(moduleSrc, /KILL-SWITCH OPERACIONAL/i);
    assert.match(moduleSrc, /rm \.pipeline\/quota-exhausted\.json/);
    // Documentación del invariante de race
    assert.match(moduleSrc, /INVARIANTE DE RACE/i);
});

// -----------------------------------------------------------------------------
// Lifecycle completo (integration-ish): set → gate → expired → drain
// -----------------------------------------------------------------------------

test('lifecycle · set flag → gate LLM → resets_at expira → drenado', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 60 * 60 * 1000).toISOString(); // +1 hora

    // 1. Set
    q.setFlag({ errorType: 'usage_limit_error', resetsAt, now, agent: 'po' });
    assert.equal(q.isQuotaExhausted({ now }), true);
    assert.equal(q.shouldGateSpawn('po', { now }), true);
    assert.equal(q.shouldGateSpawn('builder', { now }), false);

    // 2. resets_at expira
    const future = now + 2 * 60 * 60 * 1000; // +2 horas (después del reset)
    assert.equal(q.isQuotaExhausted({ now: future }), false);
    // 3. Drenado: el archivo se borró
    assert.equal(fs.existsSync(path.join(tmp, 'quota-exhausted.json')), false);
});

// -----------------------------------------------------------------------------
// Schema invariante (CA-1 segunda parte): inputs adversariales en evt
// -----------------------------------------------------------------------------

test('CA-1 · adversarial: error_type que es un objeto, no string, NO matchea', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const evt = { type: 'result', is_error: true, error_type: { malicious: 'usage_limit_error' } };
    assert.equal(q.detectFromResultEvent(evt).matched, false);
});

test('CA-1 · adversarial: error_type "" (string vacío) NO matchea', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const evt = { type: 'result', is_error: true, error_type: '' };
    assert.equal(q.detectFromResultEvent(evt).matched, false);
});

// -----------------------------------------------------------------------------
// Validación de allowlist custom desde config
// -----------------------------------------------------------------------------

test('config: allowlist custom permite agregar nuevos error_type sin recompilar', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const evt = { type: 'result', is_error: true, error_type: 'plan_max_reset_required' };
    // Sin config: NO matchea
    assert.equal(q.detectFromResultEvent(evt).matched, false);
    // Con allowlist custom que incluye el nuevo tipo: matchea
    const cfg = { error_types: ['plan_max_reset_required'] };
    assert.equal(q.detectFromResultEvent(evt, cfg).matched, true);
});

test('config: allowlist vacía/inválida usa defaults', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const evt = { type: 'result', is_error: true, error_type: 'usage_limit_error' };
    assert.equal(q.detectFromResultEvent(evt, { error_types: [] }).matched, true);
    assert.equal(q.detectFromResultEvent(evt, { error_types: 'not-an-array' }).matched, true);
    assert.equal(q.detectFromResultEvent(evt, null).matched, true);
});

// -----------------------------------------------------------------------------
// validateFlagShape edge cases
// -----------------------------------------------------------------------------

test('validateFlagShape: rechaza objeto null o no-objeto', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    assert.equal(q.validateFlagShape(null), null);
    assert.equal(q.validateFlagShape('string'), null);
    assert.equal(q.validateFlagShape(42), null);
});

test('validateFlagShape: rechaza fechas no parseables', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const bad = {
        exhausted: true,
        resets_at: 'no-es-fecha',
        detected_at: '2026-05-05T00:00:00Z',
        pattern_matched: 'usage_limit_error',
    };
    assert.equal(q.validateFlagShape(bad), null);
});
