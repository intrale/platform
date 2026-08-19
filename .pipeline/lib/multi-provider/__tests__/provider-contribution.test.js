// =============================================================================
// provider-contribution.test.js — invariantes del criterio de permanencia (#6145)
// =============================================================================
//
// Los tests de este archivo NO son de cobertura decorativa: cada uno fija un
// invariante que, de romperse, saca de la cadena a un proveedor que sí aporta
// (o vacía la cadena entera). Son la red de seguridad de REQ-SEC-2 y REQ-SEC-3.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mod = require('../provider-contribution');

const MODULE_PATH = path.join(__dirname, '..', 'provider-contribution.js');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-19T12:00:00.000Z');

// -----------------------------------------------------------------------------
// Helpers de fixtures
// -----------------------------------------------------------------------------

let seq = 0;
function ev(event, provider, extra = {}) {
    seq += 1;
    return {
        event,
        skill: extra.skill || 'po',
        fallback_provider: provider,
        primary_provider: extra.primary_provider || 'anthropic',
        created_at: Number.isFinite(extra.created_at) ? extra.created_at : NOW - DAY + seq,
        ...extra,
    };
}

/** N eventos iguales. */
function many(n, event, provider, extra = {}) {
    return Array.from({ length: n }, () => ev(event, provider, extra));
}

const DECLARED = {
    anthropic: { billing: 'paid', declaredInConfig: true },
    'openai-codex': { billing: 'paid', declaredInConfig: true },
    'gemini-google': { billing: 'free', declaredInConfig: true },
    cerebras: { billing: 'free', declaredInConfig: true },
    'nvidia-nim': { billing: 'free', declaredInConfig: true },
};

const THRESHOLDS = {
    min_sample: 100,
    min_contribution_rate: 0.05,
    max_days_without_win: 14,
    min_survivors: 1,
};

function evaluate(entries, { declared = DECLARED, thresholds = THRESHOLDS, chainOk = true } = {}) {
    const metrics = mod.computeContribution(entries, { now: NOW });
    return {
        metrics,
        verdicts: mod.evaluatePermanence(metrics, thresholds, { chainOk, declared, now: NOW }),
    };
}

// -----------------------------------------------------------------------------
// Denominador
// -----------------------------------------------------------------------------

test('el denominador excluye los gateos por ventana horaria', () => {
    const entries = [
        ...many(50, 'fallback_selected', 'cerebras'),
        ...many(50, 'fallback_provider_disabled', 'cerebras'),
        // 900 gateos por horario: si contaran, la tasa caería de 50% a 5%.
        ...many(300, 'primary_inactive_by_schedule', null, { primary_provider: 'cerebras' }),
        ...many(300, 'fallback_also_gated', 'cerebras'),
        ...many(300, 'fallback_provider_inactive_by_schedule', 'cerebras'),
    ];
    const m = mod.computeContribution(entries, { now: NOW }).cerebras;

    assert.strictEqual(m.attempts, 1000, 'los 1000 eventos se cuentan como intentos');
    assert.strictEqual(m.gatedBySchedule, 900, 'los 900 de horario se aíslan');
    assert.strictEqual(m.evaluables, 100, 'evaluables = attempts - gatedBySchedule');
    assert.strictEqual(m.wins, 50);
    assert.strictEqual(m.contributionRate, 0.5, 'la tasa se calcula sobre evaluables, no sobre attempts');
});

test('chain_exhausted no se imputa a ningun proveedor', () => {
    const entries = [
        ...many(10, 'fallback_selected', 'cerebras'),
        ...many(500, 'chain_exhausted', null, { primary_provider: 'anthropic' }),
    ];
    const metrics = mod.computeContribution(entries, { now: NOW });
    assert.strictEqual(metrics.cerebras.attempts, 10);
    assert.strictEqual(metrics.anthropic, undefined, 'chain_exhausted no crea filas de proveedor');
});

// -----------------------------------------------------------------------------
// "Sin dato" nunca es "no aporta"
// -----------------------------------------------------------------------------

test('un proveedor sin muestra suficiente queda no_evaluable y nunca candidato a baja', () => {
    const entries = [
        // cerebras: sano, sostiene la cadena.
        ...many(200, 'fallback_selected', 'cerebras'),
        // nvidia-nim: 99 evaluables < min_sample=100, y 0 aportes.
        ...many(99, 'fallback_provider_disabled', 'nvidia-nim'),
    ];
    const { verdicts } = evaluate(entries);

    assert.strictEqual(verdicts['nvidia-nim'].verdict, mod.VERDICT.NO_EVALUABLE);
    assert.notStrictEqual(verdicts['nvidia-nim'].verdict, mod.VERDICT.CANDIDATO_BAJA);
    assert.match(verdicts['nvidia-nim'].reasons.join(' '), /muestra insuficiente/);
});

test('sin dato en la ventana no equivale a no aporta', () => {
    // gemini-google está declarado pero NO aparece ni una vez en la ventana.
    const entries = many(500, 'fallback_selected', 'cerebras');
    const { verdicts } = evaluate(entries);

    assert.strictEqual(verdicts['gemini-google'].verdict, mod.VERDICT.NO_EVALUABLE);
    assert.strictEqual(verdicts['gemini-google'].evidence, null, 'sin evidencia, no evidencia vacía en cero');
    assert.notStrictEqual(verdicts['gemini-google'].verdict, mod.VERDICT.CANDIDATO_BAJA);
});

// -----------------------------------------------------------------------------
// Observabilidad local (caso Gemini)
// -----------------------------------------------------------------------------

test('un gateo durable por cli_license_unavailable no baja la tasa de aporte', () => {
    const entries = [
        ...many(300, 'fallback_selected', 'cerebras'),   // sostiene la cadena
        // gemini: 10 aportes sobre 1010 evaluables => 0,99% (bajo el 5%),
        // pero el bloqueo dominante es un flag de entorno NUESTRO.
        ...many(10, 'fallback_selected', 'gemini-google'),
        ...many(1000, 'fallback_health_gated', 'gemini-google', {
            health_state: 'red',
            health_reason: 'cli_license_unavailable',
        }),
    ];
    const { metrics, verdicts } = evaluate(entries);

    assert.ok(metrics['gemini-google'].contributionRate < 0.05, 'la tasa cruda sí está por debajo del umbral');
    assert.strictEqual(metrics['gemini-google'].dominantBlock, 'observabilidad_local');
    assert.strictEqual(
        verdicts['gemini-google'].verdict,
        mod.VERDICT.ROL_ACOTADO,
        'techo rol_acotado: no se propone la baja sin corregir antes el chequeo',
    );
    assert.notStrictEqual(verdicts['gemini-google'].verdict, mod.VERDICT.CANDIDATO_BAJA);
});

test('un bloqueo por causa del proveedor si habilita el candidato a baja', () => {
    // Mismo escenario que el anterior pero con causa imputable al proveedor:
    // acá el veredicto SÍ debe ser candidato a baja. Sin este test, el techo
    // de `rol_acotado` podría estar aplicándose siempre y el criterio no
    // marcaría nunca a nadie.
    const entries = [
        ...many(300, 'fallback_selected', 'cerebras'),
        ...many(10, 'fallback_selected', 'nvidia-nim'),
        ...many(1000, 'fallback_health_gated', 'nvidia-nim', {
            health_state: 'red',
            health_reason: 'invalid_credentials',
        }),
    ];
    const { metrics, verdicts } = evaluate(entries);

    assert.strictEqual(metrics['nvidia-nim'].dominantBlock, 'credencial');
    assert.strictEqual(verdicts['nvidia-nim'].verdict, mod.VERDICT.CANDIDATO_BAJA);
});

// -----------------------------------------------------------------------------
// Integridad
// -----------------------------------------------------------------------------

test('cadena de hash corrupta o archivo faltante impide evaluar a todos los proveedores', () => {
    const entries = [
        ...many(500, 'fallback_selected', 'cerebras'),
        ...many(500, 'fallback_provider_disabled', 'nvidia-nim'),
    ];
    const { verdicts } = evaluate(entries, { chainOk: false });

    for (const name of Object.keys(DECLARED)) {
        assert.strictEqual(
            verdicts[name].verdict,
            mod.VERDICT.NO_EVALUABLE,
            `${name} debe quedar no_evaluable con la chain rota`,
        );
    }
});

test('readWindow descarta el archivo con hash-chain rota y lo reporta', () => {
    const files = {
        'cross-provider-dispatch-2026-08-18.jsonl': 'sano',
        'cross-provider-dispatch-2026-08-19.jsonl': 'roto',
    };
    const fakeFs = {
        existsSync: (p) => String(p).includes('logs') || Object.keys(files).some((f) => String(p).endsWith(f)),
        readdirSync: () => Object.keys(files),
        readFileSync: () => '',
    };
    const fakeAuditLog = {
        verifyChain: (file) => ({ ok: !String(file).endsWith('2026-08-19.jsonl'), reason: 'hash_self mismatch' }),
        readAll: () => [ev('fallback_selected', 'cerebras', { created_at: NOW - DAY })],
    };
    const res = mod.readWindow({
        pipelineDir: '/fake',
        from: NOW - 30 * DAY,
        to: NOW,
        fsImpl: fakeFs,
        auditLog: fakeAuditLog,
    });

    assert.strictEqual(res.integrity.chainOk, false);
    assert.deepStrictEqual(res.integrity.brokenFiles, ['cross-provider-dispatch-2026-08-19.jsonl']);
    assert.strictEqual(res.entries.length, 1, 'solo sobreviven las entradas del archivo íntegro');
});

// -----------------------------------------------------------------------------
// Invariantes de disponibilidad (REQ-SEC-3)
// -----------------------------------------------------------------------------

test('nunca marca candidato al ultimo proveedor sano de la cadena', () => {
    // Un solo proveedor gratuito declarado, y con tasa por debajo del umbral.
    // Marcarlo dejaría la cadena de gratuitos vacía => no se marca.
    const declared = { cerebras: { billing: 'free', declaredInConfig: true } };
    const entries = [
        ...many(5, 'fallback_selected', 'cerebras'),
        ...many(500, 'fallback_provider_disabled', 'cerebras'),
    ];
    const { metrics, verdicts } = evaluate(entries, { declared });

    assert.ok(metrics.cerebras.contributionRate < 0.05, 'la tasa cruda justifica el candidato');
    assert.strictEqual(verdicts.cerebras.verdict, mod.VERDICT.ROL_ACOTADO);
    assert.strictEqual(verdicts.cerebras.chainInvariantApplied, true);
    assert.match(verdicts.cerebras.reasons.join(' '), /invariante de cadena minima/);
});

test('un proveedor pago nunca es candidato a baja', () => {
    const entries = [
        ...many(300, 'fallback_selected', 'cerebras'),
        // openai-codex: 1 aporte sobre 1001 evaluables, último aporte hace 40 días.
        ...many(1, 'fallback_selected', 'openai-codex', { created_at: NOW - 40 * DAY }),
        ...many(1000, 'fallback_provider_disabled', 'openai-codex'),
    ];
    const { verdicts } = evaluate(entries);

    assert.strictEqual(verdicts['openai-codex'].verdict, mod.VERDICT.MANTENER);
    assert.match(verdicts['openai-codex'].reasons.join(' '), /pago/);
});

test('un proveedor sin ningun aporte en la ventana queda marcado como candidato con evidencia', () => {
    const entries = [
        ...many(500, 'fallback_selected', 'cerebras'),
        ...many(500, 'fallback_provider_disabled', 'nvidia-nim'),   // cero wins
    ];
    const { verdicts } = evaluate(entries);

    assert.strictEqual(verdicts['nvidia-nim'].verdict, mod.VERDICT.CANDIDATO_BAJA);
    assert.strictEqual(verdicts['nvidia-nim'].evidence.wins, 0);
    assert.strictEqual(verdicts['nvidia-nim'].evidence.evaluables, 500);
    assert.match(verdicts['nvidia-nim'].reasons.join(' '), /sin ningun aporte real en la ventana/);
});

test('un proveedor que dejo de aportar hace mas dias que el umbral queda candidato', () => {
    const entries = [
        ...many(500, 'fallback_selected', 'cerebras'),
        ...many(400, 'fallback_selected', 'nvidia-nim', { created_at: NOW - 20 * DAY }),
        ...many(100, 'fallback_provider_disabled', 'nvidia-nim'),
    ];
    const { verdicts } = evaluate(entries);

    assert.strictEqual(verdicts['nvidia-nim'].verdict, mod.VERDICT.CANDIDATO_BAJA);
    assert.match(verdicts['nvidia-nim'].reasons.join(' '), /ultimo aporte hace 20\.0 dias/);
});

// -----------------------------------------------------------------------------
// Declaración y presentación
// -----------------------------------------------------------------------------

test('un proveedor presente en el log y ausente de config se reporta sin_declarar', () => {
    const entries = [
        ...many(500, 'fallback_selected', 'cerebras'),
        ...many(73, 'fallback_selected', 'kimi-moonshot'),
    ];
    const { verdicts } = evaluate(entries);

    assert.strictEqual(verdicts['kimi-moonshot'].verdict, mod.VERDICT.SIN_DECLARAR);
    assert.strictEqual(verdicts['kimi-moonshot'].verdictLabel, 'sin declarar');
    assert.notStrictEqual(verdicts['kimi-moonshot'].verdict, mod.VERDICT.CANDIDATO_BAJA);
});

test('un proveedor en agent-models pero ausente de config.yaml tambien es sin_declarar', () => {
    const declared = {
        cerebras: { billing: 'free', declaredInConfig: true },
        'kimi-moonshot': { billing: 'free', declaredInConfig: false },
    };
    const entries = [
        ...many(500, 'fallback_selected', 'cerebras'),
        ...many(500, 'fallback_provider_disabled', 'kimi-moonshot'),
    ];
    const { verdicts } = evaluate(entries, { declared });

    assert.strictEqual(verdicts['kimi-moonshot'].verdict, mod.VERDICT.SIN_DECLARAR);
    assert.match(verdicts['kimi-moonshot'].reasons.join(' '), /ausente de config\.yaml \(#6153\)/);
});

test('el reparto por rol separa lo conversacional de los agentes del pipeline', () => {
    const entries = [
        ...many(30, 'fallback_selected', 'cerebras', { skill: 'telegram-commander' }),
        ...many(10, 'fallback_selected', 'cerebras', { skill: 'telegram-sherlock' }),
        ...many(60, 'fallback_selected', 'cerebras', { skill: 'pipeline-dev' }),
    ];
    const m = mod.computeContribution(entries, { now: NOW }).cerebras;

    assert.deepStrictEqual(m.roleSplitPct, { conversacional: 40, pipeline: 60 });
});

test('la latencia no instrumentada se declara, nunca se inventa ni se estima', () => {
    const entries = many(10, 'fallback_selected', 'gemini-google');
    const healthSnapshot = {
        providers: [
            { provider: 'gemini-google', state: 'red', reason_code: 'cli_license_unavailable', latency_ms: null },
            { provider: 'cerebras', state: 'green', reason_code: 'authenticated', latency_ms: 674 },
        ],
    };
    const metrics = mod.computeContribution(
        [...entries, ...many(10, 'fallback_selected', 'cerebras')],
        { now: NOW, healthSnapshot },
    );

    assert.strictEqual(metrics['gemini-google'].latencyMs, null);
    assert.strictEqual(metrics['gemini-google'].latencyReason, mod.ABSENCE.NO_INSTRUMENTADO);
    assert.strictEqual(metrics.cerebras.latencyMs, 674);
    assert.strictEqual(metrics.cerebras.latencyReason, null);
});

test('la tabla no usa guiones ni ceros para representar ausencia de medicion', () => {
    // Proveedor con CERO eventos evaluables: todas sus celdas deben decir por qué.
    const metrics = mod.computeContribution(many(3, 'fallback_selected', 'cerebras'), { now: NOW });
    metrics['proveedor-mudo'] = {
        provider: 'proveedor-mudo',
        attempts: 0,
        gatedBySchedule: 0,
        evaluables: 0,
        wins: 0,
        contributionRate: null,
        blocks: {},
        dominantBlock: null,
        dominantHealthReason: null,
        lastWinAt: null,
        roleSplitPct: null,
        latencyMs: null,
        latencyReason: mod.ABSENCE.NO_INSTRUMENTADO,
    };
    const table = mod.renderMarkdownTable(metrics, { verdicts: {} });
    const row = table.split('\n').find((l) => l.includes('proveedor-mudo'));

    assert.ok(row, 'la fila del proveedor sin datos existe');
    assert.ok(!row.includes('—'), 'ninguna celda usa el guión largo que el operador lee como cero');
    assert.ok(!/\|\s*\|/.test(row), 'ninguna celda queda vacía');
    assert.ok(row.includes(mod.ABSENCE.SIN_MUESTRA), 'la ausencia declara su causa');
});

test('la tabla ordena por aportes reales descendente', () => {
    const entries = [
        ...many(10, 'fallback_selected', 'zzz-poco'),
        ...many(90, 'fallback_selected', 'aaa-mucho'),
    ];
    const metrics = mod.computeContribution(entries, { now: NOW });
    const lines = mod.renderMarkdownTable(metrics, { verdicts: {} }).split('\n');

    assert.ok(lines[2].startsWith('| aaa-mucho'), 'el que más aporta va primero, no el alfabético');
    assert.ok(lines[3].startsWith('| zzz-poco'));
});

test('los cinco literales de veredicto son exactamente los que lee el operador', () => {
    assert.deepStrictEqual(
        Object.values(mod.VERDICT_LABEL).sort(),
        ['candidato a baja', 'mantener', 'no evaluable', 'rol acotado', 'sin declarar'],
    );
    // Ningún literal de UI puede llevar guión bajo (los ids internos sí).
    for (const label of Object.values(mod.VERDICT_LABEL)) {
        assert.ok(!label.includes('_'), `"${label}" no puede exponer el id interno`);
    }
});

// -----------------------------------------------------------------------------
// CA-2 — separación del costo por causa
// -----------------------------------------------------------------------------

test('el costo de failover se atribuye por separado a la politica horaria', () => {
    const entries = [
        ...many(500, 'primary_inactive_by_schedule', null, { primary_provider: 'anthropic' }),
        ...many(200, 'fallback_health_gated', 'gemini-google', { health_reason: 'cli_license_unavailable' }),
        ...many(200, 'fallback_selected', 'cerebras'),
        ...many(100, 'chain_exhausted', null),
    ];
    const cost = mod.computeFailoverCost(entries);

    assert.strictEqual(cost.totalEvents, 1000);
    assert.strictEqual(cost.scheduleGating.events, 500);
    assert.strictEqual(cost.scheduleGating.pct, 50);
    assert.strictEqual(cost.providerBlocking.events, 200);
    assert.strictEqual(cost.providerBlocking.pct, 20);
    assert.notStrictEqual(
        cost.providerBlocking.events, cost.totalEvents,
        'el costo total nunca se presenta como si fuera todo culpa de los proveedores',
    );
});

// -----------------------------------------------------------------------------
// REQ-SEC-1 — sólo metadatos
// -----------------------------------------------------------------------------

test('el reporte no copia raw_excerpt ni texto de prompts', () => {
    const SECRETO = 'PROMPT SENSIBLE: token sk-abc123 y ruta C:/Workspaces/secreto';
    const entries = [
        ...many(300, 'fallback_selected', 'cerebras'),
        ev('fallback_selected', 'cerebras', {
            raw_excerpt: SECRETO,
            chain_tried: ['anthropic', 'cerebras'],
            issue: '6145',
        }),
    ].map((e) => mod.projectEntry(e));

    for (const e of entries) {
        assert.ok(!('raw_excerpt' in e), 'raw_excerpt no cruza la whitelist');
        assert.ok(!('chain_tried' in e), 'chain_tried no cruza la whitelist');
        assert.ok(!('issue' in e), 'issue no cruza la whitelist');
    }

    const metrics = mod.computeContribution(entries, { now: NOW });
    const verdicts = mod.evaluatePermanence(metrics, THRESHOLDS, { chainOk: true, declared: DECLARED, now: NOW });
    const serialized = JSON.stringify({ metrics, verdicts, table: mod.renderMarkdownTable(metrics, { verdicts }) });

    assert.ok(!serialized.includes(SECRETO), 'el secreto no aparece en el reporte');
    assert.ok(!serialized.includes('sk-abc123'), 'ningún fragmento del secreto sobrevive');
});

test('la whitelist de campos es cerrada y no incluye campos de texto libre', () => {
    for (const prohibido of ['raw_excerpt', 'chain_tried', 'issue', 'reason', 'fallback_model', 'primary_model']) {
        assert.ok(
            !mod.ENTRY_FIELD_WHITELIST.includes(prohibido),
            `${prohibido} no debe estar en la whitelist`,
        );
    }
});

// -----------------------------------------------------------------------------
// Policy-as-test: la fuente de datos es innegociable
// -----------------------------------------------------------------------------

test('el modulo no lee activity-log.jsonl', () => {
    // Riesgo 1 del issue: alimentar el criterio con `.claude/activity-log.jsonl`
    // daría de baja a gemini-google, cerebras y nvidia-nim, que tienen ~0
    // registros ahí y cientos de selecciones reales en el log de dispatch.
    // Grep estático sobre el fuente — mismo patrón que el guard de append-only.
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    const code = source
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
        .join('\n');

    for (const prohibido of ['activity-log', 'activity_log', 'provider-health', 'activity-provider-index']) {
        assert.ok(
            !code.includes(prohibido),
            `el módulo no puede referenciar "${prohibido}" fuera de comentarios`,
        );
    }
    assert.ok(
        source.includes('cross-provider-dispatch-'),
        'la fuente declarada sigue siendo el log de dispatch con hash-chain',
    );
});

test('el modulo es read-only: no invoca ninguna API de escritura de fs', () => {
    // CA-7 verificado por inspección estática además de empíricamente: este
    // módulo mide y decide, nunca ejecuta.
    const code = fs.readFileSync(MODULE_PATH, 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');

    for (const escritura of [
        'writeFileSync', 'appendFileSync', 'appendChained', 'unlinkSync',
        'renameSync', 'rmSync', 'mkdirSync', 'writeFile(',
    ]) {
        assert.ok(!code.includes(escritura), `el módulo no puede invocar ${escritura}`);
    }
});

// -----------------------------------------------------------------------------
// listDispatchFiles
// -----------------------------------------------------------------------------

test('listDispatchFiles acota la ventana y descarta archivos ajenos', () => {
    const names = [
        'cross-provider-dispatch-2026-07-19.jsonl',   // fuera (anterior)
        'cross-provider-dispatch-2026-07-20.jsonl',   // dentro (borde)
        'cross-provider-dispatch-2026-08-19.jsonl',   // dentro (borde)
        'cross-provider-dispatch-2026-08-20.jsonl',   // fuera (posterior)
        'spawn-exit-2026-08-19.jsonl',                // otro archivo del mismo dir
        'cross-provider-dispatch-2026-08-19.jsonl.bak',
    ];
    const fakeFs = { existsSync: () => true, readdirSync: () => names };
    const got = mod.listDispatchFiles('/fake', {
        from: Date.parse('2026-07-20T00:00:00Z'),
        to: Date.parse('2026-08-19T23:59:59Z'),
        fsImpl: fakeFs,
    }).map((p) => path.basename(p));

    assert.deepStrictEqual(got, [
        'cross-provider-dispatch-2026-07-20.jsonl',
        'cross-provider-dispatch-2026-08-19.jsonl',
    ]);
});

test('listDispatchFiles devuelve vacio si el directorio no existe, sin tirar', () => {
    const fakeFs = { existsSync: () => false, readdirSync: () => { throw new Error('ENOENT'); } };
    assert.deepStrictEqual(mod.listDispatchFiles('/no-existe', { fsImpl: fakeFs }), []);
});
