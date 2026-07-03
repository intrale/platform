// =============================================================================
// commander-chain-walk-4438.test.js — #4438 CA-1 / CA-2 / CA-3 / CA-4
//
// Regresión del incidente 2026-07-02/03: el Commander devolvía
// recurrentemente "fallaron TODOS los providers" aunque hubiera providers free
// vivos. Causa raíz (confirmada por guru): en el retry post-spawn
// (`pulpo.js → advanceOrGiveUp`), el set de exclusión de la re-resolución NO
// incluía al primario gateado del turno (anthropic). Por el TOCTOU del flag
// global de cuota de anthropic (otro agente lo limpia entre el pick y el retry),
// `resolveCommanderProviderExcluding(['openai-codex'])` devolvía `anthropic`, el
// guard lo descartaba y se declaraba fallo total SIN recorrer
// gemini/cerebras/nvidia.
//
// El fix extrae la decisión pura a `multi-provider.planChainAdvance` y fuerza
// la exclusión del primario gateado del TURNO (no re-lee el flag mutable). Estos
// tests ejercitan esa decisión de forma determinística inyectando el resolver.
//
// Cobertura:
//   CA-1 — escalado a provider free tras spawn_throw de codex con el flag de
//          anthropic limpiado entre pick y retry (TOCTOU).
//   CA-2 — fallo total SOLO tras agotar todos los eslabones; telemetría con la
//          lista completa evaluada.
//   CA-3 — redacción de secrets en el audit y en la alerta al operador.
//   CA-4 — las 4 ramas de decisión de advanceOrGiveUp/planChainAdvance.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const cmp = require('../commander/multi-provider');

function mkTmpPipelineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain4438-'));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return dir;
}
function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Resolver inyectable que modela el TOCTOU: si el set de exclusión NO contiene
// anthropic, devuelve anthropic (el bug: primario "recuperado" por otro agente).
// Si contiene anthropic, recorre la cadena free y devuelve el primer sano que no
// esté excluido.
function toctouResolver(healthyFree) {
    return (exclude) => {
        const ex = new Set(exclude);
        if (!ex.has('anthropic')) {
            // Flag de anthropic limpiado entre pick y retry → el resolver lo
            // devuelve como primario libre (firma exacta del bug #4438).
            return { provider: 'anthropic', gated: false, source: 'agent-models', skipReasons: [] };
        }
        for (const p of healthyFree) {
            if (!ex.has(p)) {
                return { provider: p, gated: false, source: 'fallback', skipReasons: [] };
            }
        }
        return {
            provider: null,
            gated: true,
            source: 'all-gated',
            skipReasons: [
                { provider: 'openai-codex', reason: 'spawn_throw', details: 'launcher murió al arrancar' },
                { provider: 'gemini-google', reason: 'quota_exhausted', details: 'rate limited' },
                { provider: 'cerebras', reason: 'no_credentials', details: 'CEREBRAS_API_KEY ausente' },
            ],
        };
    };
}

// -----------------------------------------------------------------------------
// CA-1 — escalado tras spawn_throw de codex con flag de anthropic limpiado
//        entre pick y retry (TOCTOU). Debe llegar a gemini, NO al fallo total.
// -----------------------------------------------------------------------------
test('#4438 CA-1 — anthropic gateado + codex spawn_throw + TOCTOU → escala a gemini (no fallo total)', () => {
    const plan = cmp.planChainAdvance({
        failedProvider: 'openai-codex',
        triedNonAnthropic: new Set(['openai-codex']),
        primaryProvider: 'anthropic',
        resolveExcluding: toctouResolver(['gemini-google', 'cerebras', 'nvidia-nim']),
    });
    assert.equal(plan.action, 'retry', 'debe escalar, no rendirse');
    assert.equal(plan.next.provider, 'gemini-google', 'debe recorrer la cadena free hasta el primer sano');
    // El set de exclusión DEBE incluir anthropic (el fix) además de codex.
    assert.ok(plan.exclude.includes('anthropic'), 'exclude debe forzar anthropic (turno gateado)');
    assert.ok(plan.exclude.includes('openai-codex'), 'exclude conserva el provider ya intentado');
});

// -----------------------------------------------------------------------------
// CA-4 (rama demostrativa) — SIN el fix (exclusión sólo de codex) el resolver
// devolvería anthropic. Comprobamos que el resolver inyectado modela ese bug,
// para dejar explícita la diferencia que produce el fix.
// -----------------------------------------------------------------------------
test('#4438 CA-4 — el resolver devuelve anthropic si anthropic NO se excluye (firma del bug)', () => {
    const resolver = toctouResolver(['gemini-google']);
    assert.equal(resolver(['openai-codex']).provider, 'anthropic', 'reproduce el bug del TOCTOU');
    assert.equal(resolver(['anthropic', 'openai-codex']).provider, 'gemini-google', 'con anthropic excluido, camina la cadena');
});

// -----------------------------------------------------------------------------
// CA-2 — fallo total SOLO cuando toda la cadena resoluble está agotada. El plan
// devuelve 'giveup' y propaga chainEvaluated (skipReasons completos).
// -----------------------------------------------------------------------------
test('#4438 CA-2 — toda la cadena agotada → giveup con chainEvaluated completo', () => {
    const plan = cmp.planChainAdvance({
        failedProvider: 'openai-codex',
        triedNonAnthropic: new Set(['openai-codex']),
        primaryProvider: 'anthropic',
        // healthyFree vacío → el resolver cae al branch all-gated con skipReasons.
        resolveExcluding: toctouResolver([]),
    });
    assert.equal(plan.action, 'giveup', 'sin providers sanos, se rinde');
    assert.ok(Array.isArray(plan.chainEvaluated) && plan.chainEvaluated.length >= 3,
        'chainEvaluated debe traer TODOS los eslabones evaluados, no sólo el spawneado');
    const providers = plan.chainEvaluated.map((s) => s.provider);
    assert.ok(providers.includes('gemini-google') && providers.includes('cerebras'),
        'la telemetría no debe ocultar gemini/cerebras');
});

// -----------------------------------------------------------------------------
// CA-4 (rama: primario "recuperado" devuelto pese a la exclusión) — defensa en
// profundidad: si el resolver devolviera anthropic igualmente, el guard lo
// descarta y se rinde (no reintenta el primario que el turno declaró gateado).
// -----------------------------------------------------------------------------
test('#4438 CA-4 — resolver devuelve anthropic pese a exclusión → guard lo descarta → giveup', () => {
    const plan = cmp.planChainAdvance({
        failedProvider: 'openai-codex',
        triedNonAnthropic: new Set(['openai-codex']),
        primaryProvider: 'anthropic',
        // Resolver "roto" que ignora la exclusión y siempre devuelve anthropic.
        resolveExcluding: () => ({ provider: 'anthropic', gated: false, skipReasons: [] }),
    });
    assert.equal(plan.action, 'giveup', 'no reintenta anthropic (primario gateado del turno)');
});

// -----------------------------------------------------------------------------
// CA-4 (rama: excepción en la re-resolución) — si el resolver lanza, se captura,
// se expone resolveError y se rinde limpio (nunca throw hacia arriba).
// -----------------------------------------------------------------------------
test('#4438 CA-4 — excepción del resolver → giveup con resolveError, sin throw', () => {
    const plan = cmp.planChainAdvance({
        failedProvider: 'openai-codex',
        triedNonAnthropic: ['openai-codex'],
        primaryProvider: 'anthropic',
        resolveExcluding: () => { throw new Error('resolver boom'); },
    });
    assert.equal(plan.action, 'giveup');
    assert.ok(plan.resolveError instanceof Error);
    assert.match(plan.resolveError.message, /boom/);
    assert.deepEqual(plan.chainEvaluated, [], 'sin next, chainEvaluated vacío');
});

// -----------------------------------------------------------------------------
// CA-4 (rama: escalado directo sin TOCTOU) — sólo el primario gateado, codex ya
// intentado, gemini sano → escala a gemini.
// -----------------------------------------------------------------------------
test('#4438 CA-4 — escalado directo: gemini sano en la cadena → retry con gemini', () => {
    const plan = cmp.planChainAdvance({
        failedProvider: 'openai-codex',
        triedNonAnthropic: new Set(['openai-codex']),
        primaryProvider: 'anthropic',
        resolveExcluding: (exclude) => {
            const ex = new Set(exclude);
            return ex.has('gemini-google')
                ? { provider: null, gated: true, skipReasons: [] }
                : { provider: 'gemini-google', gated: false, skipReasons: [] };
        },
    });
    assert.equal(plan.action, 'retry');
    assert.equal(plan.next.provider, 'gemini-google');
});

// -----------------------------------------------------------------------------
// CA-3 — redactSkipReasons redacta el `details` de cada eslabón (puede traer
// error/stack de provider con API keys) preservando provider/reason.
// -----------------------------------------------------------------------------
test('#4438 CA-3 — redactSkipReasons redacta secrets en details, preserva provider/reason', () => {
    const raw = [
        { provider: 'openai-codex', reason: 'spawn_throw', details: 'Authorization: Bearer sk-ant-api03-abcdef0123456789abcdef0123456789 falló' },
        { provider: 'gemini-google', reason: 'quota_exhausted', details: 'rate limited' },
    ];
    const red = cmp.redactSkipReasons(raw);
    assert.equal(red.length, 2);
    assert.equal(red[0].provider, 'openai-codex');
    assert.equal(red[0].reason, 'spawn_throw');
    assert.ok(!/sk-ant-api03-abcdef/.test(red[0].details), 'la API key NO debe viajar en claro');
    assert.match(red[0].details, /REDACTED/, 'el secreto debe quedar redactado');
    assert.equal(red[1].details, 'rate limited', 'texto benigno se preserva');
});

test('#4438 CA-3 — redactSkipReasons sobre input vacío/no-array devuelve []', () => {
    assert.deepEqual(cmp.redactSkipReasons(undefined), []);
    assert.deepEqual(cmp.redactSkipReasons(null), []);
    assert.deepEqual(cmp.redactSkipReasons([]), []);
});

// -----------------------------------------------------------------------------
// CA-3 — auditCommanderRequest persiste `chain_evaluated` REDACTADO en el JSONL.
// -----------------------------------------------------------------------------
test('#4438 CA-3 — fallback_chain_exhausted audita chain_evaluated redactado (sin secreto en claro)', () => {
    const dir = mkTmpPipelineDir();
    try {
        const ok = cmp.auditCommanderRequest({
            pipelineDir: dir,
            event: 'fallback_chain_exhausted',
            providerIntended: 'anthropic',
            providerEffective: 'openai-codex',
            chainTried: ['openai-codex'],
            chainEvaluated: [
                { provider: 'openai-codex', reason: 'spawn_throw', details: 'key sk-ant-api03-DEADBEEF0123456789abcdef0123456789 en el stack' },
                { provider: 'gemini-google', reason: 'quota_exhausted', details: 'rate limited' },
                { provider: 'cerebras', reason: 'no_credentials', details: 'sin API key' },
            ],
            prompt: 'hola',
            latencyMs: 42,
            errorCode: 'spawn_throw',
        });
        assert.equal(ok, true);
        const files = fs.readdirSync(path.join(dir, 'logs')).filter(f => f.startsWith('commander-dispatch-'));
        const content = fs.readFileSync(path.join(dir, 'logs', files[0]), 'utf8').trim();
        const entry = JSON.parse(content.split('\n').pop());
        assert.ok(Array.isArray(entry.chain_evaluated), 'chain_evaluated debe persistirse como array');
        assert.equal(entry.chain_evaluated.length, 3, 'TODOS los eslabones evaluados quedan registrados');
        const providers = entry.chain_evaluated.map((s) => s.provider);
        assert.deepEqual(providers, ['openai-codex', 'gemini-google', 'cerebras']);
        // El secreto NO debe aparecer en NINGÚN lugar del JSONL persistido.
        assert.ok(!/sk-ant-api03-DEADBEEF/.test(content), 'la API key NO debe persistirse en claro');
    } finally { cleanup(dir); }
});

test('#4438 CA-3 — auditCommanderRequest sin chainEvaluated deja chain_evaluated null (back-compat)', () => {
    const dir = mkTmpPipelineDir();
    try {
        cmp.auditCommanderRequest({
            pipelineDir: dir,
            event: 'dispatch',
            providerIntended: 'anthropic',
            providerEffective: 'anthropic',
            prompt: 'x',
            latencyMs: 10,
        });
        const files = fs.readdirSync(path.join(dir, 'logs')).filter(f => f.startsWith('commander-dispatch-'));
        const entry = JSON.parse(fs.readFileSync(path.join(dir, 'logs', files[0]), 'utf8').trim().split('\n').pop());
        assert.equal(entry.chain_evaluated, null, 'shape canónico preservado cuando no se provee');
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// CA-3 (#4438) — el requisito durable es que NINGÚN secreto llegue al chat.
// #4440 SUPERSEDE la parte de UX de este CA: el mensaje al operador ya NO
// enumera providers/modelos/motivos (CA-2 de #4440: "ningún mensaje visible
// expone nombres de providers, modelos de fallback, timers ni conteo de
// reintentos"). El detalle por eslabón sigue viajando redactado al audit
// server-side (cubierto por los tests de auditCommanderRequest de arriba).
// Estos tests, por tanto, verifican la NO-fuga de jerga en el copy visible.
// -----------------------------------------------------------------------------
test('#4438/#4440 — cannedAllProvidersFailedResponse nunca filtra secretos ni nombres de provider al chat', () => {
    const msg = cmp.cannedAllProvidersFailedResponse({
        chainTried: ['openai-codex'],
        verifiedAllFailed: true,
        chainEvaluated: [
            { provider: 'openai-codex', reason: 'spawn_throw', details: 'token sk-ant-api03-SECRET0123456789abcdef0123456789 filtrado' },
            { provider: 'gemini-google', reason: 'quota_exhausted', details: 'sin cuota' },
        ],
    });
    assert.ok(!/sk-ant-api03-SECRET/.test(msg), 'el mensaje al operador NO debe contener la API key');
    // #4440 CA-2 — el copy visible ya NO enumera providers/modelos/motivos.
    assert.ok(!/openai-codex/.test(msg), 'no expone el provider intentado');
    assert.ok(!/gemini-google/.test(msg), 'no expone el resto de la cadena');
    assert.ok(!/quota_exhausted|spawn_throw/.test(msg), 'no expone motivos técnicos por eslabón');
    // Los comandos determinísticos siguen anunciados (accionabilidad UX).
    assert.match(msg, /\/status/);
});

test('#4438/#4440 — cannedAllProvidersFailedResponse sin chainEvaluated no interpola jerga de reintento', () => {
    const msg = cmp.cannedAllProvidersFailedResponse({ chainTried: ['openai-codex'] });
    // #4440 CA-2 — el texto "Intenté con: <provider>" fue eliminado del copy.
    assert.ok(!/Intenté con/.test(msg), 'no menciona la cadena intentada');
    assert.ok(!/openai-codex/.test(msg), 'no menciona nombres de provider');
    assert.ok(!/Detalle de la cadena/.test(msg), 'no agrega bloque de detalle');
    assert.match(msg, /\/status/, 'mantiene la acción determinística para el operador');
});
