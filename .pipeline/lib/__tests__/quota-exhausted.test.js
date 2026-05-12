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
    for (const skill of ['build', 'tester', 'linter', 'delivery']) {
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
    assert.equal(q.shouldGateSpawn('build', { now }), false);

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

// =============================================================================
// #3077 — Tests multi-provider (CA-4..CA-15, SEC-1..SEC-8)
// =============================================================================

// providerDef sintéticos basados en agent-models.json (no necesitan filesystem).
const PROVIDER_DEF_ANTHROPIC = Object.freeze({
    launcher: 'claude',
    model: 'claude-opus-4-7',
    output_parser: 'anthropic-stream-json',
    quota_error_types: ['usage_limit_error', 'weekly_quota_exhausted', 'snapshot_threshold_90'],
    resets_at_cap_max_days: 7,
});

const PROVIDER_DEF_OPENAI = Object.freeze({
    launcher: 'codex',
    model: 'gpt-5-codex',
    output_parser: 'openai-sse',
    quota_error_types: ['insufficient_quota', 'billing_hard_limit_reached', 'tokens_exhausted'],
    resets_at_cap_max_days: 31,
});

const PROVIDER_DEF_GEMINI = Object.freeze({
    launcher: 'gemini',
    model: 'gemini-2-5-pro',
    output_parser: 'gemini-stream',
    quota_error_types: ['quota_exceeded', 'resource_exhausted'],
    resets_at_cap_max_days: 31,
});

// -----------------------------------------------------------------------------
// CA-4 / SEC-3 — Dispatcher por provider con shape estructural por proveedor
// -----------------------------------------------------------------------------

test('CA-4 #3077 · detectQuotaError(anthropic) matchea stream-json result.is_error', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const evt = { type: 'result', is_error: true, error_type: 'usage_limit_error' };
    const det = q.detectQuotaError(evt, PROVIDER_DEF_ANTHROPIC);
    assert.equal(det.matched, true);
    assert.equal(det.errorType, 'usage_limit_error');
});

test('CA-4 #3077 · detectQuotaError(openai-codex) matchea SSE event=error data.error.type', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    // Shape SSE canónico
    const evt = { event: 'error', data: { error: { type: 'insufficient_quota', message: 'You exceeded your current quota' } } };
    const det = q.detectQuotaError(evt, PROVIDER_DEF_OPENAI);
    assert.equal(det.matched, true);
    assert.equal(det.errorType, 'insufficient_quota');
});

test('CA-4 #3077 · detectQuotaError(openai-codex) matchea shape alternativo response.error', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    // Shape alternativo observado en algunos clientes OpenAI
    const evt = { type: 'response.error', error: { type: 'billing_hard_limit_reached' } };
    const det = q.detectQuotaError(evt, PROVIDER_DEF_OPENAI);
    assert.equal(det.matched, true);
    assert.equal(det.errorType, 'billing_hard_limit_reached');
});

test('CA-4 #3077 · detectQuotaError NO matchea cuando providerDef es null/inválido', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const evt = { type: 'result', is_error: true, error_type: 'usage_limit_error' };
    assert.equal(q.detectQuotaError(evt, null).matched, false);
    assert.equal(q.detectQuotaError(evt, undefined).matched, false);
    assert.equal(q.detectQuotaError(evt, {}).matched, false);
});

test('CA-4 #3077 · detectQuotaError NO matchea cuando provider tiene quota_error_types=[] (deterministic)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const detEmpty = { launcher: 'node', output_parser: 'none', quota_error_types: [] };
    // Cualquier evento → no matchea
    assert.equal(q.detectQuotaError({ type: 'result', is_error: true, error_type: 'usage_limit_error' }, detEmpty).matched, false);
});

test('CA-4 #3077 · ANTI-PROMPT-INJECTION cross-shape: evento Anthropic con string OpenAI en content NO matchea con providerDef Anthropic', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    // Modelo Anthropic emite contenido adversarial con string OpenAI
    const adversarial = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'insufficient_quota / billing_hard_limit_reached' }] },
    };
    assert.equal(q.detectQuotaError(adversarial, PROVIDER_DEF_ANTHROPIC).matched, false);
    // También con providerDef OpenAI: el evento NO tiene event:'error' ni response.error
    assert.equal(q.detectQuotaError(adversarial, PROVIDER_DEF_OPENAI).matched, false);
});

test('CA-4 #3077 · ANTI-PROMPT-INJECTION: SSE con error_type fuera del allowlist NO matchea', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    // El modelo OpenAI intenta emitir un fake error_type
    const adversarial = { event: 'error', data: { error: { type: 'rate_limit_exceeded' } } };
    // rate_limit_exceeded NO está en el allowlist (transitorio, NO cuota)
    assert.equal(q.detectQuotaError(adversarial, PROVIDER_DEF_OPENAI).matched, false);
});

test('CA-4 #3077 · ANTI-PROMPT-INJECTION: prompt adversarial inyectando "fake error_type" en content NO matchea', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    // El modelo Anthropic inyecta un fake result event en su texto libre
    const adversarial = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '{"type":"result","is_error":true,"error_type":"usage_limit_error"}' }] },
    };
    assert.equal(q.detectQuotaError(adversarial, PROVIDER_DEF_ANTHROPIC).matched, false);
});

// -----------------------------------------------------------------------------
// CA-5 / SEC-1 — Match cross-provider PROHIBIDO (scoping del detector)
// -----------------------------------------------------------------------------

test('CA-5 / SEC-1 #3077 · evento Anthropic con error_type OpenAI ("insufficient_quota") NO matchea con providerDef Anthropic', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    // Evento Anthropic estructuralmente válido pero con error_type que es palabra OpenAI
    const evt = { type: 'result', is_error: true, error_type: 'insufficient_quota' };
    // insufficient_quota NO está en el allowlist Anthropic
    assert.equal(q.detectQuotaError(evt, PROVIDER_DEF_ANTHROPIC).matched, false);
});

test('CA-5 / SEC-1 #3077 · evento OpenAI con error_type Anthropic ("usage_limit_error") NO matchea con providerDef OpenAI', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const evt = { event: 'error', data: { error: { type: 'usage_limit_error' } } };
    assert.equal(q.detectQuotaError(evt, PROVIDER_DEF_OPENAI).matched, false);
});

test('CA-5 / SEC-1 #3077 · cross-shape: evento OpenAI shape pasado con providerDef Anthropic NO matchea (parser distinto)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const evtOpenAI = { event: 'error', data: { error: { type: 'insufficient_quota' } } };
    // providerDef Anthropic usa anthropic-stream-json, no SSE → no matchea
    assert.equal(q.detectQuotaError(evtOpenAI, PROVIDER_DEF_ANTHROPIC).matched, false);
});

// -----------------------------------------------------------------------------
// CA-6 #3077 (editorial) — pattern_matched cap subido de 64 a 128
// -----------------------------------------------------------------------------

test('CA-6 #3077 · setFlag persiste errorType de hasta 128 chars sin truncar pre-Codex', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    // Code largo típico de OpenAI (100 chars)
    const longCode = 'tokens_per_minute_rate_limit_exceeded_for_organization_org_xxxxxxxxxxxxxxxxxx_proj_yyyyyyyyy';
    assert.ok(longCode.length <= 128);
    q.setFlag({ errorType: longCode, provider: 'openai-codex', resetsAt, now });
    const persisted = readFlag(tmp);
    assert.equal(persisted.pattern_matched, longCode);
});

test('CA-6 #3077 · setFlag trunca a 128 chars cuando excede', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const huge = 'X'.repeat(500);
    q.setFlag({ errorType: huge, provider: 'openai-codex', resetsAt, now });
    const persisted = readFlag(tmp);
    assert.equal(persisted.pattern_matched.length, 128);
});

// -----------------------------------------------------------------------------
// CA-7 / SEC-5 #3077 — shouldGateSpawn scope por provider
// -----------------------------------------------------------------------------

test('CA-7 / SEC-5 #3077 · flag anthropic NO gatea skill openai-codex', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    q.setFlag({ errorType: 'usage_limit_error', provider: 'anthropic', resetsAt, now });
    // Skill LLM corriendo con provider OpenAI → NO se gatea
    assert.equal(q.shouldGateSpawn('qa', { provider: 'openai-codex', now }), false);
    // Mismo skill corriendo con provider Anthropic → se gatea
    assert.equal(q.shouldGateSpawn('qa', { provider: 'anthropic', now }), true);
});

test('CA-7 / SEC-5 #3077 · flag openai-codex NO gatea skill anthropic', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    q.setFlag({ errorType: 'insufficient_quota', provider: 'openai-codex', resetsAt, now, maxDays: 31 });
    assert.equal(q.shouldGateSpawn('po', { provider: 'anthropic', now }), false);
    assert.equal(q.shouldGateSpawn('po', { provider: 'openai-codex', now }), true);
});

test('CA-7 #3077 · skills determinísticos NO se gatean nunca, sin importar provider', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    q.setFlag({ errorType: 'usage_limit_error', provider: 'anthropic', resetsAt, now });
    for (const skill of ['build', 'tester', 'linter', 'delivery']) {
        assert.equal(q.shouldGateSpawn(skill, { provider: 'anthropic', now }), false);
        assert.equal(q.shouldGateSpawn(skill, { provider: 'openai-codex', now }), false);
        assert.equal(q.shouldGateSpawn(skill, { now }), false);
    }
});

test('CA-7 #3077 · backward-compat: shouldGateSpawn sin provider gatea cualquier flag activo', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    q.setFlag({ errorType: 'usage_limit_error', provider: 'anthropic', resetsAt, now });
    // Sin opts.provider (caller legacy sin migrar) → gatea como antes
    assert.equal(q.shouldGateSpawn('po', { now }), true);
});

// -----------------------------------------------------------------------------
// CA-8 #3077 — clearFlag respeta el scope por provider
// -----------------------------------------------------------------------------

test('CA-8 #3077 · clearFlag con provider distinto al del flag activo NO limpia', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    q.setFlag({ errorType: 'usage_limit_error', provider: 'anthropic', resetsAt, now });
    // Spawn exitoso de openai-codex → NO limpia el flag de anthropic
    assert.equal(q.clearFlag({ provider: 'openai-codex', event: 'success_spawn' }), false);
    // El flag sigue activo
    assert.equal(q.isQuotaExhausted({ now }), true);
});

test('CA-8 #3077 · clearFlag con provider matching limpia normalmente', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    q.setFlag({ errorType: 'usage_limit_error', provider: 'anthropic', resetsAt, now });
    assert.equal(q.clearFlag({ provider: 'anthropic', event: 'success_spawn' }), true);
    assert.equal(q.isQuotaExhausted({ now }), false);
});

test('CA-8 #3077 · clearFlag sin provider (legacy) sigue limpiando (backward-compat)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    q.setFlag({ errorType: 'usage_limit_error', provider: 'anthropic', resetsAt, now });
    assert.equal(q.clearFlag({ event: 'success_spawn' }), true);
});

test('CA-8 #3077 · clearFlag con provider mismatch deja audit log explícito', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    q.setFlag({ errorType: 'usage_limit_error', provider: 'anthropic', resetsAt, now });
    q.clearFlag({ provider: 'openai-codex', event: 'success_spawn' });
    const audits = readAuditLines(tmp);
    assert.ok(
        audits.some(a => a.event === 'clear_skipped_provider_mismatch'),
        'debe haber entry clear_skipped_provider_mismatch en audit log'
    );
});

// -----------------------------------------------------------------------------
// CA-9 / SEC-8 #3077 — snapshot_threshold_90 queda en provider anthropic
// -----------------------------------------------------------------------------

test('CA-9 / SEC-8 #3077 · setFlag con snapshot_threshold_90 + provider anthropic produce flag con provider:anthropic', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 60 * 60 * 1000).toISOString();
    q.setFlag({
        errorType: 'snapshot_threshold_90',
        provider: 'anthropic',
        resetsAt,
        now,
        agent: 'quota-snapshot-integration',
    });
    const persisted = readFlag(tmp);
    assert.equal(persisted.provider, 'anthropic');
    assert.equal(persisted.pattern_matched, 'snapshot_threshold_90');
    // Skill openai-codex NO se gatea aunque el snapshot anthropic disparó
    assert.equal(q.shouldGateSpawn('qa', { provider: 'openai-codex', now }), false);
});

test('CA-9 / SEC-8 #3077 · snapshot_threshold_90 NO está en allowlist openai-codex (separación de provider)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const meta = q.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER;
    assert.ok(meta.anthropic.includes('snapshot_threshold_90'), 'anthropic incluye snapshot_threshold_90');
    assert.ok(!meta['openai-codex'].includes('snapshot_threshold_90'), 'openai-codex NO incluye snapshot_threshold_90');
    assert.ok(!meta.gemini.includes('snapshot_threshold_90'), 'gemini NO incluye snapshot_threshold_90');
});

// -----------------------------------------------------------------------------
// CA-10 / SEC-7 #3077 — Audit log con provider y model
// -----------------------------------------------------------------------------

test('CA-10 / SEC-7 #3077 · setFlag con provider+model produce audit line con ambos campos', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    q.setFlag({
        errorType: 'usage_limit_error',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        resetsAt,
        now,
        agent: 'po',
    });
    const audits = readAuditLines(tmp);
    const flagSet = audits.find(a => a.event === 'flag_set');
    assert.ok(flagSet);
    assert.equal(flagSet.provider, 'anthropic');
    assert.equal(flagSet.model, 'claude-opus-4-7');
});

test('CA-10 / SEC-7 #3077 · audit line con provider openai-codex queda registrada', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
    q.setFlag({
        errorType: 'insufficient_quota',
        provider: 'openai-codex',
        model: 'gpt-5-codex',
        resetsAt,
        maxDays: 31,
        now,
        agent: 'qa',
    });
    const audits = readAuditLines(tmp);
    const flagSet = audits.find(a => a.event === 'flag_set');
    assert.ok(flagSet);
    assert.equal(flagSet.provider, 'openai-codex');
    assert.equal(flagSet.model, 'gpt-5-codex');
});

// -----------------------------------------------------------------------------
// CA-11 / SEC-4 #3077 — raw_excerpt sanitizado vía lib/redact.js
// -----------------------------------------------------------------------------

test('CA-11 / SEC-4 #3077 · raw_excerpt con API key sk-... queda redactada en audit log', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    // Simulamos un raw_excerpt que contiene una API key embebida (caso típico
    // de error SSE de OpenAI con context que filtra la key).
    const dirty = 'Authorization: Bearer sk-deadbeef1234567890abcdefghij and prompt: secret';
    q.appendAudit({
        event: 'flag_set',
        agent: 'commander',
        provider: 'openai-codex',
        error_type: 'insufficient_quota',
        raw_excerpt: dirty,
        flag_set: true,
    });
    const lines = readAuditLines(tmp);
    assert.equal(lines.length, 1);
    // El raw_excerpt no debe contener la palabra "Bearer sk-..." textual.
    // (El módulo redact reemplaza por marker [REDACTED].)
    // Como mínimo, nuestra sanitización debe haber pasado por redact.
    // Verificamos que la sustitución se aplicó comprobando que el output
    // contiene el marker o no contiene la string original íntegra.
    assert.ok(!/sk-deadbeef1234567890abcdefghij/.test(lines[0].raw_excerpt) || /\[REDACTED\]/i.test(lines[0].raw_excerpt),
        'la API key no debe quedar en el audit log en texto plano');
});

test('CA-11 / SEC-4 #3077 · raw_excerpt sigue sin CR/LF/TAB después de redact', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const dirty = '\nlínea1\r\nlínea2\tcol2\nleito@gmail.com';
    q.appendAudit({
        event: 'flag_set',
        agent: 'po',
        provider: 'anthropic',
        error_type: 'usage_limit_error',
        raw_excerpt: dirty,
        flag_set: true,
    });
    const lines = readAuditLines(tmp);
    assert.equal(/[\r\n\t]/.test(lines[0].raw_excerpt), false, 'no debe haber CR/LF/TAB tras sanitizar');
    // El email también queda redactado (cobertura del módulo redact)
    assert.ok(!/leito@gmail\.com/.test(lines[0].raw_excerpt), 'email no debe quedar en texto plano');
});

// -----------------------------------------------------------------------------
// CA-14 #3077 — backward-compat de validateFlagShape (provider opcional)
// -----------------------------------------------------------------------------

test('CA-14 #3077 · flag legacy sin provider se lee como anthropic default', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    // Escribimos un flag pre-#3077 (sin campo provider)
    fs.writeFileSync(path.join(tmp, 'quota-exhausted.json'), JSON.stringify({
        exhausted: true,
        resets_at: resetsAt,
        detected_at: new Date(now).toISOString(),
        pattern_matched: 'usage_limit_error',
    }));
    const r = q.readDefensive({ now });
    assert.equal(r.exhausted, true);
    assert.equal(r.provider, 'anthropic', 'flag legacy debe leerse como anthropic default');
    // El gate también respeta el default
    assert.equal(q.shouldGateSpawn('po', { provider: 'anthropic', now }), true);
    assert.equal(q.shouldGateSpawn('po', { provider: 'openai-codex', now }), false);
});

test('CA-14 #3077 · validateFlagShape acepta flag con provider explícito', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const valid = {
        exhausted: true,
        provider: 'openai-codex',
        model: 'gpt-5-codex',
        resets_at: '2026-05-12T00:00:00Z',
        detected_at: '2026-05-05T00:00:00Z',
        pattern_matched: 'insufficient_quota',
    };
    assert.deepEqual(q.validateFlagShape(valid), valid);
});

test('CA-14 #3077 · validateFlagShape rechaza provider de tipo incorrecto', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const bad = {
        exhausted: true,
        provider: 123, // tipo incorrecto
        resets_at: '2026-05-12T00:00:00Z',
        detected_at: '2026-05-05T00:00:00Z',
        pattern_matched: 'usage_limit_error',
    };
    assert.equal(q.validateFlagShape(bad), null);
});

// -----------------------------------------------------------------------------
// CA-3 #3077 / SEC-6 — capResetsAt con maxDays por provider
// -----------------------------------------------------------------------------

test('CA-3 #3077 / SEC-6 · capResetsAt acepta resets_at a 30 días con maxDays:31 (OpenAI mensual)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const treintaDias = now + 30 * 24 * 60 * 60 * 1000;
    const r = q.capResetsAt(new Date(treintaDias).toISOString(), { now, maxDays: 31 });
    assert.equal(r.source, 'input', 'con maxDays:31, 30 días debe entrar como input válido');
    assert.equal(r.ms, treintaDias);
});

test('CA-3 #3077 / SEC-6 · capResetsAt rechaza resets_at a 30 días con maxDays:7 (Anthropic semanal)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const treintaDias = now + 30 * 24 * 60 * 60 * 1000;
    const r = q.capResetsAt(new Date(treintaDias).toISOString(), { now, maxDays: 7 });
    assert.notEqual(r.source, 'input');
    assert.ok(r.ms <= now + 7 * 24 * 60 * 60 * 1000);
});

// -----------------------------------------------------------------------------
// Meta-allowlist KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER (SEC-2)
// -----------------------------------------------------------------------------

test('SEC-2 #3077 · KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER expone listas inmutables', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const meta = q.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER;
    assert.ok(meta.anthropic);
    assert.ok(meta['openai-codex']);
    // Los arrays deben estar congelados (Object.freeze)
    assert.ok(Object.isFrozen(meta));
    assert.ok(Object.isFrozen(meta.anthropic));
    assert.ok(Object.isFrozen(meta['openai-codex']));
});

test('SEC-2 #3077 · drift detection: meta-allowlist coincide con DEFAULT_ERROR_TYPES legacy (paridad anthropic)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    // Todos los DEFAULT_ERROR_TYPES (legacy Anthropic-only) DEBEN estar en
    // KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER.anthropic — sino el detector legacy
    // y el dispatcher discrepan.
    for (const errType of q.DEFAULT_ERROR_TYPES) {
        assert.ok(q.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER.anthropic.includes(errType),
            `DEFAULT_ERROR_TYPES "${errType}" debe estar en meta-allowlist anthropic`);
    }
});

// -----------------------------------------------------------------------------
// Lifecycle multi-provider (integration-ish): set/gate/clear cross-provider
// -----------------------------------------------------------------------------

test('lifecycle multi-provider · flag anthropic + skill openai pasa + skill anthropic gateado + clear anthropic libera', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const now = Date.parse('2026-05-05T00:00:00Z');
    const resetsAt = new Date(now + 60 * 60 * 1000).toISOString();

    // 1. Set flag de anthropic
    q.setFlag({ errorType: 'usage_limit_error', provider: 'anthropic', resetsAt, now, agent: 'po' });

    // 2. Skill anthropic se gatea
    assert.equal(q.shouldGateSpawn('po', { provider: 'anthropic', now }), true);

    // 3. Skill openai-codex pasa
    assert.equal(q.shouldGateSpawn('qa', { provider: 'openai-codex', now }), false);

    // 4. Skill determinístico siempre pasa
    assert.equal(q.shouldGateSpawn('build', { provider: 'deterministic', now }), false);

    // 5. clearFlag con openai-codex NO limpia
    assert.equal(q.clearFlag({ provider: 'openai-codex' }), false);
    assert.equal(q.isQuotaExhausted({ now }), true);

    // 6. clearFlag con anthropic limpia
    assert.equal(q.clearFlag({ provider: 'anthropic' }), true);
    assert.equal(q.isQuotaExhausted({ now }), false);
});
