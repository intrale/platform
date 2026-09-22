// =============================================================================
// dispatch-quota-balance-6561.test.js — balanceo de carga entre proveedores por
// saldo de cuota y ritmo de consumo (#6561).
//
// Cubre los 5 criterios de aceptación del issue + los dos escenarios Gherkin:
//   CA-1  con dos proveedores hábiles, el ruteo elige el de mayor saldo relativo.
//   CA-2  ningún proveedor se agota mientras otro hábil conserva saldo
//         significativo (umbral `delta_min_pct` anti-flapping; reserva de fin
//         de período fuera de fases críticas).
//   CA-3  las restricciones vigentes (capacidad por fase = cadena declarada,
//         horario, cuota agotada, orden por agente como desempate) tienen
//         precedencia sobre el saldo.
//   CA-4  cada decisión deja registrado el motivo (audit `balance_by_quota`,
//         skipReasons, `balance` en el resultado, línea `Balanceo:` del log).
//   CA-5  sin cálculo de saldo (sin config, sin ledger, dato viejo, error del
//         lector) el ruteo degrada al comportamiento actual sin frenar.
//
// El balance se inyecta (`quotaBalanceReader`) en la mayoría de los casos; los
// tests de integración real escriben un ledger temporal y usan el lector
// default (`readQuotaBalanceForDispatch`) contra `computeQuotaBalance` (#6560).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('../lib/__tests__/isolate-provider-disabled.helper');
const {
    resolveSpawnWithFallback,
    formatProviderResolutionLog,
    SKIP_REASON_CODES,
    SKIP_REASON_LABELS,
} = require('../lib/agent-launcher/dispatch-with-fallback');
const balancer = require('../lib/agent-launcher/quota-balancer');

const NOW = Date.parse('2026-09-21T15:00:00.000Z');
const ISSUE = 6561;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function fakeAuditLog() {
    const entries = [];
    return {
        appendChained: ({ entry }) => { entries.push(entry); return { hash_self: 'h', hash_prev: 'p', line: '' }; },
        verifyChain: () => ({ ok: true }),
        readAll: () => entries,
        entries,
    };
}
function quotaModule(gated = []) {
    return {
        shouldGateSpawn: (skill, { provider } = {}) => gated.includes(provider),
        sanitizeRawExcerpt: (s) => String(s || ''),
        appendAudit: () => {},
    };
}
function models(extraSkills = {}) {
    return {
        defaults: { model: 'claude-x' },
        default_provider: 'anthropic',
        providers: {
            anthropic: { launcher: 'claude', model: 'claude-x' },
            'openai-codex': { launcher: 'codex', model: 'gpt-x', credentials_env: ['OPENAI_API_KEY'] },
            antigravity: { launcher: 'agy', model: 'gem-x' },
        },
        skills: {
            guru: { provider: 'anthropic', fallbacks: ['openai-codex'] },
            'codex-first': { provider: 'openai-codex', fallbacks: ['anthropic'] },
            'triple': { provider: 'anthropic', fallbacks: ['openai-codex', 'antigravity'] },
            'lone-wolf': { provider: 'anthropic' },
            ...extraSkills,
        },
    };
}
function mkPipelineDir(modelsObj = models()) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-6561-'));
    fs.writeFileSync(path.join(dir, 'agent-models.json'), JSON.stringify(modelsObj, null, 2));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    return dir;
}
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } }

function primaryResolver(skill, opts) {
    const m = JSON.parse(fs.readFileSync(path.join(opts.pipelineDir, 'agent-models.json'), 'utf8'));
    const provider = m.skills[skill].provider;
    return { provider, model: m.providers[provider].model, handler: { name: `${provider}-fake` }, source: 'agent-models' };
}
const handlerResolver = (name) => {
    if (!['anthropic', 'openai-codex', 'antigravity'].includes(name)) throw new Error(`${name} inválido`);
    return { name: `${name}-fake` };
};
const ENV = { OPENAI_API_KEY: 'k' };

/** Balance inyectado: mapa provider → { saldo, confidence?, ritmo?, agota_at? } */
function balanceReader(map) {
    const fn = () => {
        const out = {};
        for (const [p, v] of Object.entries(map)) {
            const saldo = typeof v === 'number' ? v : v.saldo;
            const conf = typeof v === 'number' ? 'fresh' : (v.confidence || 'fresh');
            out[p] = {
                techo: 100, saldo_pts: saldo, consumo_pct: 100 - saldo,
                ritmo_pts_por_hora: typeof v === 'object' && v.ritmo != null ? v.ritmo : 2.5,
                agota_at: typeof v === 'object' && v.agota_at ? v.agota_at : null,
                estado: conf === 'fresh' ? 'alcanza' : conf === 'stale' ? 'desactualizado' : 'sin_datos',
                confidence: conf,
            };
        }
        fn.calls += 1;
        return out;
    };
    fn.calls = 0;
    return fn;
}

const CONFIG = {
    multi_provider: {
        balanceo: { delta_min_pct: 15, margen_reserva_pct: 20, fases_criticas: ['verificacion', 'aprobacion', 'delivery'] },
    },
};

function run(dir, extra = {}) {
    return resolveSpawnWithFallback({
        skill: 'guru', issue: ISSUE, pipelineDir: dir, fase: 'dev',
        config: CONFIG, quotaModule: quotaModule(),
        primaryResolver, providerHandlerResolver: handlerResolver,
        auditLog: fakeAuditLog(), notify: () => {}, now: NOW, processEnv: ENV,
        pacingModule: { getPacingState: () => 'green' },
        disabledModule: { isProviderDisabled: () => false, getDisabledEntry: () => null },
        scheduleModule: { isProviderActiveNow: () => true },
        softGateModule: { isPreventivelyDegraded: () => false },
        healthReader: () => null,
        recordEpisode: false,
        ...extra,
    });
}

// =============================================================================
// Gherkin 1 / CA-1 — reparto entre dos proveedores hábiles
// =============================================================================
test('CA-1 · Codex 10 % / Claude 70 %, ambos hábiles ⇒ elige Claude y registra los saldos', () => {
    const dir = mkPipelineDir();
    try {
        const audit = fakeAuditLog();
        const r = run(dir, {
            skill: 'codex-first', auditLog: audit,
            quotaBalanceReader: balanceReader({ 'openai-codex': 10, anthropic: 70 }),
        });
        assert.equal(r.gated, false);
        assert.equal(r.provider, 'anthropic', 'eligió el de mayor saldo relativo');
        assert.equal(r.source, 'fallback');
        assert.equal(r.balance.regla, 'saldo');
        assert.equal(r.balance.elegido, 'anthropic');
        // La decisión queda registrada con el saldo relativo de cada uno.
        const ev = audit.entries.find((e) => e.event === 'balance_by_quota');
        assert.ok(ev, 'audit balance_by_quota emitido');
        const saldos = Object.fromEntries(ev.candidatos.map((c) => [c.provider, c.saldo_relativo]));
        assert.deepEqual(saldos, { 'openai-codex': 10, anthropic: 70 });
        assert.equal(ev.regla, 'saldo');
        assert.equal(ev.elegido, 'anthropic');
        assert.equal(ev.primary_deferred_by_balance, true);
        const skip = r.skipReasons.find((s) => s.provider === 'openai-codex');
        assert.equal(skip.reason, SKIP_REASON_CODES.QUOTA_BALANCE_PREFER_OTHER);
        assert.match(skip.details, /saldo 10 %/);
        assert.match(skip.details, /ritmo 2\.5 pts\/h/);
    } finally { cleanup(dir); }
});

test('CA-1 · el primario con mayor saldo se confirma en una sola línea (sufijo de balanceo)', () => {
    const dir = mkPipelineDir();
    try {
        const r = run(dir, { quotaBalanceReader: balanceReader({ anthropic: 70, 'openai-codex': 10 }) });
        assert.equal(r.provider, 'anthropic');
        assert.equal(r.fallbackUsed, null);
        assert.equal(r.skipReasons.length, 0);
        assert.equal(r.balance.regla, 'orden');
        const line = formatProviderResolutionLog(r, { skill: 'guru', issue: ISSUE });
        assert.equal(line.split('\n').length, 1, 'happy path sigue siendo una línea');
        assert.match(line, /\(balanceo: anthropic 70 % · openai-codex 10 %, mayor saldo → orden declarado\)/);
    } finally { cleanup(dir); }
});

// =============================================================================
// CA-2 — umbral anti-flapping + reserva de fin de período
// =============================================================================
test('CA-2 · delta < umbral ⇒ gana el orden declarado (anti-flapping)', () => {
    const dir = mkPipelineDir();
    try {
        const r = run(dir, { quotaBalanceReader: balanceReader({ anthropic: 40, 'openai-codex': 50 }) });
        assert.equal(r.provider, 'anthropic');
        assert.equal(r.balance.regla, 'orden');
        assert.match(r.balance.resumen, /delta < 15 → orden declarado/);
        const line = formatProviderResolutionLog(r, { skill: 'guru', issue: ISSUE });
        assert.match(line, /delta < 15 → orden declarado/);
    } finally { cleanup(dir); }
});

test('CA-2 · delta exactamente igual al umbral ⇒ reordena (≥)', () => {
    const dir = mkPipelineDir();
    try {
        const r = run(dir, { quotaBalanceReader: balanceReader({ anthropic: 40, 'openai-codex': 55 }) });
        assert.equal(r.provider, 'openai-codex');
        assert.equal(r.balance.regla, 'saldo');
    } finally { cleanup(dir); }
});

test('CA-2 · umbral configurable: con delta_min_pct 5 el mismo delta 10 sí reordena', () => {
    const dir = mkPipelineDir();
    try {
        const cfg = { multi_provider: { balanceo: { delta_min_pct: 5 } } };
        const r = run(dir, { config: cfg, quotaBalanceReader: balanceReader({ anthropic: 40, 'openai-codex': 50 }) });
        assert.equal(r.provider, 'openai-codex');
        assert.equal(r.balance.umbral, 5);
    } finally { cleanup(dir); }
});

test('CA-2 · reserva: primario bajo el margen en fase NO crítica ⇒ prefiere el otro (regla reserva)', () => {
    const dir = mkPipelineDir();
    try {
        const r = run(dir, { fase: 'dev', quotaBalanceReader: balanceReader({ anthropic: 12, 'openai-codex': 22 }) });
        assert.equal(r.provider, 'openai-codex');
        assert.equal(r.balance.regla, 'reserva');
        const skip = r.skipReasons.find((s) => s.provider === 'anthropic');
        assert.equal(skip.reason, SKIP_REASON_CODES.QUOTA_RESERVE_CRITICAL);
        assert.equal(skip.details, 'fase=dev · saldo=12 % · margen=20 %');
        const block = formatProviderResolutionLog(r, { skill: 'guru', issue: ISSUE });
        assert.match(block, /reservado para fases críticas/);
        assert.match(block, /Balanceo: regla=reserva/);
    } finally { cleanup(dir); }
});

test('CA-2 · reserva: en fase CRÍTICA el margen no aplica ⇒ orden declarado (delta < umbral)', () => {
    const dir = mkPipelineDir();
    try {
        const r = run(dir, { fase: 'verificacion', quotaBalanceReader: balanceReader({ anthropic: 12, 'openai-codex': 22 }) });
        assert.equal(r.provider, 'anthropic');
        assert.equal(r.balance.regla, 'orden');
        assert.equal(r.balance.fase, 'verificacion');
    } finally { cleanup(dir); }
});

test('CA-2 · reserva nunca es veto: si TODOS están bajo el margen se compara igual', () => {
    const dir = mkPipelineDir();
    try {
        const r = run(dir, { fase: 'dev', quotaBalanceReader: balanceReader({ anthropic: 5, 'openai-codex': 18 }) });
        assert.equal(r.provider, 'anthropic', 'delta 13 < 15 ⇒ orden declarado; nadie queda vetado');
        assert.equal(r.balance.regla, 'orden');
        assert.ok(r.balance.candidatos.every((c) => c.reservado === false));
    } finally { cleanup(dir); }
});

test('CA-2 · reserva sin fallback resoluble ⇒ se usa el primario reservado igual (soft)', () => {
    const dir = mkPipelineDir();
    try {
        const r = run(dir, {
            fase: 'dev',
            quotaBalanceReader: balanceReader({ anthropic: 12, 'openai-codex': 60 }),
            scheduleModule: { isProviderActiveNow: (p) => p !== 'openai-codex' },
        });
        assert.equal(r.gated, false);
        assert.equal(r.provider, 'anthropic');
        assert.equal(r.balanceCede, true);
        assert.equal(r.softGatedPrimaryUsed, true);
    } finally { cleanup(dir); }
});

// =============================================================================
// Gherkin 2 / CA-3 — el saldo no puede saltear una restricción
// =============================================================================
test('CA-3 · el de mayor saldo NO está en la cadena del skill (capacidad) ⇒ ni se considera', () => {
    const dir = mkPipelineDir();
    try {
        // antigravity con 95 % pero `guru` sólo declara anthropic → openai-codex.
        const r = run(dir, { quotaBalanceReader: balanceReader({ anthropic: 40, 'openai-codex': 30, antigravity: 95 }) });
        assert.equal(r.provider, 'anthropic');
        assert.deepEqual(r.balance.candidatos.map((c) => c.provider), ['anthropic', 'openai-codex']);
        assert.deepEqual(r.chainTried, ['anthropic']);
    } finally { cleanup(dir); }
});

test('CA-3 · el de mayor saldo está fuera de horario ⇒ se elige otro hábil y se registra la restricción', () => {
    const dir = mkPipelineDir();
    try {
        const audit = fakeAuditLog();
        const r = run(dir, {
            auditLog: audit,
            quotaBalanceReader: balanceReader({ anthropic: 20, 'openai-codex': 90 }),
            scheduleModule: { isProviderActiveNow: (p) => p !== 'openai-codex' },
        });
        assert.equal(r.gated, false);
        assert.equal(r.provider, 'anthropic');
        const reasons = r.skipReasons.map((s) => `${s.provider}:${s.reason}`);
        assert.ok(reasons.includes('anthropic:quota_balance_prefer_other'), reasons.join(','));
        assert.ok(reasons.includes('openai-codex:provider_inactive_by_schedule'), reasons.join(','));
        assert.ok(audit.entries.some((e) => e.event === 'fallback_provider_inactive_by_schedule'));
        const block = formatProviderResolutionLog(r, { skill: 'guru', issue: ISSUE });
        assert.match(block, /openai-codex \(DESCARTADO: provider_inactive_by_schedule/);
        assert.match(block, /✓ anthropic \(ELEGIDO — primary/);
        assert.match(block, /Balanceo: regla=saldo .*restricciones respetadas: hard-gates ✓/);
    } finally { cleanup(dir); }
});

test('CA-3 · el de mayor saldo tiene la cuota agotada (flag) ⇒ se elige el otro', () => {
    const dir = mkPipelineDir();
    try {
        const r = run(dir, {
            quotaModule: quotaModule(['openai-codex']),
            quotaBalanceReader: balanceReader({ anthropic: 20, 'openai-codex': 90 }),
        });
        assert.equal(r.provider, 'anthropic');
        assert.ok(r.skipReasons.some((s) => s.provider === 'openai-codex' && s.reason === 'quota_exhausted'));
    } finally { cleanup(dir); }
});

test('CA-3 · primario hard-gated: el recorrido de fallbacks sigue el orden del plan', () => {
    const dir = mkPipelineDir();
    try {
        const r = run(dir, {
            skill: 'triple',
            quotaModule: quotaModule(['anthropic']),
            quotaBalanceReader: balanceReader({ anthropic: 50, 'openai-codex': 20, antigravity: 80 }),
        });
        assert.equal(r.provider, 'antigravity', 'fallback[1] rankea sobre fallback[0]');
        assert.equal(r.fallbackUsed.index, 1, 'el índice declarado se conserva en el audit');
        assert.deepEqual(r.chainTried, ['anthropic', 'antigravity']);
    } finally { cleanup(dir); }
});

test('CA-3 · el primario rankea sobre los fallbacks restantes ⇒ se corta y se usa el primario', () => {
    const dir = mkPipelineDir();
    try {
        // Plan: codex (80) > anthropic (50) > antigravity (30). Codex fuera de
        // horario ⇒ el siguiente (antigravity) rankea peor que el primario.
        const r = run(dir, {
            skill: 'triple',
            quotaBalanceReader: balanceReader({ anthropic: 50, 'openai-codex': 80, antigravity: 30 }),
            scheduleModule: { isProviderActiveNow: (p) => p !== 'openai-codex' },
        });
        assert.equal(r.provider, 'anthropic');
        assert.equal(r.balanceCede, true);
        assert.deepEqual(r.chainTried, ['anthropic', 'openai-codex'], 'antigravity ni se evaluó');
    } finally { cleanup(dir); }
});

test('CA-3 · soft-gate preventivo (#4282) tiene precedencia: el primario no vuelve aunque rankee mejor', () => {
    const dir = mkPipelineDir();
    try {
        const r = run(dir, {
            softGateModule: { isPreventivelyDegraded: (p) => p === 'anthropic' },
            quotaBalanceReader: balanceReader({ anthropic: 90, 'openai-codex': 20 }),
        });
        assert.equal(r.provider, 'openai-codex');
        assert.ok(r.skipReasons.some((s) => s.reason === 'preventive_soft_gate'));
        assert.ok(!r.skipReasons.some((s) => s.reason === 'quota_balance_prefer_other'));
    } finally { cleanup(dir); }
});

test('CA-3 · pacing amarillo (#4289) no se pisa con el balanceo', () => {
    const dir = mkPipelineDir();
    try {
        const r = run(dir, {
            pacingModule: { getPacingState: (p) => (p === 'anthropic' ? 'yellow' : 'green') },
            quotaBalanceReader: balanceReader({ anthropic: 90, 'openai-codex': 20 }),
        });
        assert.equal(r.provider, 'openai-codex');
        assert.ok(r.skipReasons.some((s) => s.reason === 'pacing_budget_yellow'));
    } finally { cleanup(dir); }
});

test('CA-3 · skill determinístico y skill sin fallbacks quedan fuera del balanceo', () => {
    const dir = mkPipelineDir();
    try {
        const r = run(dir, { skill: 'lone-wolf', quotaBalanceReader: balanceReader({ anthropic: 5, 'openai-codex': 90 }) });
        assert.equal(r.provider, 'anthropic');
        assert.equal(r.balance.regla, 'orden');
        assert.equal(r.balance.degradado_motivo, 'un_solo_candidato');
    } finally { cleanup(dir); }
});

// =============================================================================
// CA-4 — trazabilidad
// =============================================================================
test('CA-4 · audit balance_by_quota: un evento por decisión, candidatos completos y sin material sensible', () => {
    const dir = mkPipelineDir();
    try {
        const audit = fakeAuditLog();
        const r = run(dir, {
            auditLog: audit, fase: 'dev',
            quotaBalanceReader: balanceReader({ anthropic: { saldo: 30, ritmo: 4.2, agota_at: '2026-09-22T01:00:00.000Z' }, 'openai-codex': 75 }),
            processEnv: { OPENAI_API_KEY: 'sk-super-secret-value' },
        });
        assert.equal(r.provider, 'openai-codex');
        const evs = audit.entries.filter((e) => e.event === 'balance_by_quota');
        assert.equal(evs.length, 1);
        const ev = evs[0];
        assert.equal(ev.skill, 'guru');
        assert.equal(ev.issue, ISSUE);
        assert.equal(ev.fase, 'dev');
        assert.equal(ev.umbral, 15);
        assert.deepEqual(ev.orden, ['openai-codex', 'anthropic']);
        assert.equal(ev.candidatos.length, 2);
        for (const c of ev.candidatos) {
            assert.deepEqual(Object.keys(c).sort(), ['agota_at', 'confidence', 'estado', 'motivo', 'orden_declarado', 'participa', 'provider', 'reservado', 'ritmo_pts_por_hora', 'saldo_relativo']);
        }
        const anth = ev.candidatos.find((c) => c.provider === 'anthropic');
        assert.equal(anth.ritmo_pts_por_hora, 4.2);
        assert.equal(anth.agota_at, '2026-09-22T01:00:00.000Z');
        assert.match(anth.motivo, /saldo relativo menor \(30 % vs 75 %\)/);
        assert.ok(!JSON.stringify(audit.entries).includes('sk-super-secret-value'));
        assert.ok(!JSON.stringify(r).includes('sk-super-secret-value'));
    } finally { cleanup(dir); }
});

test('CA-4 · las etiquetas nuevas existen en SKIP_REASON_LABELS (voz del operador)', () => {
    assert.equal(SKIP_REASON_LABELS.quota_balance_prefer_other, 'saldo relativo menor (balanceo)');
    assert.equal(SKIP_REASON_LABELS.quota_reserve_critical, 'reservado para fases críticas');
});

test('CA-4 · el resultado del fallback lleva `balance` y el bloque termina con la regla', () => {
    const dir = mkPipelineDir();
    try {
        const r = run(dir, { quotaBalanceReader: balanceReader({ anthropic: 12, 'openai-codex': 71 }) });
        assert.equal(r.provider, 'openai-codex');
        const block = formatProviderResolutionLog(r, { skill: 'guru', issue: ISSUE });
        const lines = block.split('\n');
        assert.match(lines[0], /🔄 guru:#6561 — Resolución de provider:/);
        assert.match(lines[lines.length - 1], /^  Balanceo: regla=saldo \(anthropic 12 % · openai-codex 71 %, delta 59 ≥ umbral 15 → openai-codex\) · restricciones respetadas: hard-gates ✓ capacidad ✓ horario ✓ orden=desempate$/);
    } finally { cleanup(dir); }
});

// =============================================================================
// CA-5 — degradación al comportamiento actual
// =============================================================================
test('CA-5 · sin `config` el dispatcher no consulta el balance: comportamiento previo intacto', () => {
    const dir = mkPipelineDir();
    try {
        const reader = balanceReader({ anthropic: 5, 'openai-codex': 95 });
        const r = run(dir, { config: undefined, quotaBalanceReader: reader });
        assert.equal(r.provider, 'anthropic');
        assert.equal(r.balance, null);
        assert.equal(reader.calls, 0, 'el lector ni se invocó');
        assert.equal(r.skipReasons.length, 0);
    } finally { cleanup(dir); }
});

test('CA-5 · primer arranque: sin ledger en disco ⇒ regla degradado (sin_datos), orden declarado, log explícito', () => {
    const dir = mkPipelineDir();
    balancer._resetCacheForTests();
    try {
        const logs = [];
        const cfg = {
            multi_provider: {
                quota: {
                    anthropic: { plan: 'Claude Max', periodo: 'semanal', techo: 100, unidad: 'porcentaje', reposicion: 'dom 21:00' },
                    'openai-codex': { plan: 'ChatGPT Plus', periodo: 'semanal', techo: 100, unidad: 'porcentaje', reposicion: 'rolling' },
                },
                balanceo: { delta_min_pct: 15 },
            },
        };
        assert.ok(!fs.existsSync(path.join(dir, 'state', 'quota-ledger.jsonl')));
        const r = run(dir, { config: cfg, onLog: (_c, m) => logs.push(m) });
        assert.equal(r.gated, false);
        assert.equal(r.provider, 'anthropic');
        assert.equal(r.balance.regla, 'degradado');
        assert.equal(r.balance.degradado_motivo, 'sin_datos');
        assert.equal(r.skipReasons.length, 0);
        assert.ok(logs.some((m) => /balanceo: degradado \(sin_datos\) → orden declarado/.test(m)), logs.join('\n'));
        const line = formatProviderResolutionLog(r, { skill: 'guru', issue: ISSUE });
        assert.match(line, /\(balanceo: degradado \(sin_datos\) → orden declarado\)/);
    } finally { cleanup(dir); }
});

test('CA-5 · dato desactualizado (stale) no participa ⇒ degradado (desactualizado)', () => {
    const dir = mkPipelineDir();
    try {
        const r = run(dir, { quotaBalanceReader: balanceReader({ anthropic: { saldo: 5, confidence: 'stale' }, 'openai-codex': 95 }) });
        assert.equal(r.provider, 'anthropic');
        assert.equal(r.balance.regla, 'degradado');
        assert.equal(r.balance.degradado_motivo, 'desactualizado');
    } finally { cleanup(dir); }
});

test('CA-5 · un candidato sin dato conserva su posición; los que sí tienen se reordenan entre ellos', () => {
    const dir = mkPipelineDir();
    try {
        // antigravity nunca reporta consumo (reports_usage: false) → sin_datos.
        const r = run(dir, {
            skill: 'triple',
            quotaBalanceReader: balanceReader({ anthropic: 20, 'openai-codex': 80, antigravity: { saldo: 100, confidence: 'missing' } }),
        });
        assert.equal(r.provider, 'openai-codex');
        assert.deepEqual(r.balance.orden, ['openai-codex', 'anthropic', 'antigravity']);
        assert.equal(r.balance.regla, 'saldo');
    } finally { cleanup(dir); }
});

test('CA-5 · el lector tira ⇒ fail-open al orden declarado sin frenar el spawn', () => {
    const dir = mkPipelineDir();
    try {
        const r = run(dir, { quotaBalanceReader: () => { throw new Error('ledger corrupto'); } });
        assert.equal(r.gated, false);
        assert.equal(r.provider, 'anthropic');
        assert.equal(r.balance, null);
    } finally { cleanup(dir); }
});

test('CA-5 · `multi_provider.balanceo.enabled: false` ⇒ degradado (deshabilitado) sin leer el ledger', () => {
    const dir = mkPipelineDir();
    try {
        const reader = balanceReader({ anthropic: 5, 'openai-codex': 95 });
        const r = run(dir, { config: { multi_provider: { balanceo: { enabled: false } } }, quotaBalanceReader: reader });
        assert.equal(r.provider, 'anthropic');
        assert.equal(reader.calls, 0);
        assert.equal(r.balance.regla, 'degradado');
        assert.equal(r.balance.degradado_motivo, 'deshabilitado');
    } finally { cleanup(dir); }
});

test('CA-5 · valores inválidos en la config caen a defaults y se avisan por log', () => {
    const dir = mkPipelineDir();
    try {
        const logs = [];
        const r = run(dir, {
            config: { multi_provider: { balanceo: { delta_min_pct: 'mucho', fases_criticas: 'verificacion' } } },
            quotaBalanceReader: balanceReader({ anthropic: 40, 'openai-codex': 50 }),
            onLog: (_c, m) => logs.push(m),
        });
        assert.equal(r.balance.umbral, 15);
        assert.equal(r.provider, 'anthropic');
        assert.ok(logs.some((m) => /multi_provider\.balanceo con valores inválidos/.test(m)));
    } finally { cleanup(dir); }
});

// =============================================================================
// Regresión (review rev-1) — el balanceo NO es un episodio de respaldo (#6179)
//
// El camino feliz (primario sano con menor saldo ⇒ se elige el otro) entraba por
// el loop de fallbacks y registraba `crossProvider: true` en el episodio: cada
// spawn balanceado abría un "pasó a motor de respaldo" en Telegram y el
// siguiente con primario sano lo cerraba — flapping en operación NORMAL. Estos
// tests corren con `recordEpisode` ACTIVO (módulo real sobre el `pipelineDir`
// temporal) y `notify` capturado, que es exactamente lo que el harness de
// arriba (`recordEpisode: false`) no veía.
// =============================================================================
const episodeState = require('../lib/fallback-episode-state');

function episodeFileOf(dir) { return path.join(dir, 'state', episodeState.EPISODE_FILENAME); }
function readEpisodeFile(dir) {
    try { return JSON.parse(fs.readFileSync(episodeFileOf(dir), 'utf8')); } catch { return null; }
}
/** Harness con episodio REAL: `recordEpisode` activo, `notify` y `onLog` capturados. */
function runWithEpisode(dir, captured, extra = {}) {
    return run(dir, {
        recordEpisode: true,
        notify: (n) => { captured.notices.push(n); },
        onLog: (_c, line) => { captured.logs.push(String(line)); },
        ...extra,
    });
}

test('regresión · dos spawns balanceados seguidos con episodio activo ⇒ 0 avisos y ningún episodio en modo respaldo', () => {
    const dir = mkPipelineDir();
    try {
        const captured = { notices: [], logs: [] };
        const audit = fakeAuditLog();
        const reader = balanceReader({ 'openai-codex': 10, anthropic: 70 });

        const r1 = runWithEpisode(dir, captured, { skill: 'codex-first', auditLog: audit, quotaBalanceReader: reader });
        const r2 = runWithEpisode(dir, captured, { skill: 'codex-first', auditLog: audit, quotaBalanceReader: reader, now: NOW + 60000 });

        for (const r of [r1, r2]) {
            assert.equal(r.provider, 'anthropic', 'el balanceo prefirió el de mayor saldo');
            assert.equal(r.source, 'fallback');
            assert.equal(r.balance.regla, 'saldo');
            assert.equal(r.primaryBalanceDeferred, true);
        }
        assert.equal(captured.notices.length, 0, `el balanceo no dispara avisos de respaldo: ${JSON.stringify(captured.notices.map((n) => n.meta))}`);
        const ep = readEpisodeFile(dir);
        assert.ok(ep === null || ep.mode === episodeState.MODE_PRIMARIO, `sin episodio en modo respaldo: ${JSON.stringify(ep)}`);
    } finally { cleanup(dir); }
});

test('regresión · trazabilidad coherente (CA-4): log/audit dicen "diferido por balanceo" y disqualifyReason es un literal estático', () => {
    const dir = mkPipelineDir();
    try {
        const captured = { notices: [], logs: [] };
        const audit = fakeAuditLog();
        const r = runWithEpisode(dir, captured, {
            skill: 'codex-first', auditLog: audit,
            quotaBalanceReader: balanceReader({ 'openai-codex': 10, anthropic: 70 }),
        });
        assert.equal(r.provider, 'anthropic');
        assert.equal(r.disqualifyReason, 'primary_quota_balance_deferred', 'motivo estático para _trace.resolution.reason');

        const sel = audit.entries.find((e) => e.event === 'fallback_selected');
        assert.ok(sel, 'audit fallback_selected emitido');
        assert.equal(sel.primary_deferred_by_balance, true);
        assert.match(sel.raw_excerpt, /primary=openai-codex diferido por balanceo/);
        assert.doesNotMatch(sel.raw_excerpt, /gated/);

        const jump = captured.logs.find((l) => /usando fallback="anthropic"/.test(l));
        assert.ok(jump, 'línea de salto al fallback logueada');
        assert.match(jump, /diferido por balanceo/);
        assert.doesNotMatch(jump, /gated/);
    } finally { cleanup(dir); }
});

test('regresión · el salto por gate REAL conserva su trazabilidad ("gated") y sí abre episodio de respaldo', () => {
    const dir = mkPipelineDir();
    try {
        const captured = { notices: [], logs: [] };
        const audit = fakeAuditLog();
        const r = runWithEpisode(dir, captured, {
            skill: 'codex-first', auditLog: audit,
            quotaModule: quotaModule(['openai-codex']), // primario hard-gateado por cuota
            quotaBalanceReader: balanceReader({ 'openai-codex': 10, anthropic: 70 }),
        });
        assert.equal(r.provider, 'anthropic');
        assert.equal(r.disqualifyReason, 'primary_quota_exhausted');
        assert.equal(r.primaryBalanceDeferred, false);
        const sel = audit.entries.find((e) => e.event === 'fallback_selected');
        assert.equal(sel.primary_deferred_by_balance, false);
        assert.match(sel.raw_excerpt, /primary=openai-codex gated/);
        assert.equal(captured.notices.length, 1, 'la degradación real sí avisa (entra en respaldo)');
        assert.equal(captured.notices[0].meta.event, 'fallback_episode');
        assert.equal(captured.notices[0].meta.episode_mode, episodeState.MODE_RESPALDO);
        assert.equal(readEpisodeFile(dir).mode, episodeState.MODE_RESPALDO);
    } finally { cleanup(dir); }
});

test('regresión · episodio real abierto (primario hard-gateado) y luego spawns balanceados ⇒ se cierra una vez y no flapea', () => {
    const dir = mkPipelineDir();
    try {
        const captured = { notices: [], logs: [] };
        const reader = balanceReader({ 'openai-codex': 10, anthropic: 70 });

        // 1) Degradación REAL: el primario está sin cuota ⇒ abre episodio de respaldo (1 aviso).
        runWithEpisode(dir, captured, { skill: 'codex-first', quotaModule: quotaModule(['openai-codex']), quotaBalanceReader: reader });
        assert.equal(captured.notices.length, 1);
        assert.equal(captured.notices[0].meta.episode_mode, episodeState.MODE_RESPALDO);

        // 2) El primario vuelve a estar sano pero el balanceo prefiere el otro ⇒
        //    el pipeline ya no está degradado: cierra el episodio (1 aviso de vuelta).
        const r2 = runWithEpisode(dir, captured, { skill: 'codex-first', quotaBalanceReader: reader, now: NOW + 60000 });
        assert.equal(r2.provider, 'anthropic');
        assert.equal(r2.primaryBalanceDeferred, true);
        assert.equal(captured.notices.length, 2);
        assert.equal(captured.notices[1].meta.episode_reason, 'vuelve_principal');
        assert.equal(readEpisodeFile(dir).mode, episodeState.MODE_PRIMARIO);

        // 3) y 4) Más spawns balanceados (fallback y primario) ⇒ sin flapping: 0 avisos nuevos.
        runWithEpisode(dir, captured, { skill: 'codex-first', quotaBalanceReader: reader, now: NOW + 120000 });
        runWithEpisode(dir, captured, { skill: 'guru', quotaBalanceReader: reader, now: NOW + 180000 }); // primario anthropic sano
        runWithEpisode(dir, captured, { skill: 'codex-first', quotaBalanceReader: reader, now: NOW + 240000 });
        assert.equal(captured.notices.length, 2, `sin avisos nuevos: ${JSON.stringify(captured.notices.slice(2).map((n) => n.meta))}`);
        assert.equal(readEpisodeFile(dir).mode, episodeState.MODE_PRIMARIO);
    } finally { cleanup(dir); }
});

// =============================================================================
// Integración real con el ledger de #6560 (readQuotaBalanceForDispatch)
// =============================================================================
const REAL_CONFIG = {
    multi_provider: {
        quota: {
            anthropic: { plan: 'Claude Max', periodo: 'semanal', techo: 100, unidad: 'porcentaje', reposicion: 'dom 21:00' },
            'openai-codex': { plan: 'ChatGPT Plus', periodo: 'semanal', techo: 100, unidad: 'porcentaje', reposicion: 'rolling' },
            antigravity: { plan: 'Google One', periodo: 'diario', techo: 100, unidad: 'porcentaje', reposicion: 'rolling' },
        },
        balanceo: { delta_min_pct: 15, margen_reserva_pct: 20 },
    },
};
function writeLedger(dir, rows) {
    fs.writeFileSync(path.join(dir, 'state', 'quota-ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function samples(provider, pcts, opts = {}) {
    // Una muestra cada 10 min terminando en NOW − 1 min (fresca).
    return pcts.map((pct, i) => ({
        ts: new Date(NOW - 60000 - (pcts.length - 1 - i) * 10 * 60000).toISOString(),
        provider, bucket: 'weekly', pct, confidence: 'fresh', source: 'test',
        reset_at: opts.reset_at || null,
    }));
}

test('integración · caso medido 25/08: Codex 100 % consumido y Claude 30 % ⇒ elige Claude aunque Codex sea primario', () => {
    const dir = mkPipelineDir();
    balancer._resetCacheForTests();
    try {
        writeLedger(dir, [
            ...samples('openai-codex', [96, 98, 100], { reset_at: new Date(NOW + 3 * 24 * 3600 * 1000).toISOString() }),
            ...samples('anthropic', [28, 29, 30]),
        ]);
        const r = run(dir, { skill: 'codex-first', config: REAL_CONFIG });
        assert.equal(r.provider, 'anthropic');
        assert.equal(r.balance.regla, 'saldo');
        const codex = r.balance.candidatos.find((c) => c.provider === 'openai-codex');
        const anth = r.balance.candidatos.find((c) => c.provider === 'anthropic');
        assert.equal(codex.saldo_relativo, 0);
        assert.equal(anth.saldo_relativo, 70);
        assert.equal(codex.confidence, 'fresh');
        assert.ok(anth.ritmo_pts_por_hora > 0, 'el ritmo viene de #6560');
    } finally { cleanup(dir); }
});

test('integración · caché corta: dos spawns seguidos leen el ledger una sola vez', () => {
    const dir = mkPipelineDir();
    balancer._resetCacheForTests();
    try {
        writeLedger(dir, [...samples('openai-codex', [10, 12, 14]), ...samples('anthropic', [50, 51, 52])]);
        const first = balancer.readQuotaBalanceForDispatch({ config: REAL_CONFIG, pipelineDir: dir, now: NOW, providers: ['anthropic', 'openai-codex'] });
        assert.equal(first.anthropic.saldo_pts, 48);
        // Cambia el archivo: dentro del TTL se sigue sirviendo el snapshot anterior.
        writeLedger(dir, [...samples('openai-codex', [10, 12, 14]), ...samples('anthropic', [90, 91, 92])]);
        const second = balancer.readQuotaBalanceForDispatch({ config: REAL_CONFIG, pipelineDir: dir, now: NOW + 5000, providers: ['anthropic', 'openai-codex'] });
        assert.equal(second.anthropic.saldo_pts, 48, 'snapshot cacheado');
        const third = balancer.readQuotaBalanceForDispatch({ config: REAL_CONFIG, pipelineDir: dir, now: NOW + 31000, providers: ['anthropic', 'openai-codex'] });
        assert.equal(third.anthropic.saldo_pts, 8, 'vencido el TTL se relee');
    } finally { cleanup(dir); }
});

test('integración · muestras viejas (> 30 min) ⇒ stale ⇒ degradado (desactualizado)', () => {
    const dir = mkPipelineDir();
    balancer._resetCacheForTests();
    try {
        const old = (provider, pcts) => pcts.map((pct, i) => ({
            ts: new Date(NOW - 2 * 3600 * 1000 - (pcts.length - 1 - i) * 10 * 60000).toISOString(),
            provider, bucket: 'weekly', pct, confidence: 'fresh', source: 'test',
        }));
        writeLedger(dir, [...old('openai-codex', [96, 98, 100]), ...old('anthropic', [28, 29, 30])]);
        const r = run(dir, { skill: 'codex-first', config: REAL_CONFIG });
        assert.equal(r.provider, 'openai-codex', 'sin dato fresco no se reordena');
        assert.equal(r.balance.regla, 'degradado');
        assert.equal(r.balance.degradado_motivo, 'desactualizado');
    } finally { cleanup(dir); }
});

// =============================================================================
// Módulo puro — unidad
// =============================================================================
test('unidad · readBalanceoConfig: defaults documentados', () => {
    const p = balancer.readBalanceoConfig(null);
    assert.equal(p.enabled, true);
    assert.equal(p.delta_min_pct, 15);
    assert.equal(p.margen_reserva_pct, 20);
    assert.deepEqual(p.fases_criticas, ['verificacion', 'aprobacion', 'delivery']);
    assert.deepEqual(p.warnings, []);
});

test('unidad · readBalanceoConfig: rangos inválidos ⇒ default + warning por campo', () => {
    const p = balancer.readBalanceoConfig({ multi_provider: { balanceo: { delta_min_pct: 150, margen_reserva_pct: -1, enabled: 'sí', fases_criticas: [1] } } });
    assert.equal(p.delta_min_pct, 15);
    assert.equal(p.margen_reserva_pct, 20);
    assert.equal(p.enabled, true);
    assert.equal(p.warnings.length, 4);
});

test('unidad · rankBySaldo: empate exacto ⇒ orden declarado', () => {
    const g = [
        { provider: 'a', orden_declarado: 0, saldo_relativo: 50 },
        { provider: 'b', orden_declarado: 1, saldo_relativo: 50 },
    ];
    assert.deepEqual(balancer.rankBySaldo(g, 15).map((c) => c.provider), ['a', 'b']);
});

test('unidad · planQuotaBalance: excedido (saldo 0, fresh) participa y pierde', () => {
    const plan = balancer.planQuotaBalance({
        chain: ['anthropic', 'openai-codex'],
        balance: {
            anthropic: { techo: 100, saldo_pts: 0, excedente_pts: 3, estado: 'excedido', confidence: 'fresh' },
            'openai-codex': { techo: 100, saldo_pts: 40, estado: 'alcanza', confidence: 'fresh' },
        },
        policy: { delta_min_pct: 15, margen_reserva_pct: 0 },
        fase: 'dev',
    });
    assert.equal(plan.elegido, 'openai-codex');
    assert.equal(plan.regla, 'saldo');
    assert.equal(plan.candidatos[0].saldo_relativo, 0);
});

test('unidad · planQuotaBalance: sin techo declarado ⇒ degradado (sin_techo)', () => {
    const plan = balancer.planQuotaBalance({ chain: ['anthropic', 'openai-codex'], balance: {}, fase: 'dev' });
    assert.equal(plan.regla, 'degradado');
    assert.equal(plan.degradado_motivo, 'sin_techo');
    assert.deepEqual(plan.orden, ['anthropic', 'openai-codex']);
});

test('unidad · toAuditEntry: shape cerrado (UX §6)', () => {
    const plan = balancer.planQuotaBalance({
        chain: ['anthropic', 'openai-codex'],
        balance: { anthropic: { techo: 100, saldo_pts: 10, confidence: 'fresh', estado: 'alcanza' }, 'openai-codex': { techo: 100, saldo_pts: 70, confidence: 'fresh', estado: 'alcanza' } },
        fase: 'dev',
    });
    const e = balancer.toAuditEntry(plan);
    assert.deepEqual(Object.keys(e).sort(), ['candidatos', 'degradado_motivo', 'elegido', 'fase', 'fase_critica', 'fuente', 'margen_reserva_pct', 'orden', 'regla', 'umbral']);
    assert.equal(e.elegido, 'openai-codex');
    assert.equal(e.regla, 'saldo');
});
