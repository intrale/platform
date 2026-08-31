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

/**
 * rev-3 (#6145) — N bloqueos GENUINAMENTE imputables al proveedor: el chequeo de
 * salud lo encontro con la cuota agotada, que es un veredicto del proveedor
 * sobre si mismo.
 *
 * Hasta rev-2 estos fixtures usaban `fallback_provider_disabled` como "bloqueo
 * generico", pero ese evento es el kill-switch del OPERADOR (#3811) y ya no
 * entra en el denominador. Seguir usandolo aca habria hecho que los tests
 * midieran nuestra propia decision de apagar el proveedor en vez de medir al
 * proveedor — exactamente el bug que este rebote corrige.
 */
function manyBlocked(n, provider, extra = {}) {
    return many(n, 'fallback_health_gated', provider, { health_reason: 'quota_exhausted', ...extra });
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
        ...manyBlocked(50, 'cerebras'),
        // 600 gateos por horario: si contaran, la tasa caería de 50% a ~7%.
        ...many(300, 'primary_inactive_by_schedule', null, { primary_provider: 'cerebras' }),
        ...many(300, 'fallback_provider_inactive_by_schedule', 'cerebras'),
    ];
    const m = mod.computeContribution(entries, { now: NOW }).cerebras;

    assert.strictEqual(m.attempts, 700, 'los 700 eventos se cuentan como intentos');
    assert.strictEqual(m.gatedBySchedule, 600, 'los 600 de horario se aíslan');
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
// rev-3 (#6145) — REQ-SEC-3: el kill-switch del operador NO mide al proveedor
//
// Rebote de `security`. `provider_disabled` (primario, dispatch:1460) y
// `fallback_provider_disabled` (fallback, dispatch:1829) son el MISMO kill-switch
// #3811 resuelto por la misma `_isProviderDisabled()`. rev-2 excluia el primero
// y contaba el segundo en el denominador, y sobre datos reales el primero tiene
// CERO eventos: el descuento era vacuo y el 100% de los saltos por kill-switch
// hundia la tasa del proveedor.
// -----------------------------------------------------------------------------

test('el kill-switch del operador no baja la tasa de aporte del proveedor', () => {
    // El caso exacto del rebote: 10 intentos reales, 10 aciertos (100%), mas 400
    // saltos porque NOSOTROS apagamos el proveedor.
    const entries = [
        ...many(10, 'fallback_selected', 'cerebras'),
        ...many(400, 'fallback_provider_disabled', 'cerebras'),
    ];
    const m = mod.computeContribution(entries, { now: NOW }).cerebras;

    assert.strictEqual(m.attempts, 410);
    assert.strictEqual(m.gatedByOperator, 400, 'los 400 saltos son del operador, no del proveedor');
    assert.strictEqual(m.operatorGates.kill_switch, 400, 'y se imputan al kill-switch');
    assert.strictEqual(m.evaluables, 10, 'evaluables descuenta el kill-switch');
    assert.strictEqual(m.contributionRate, 1, 'un proveedor con 10/10 aciertos mide 100%, no 2,4%');
    assert.deepStrictEqual(Object.keys(m.blocks), [],
        'el kill-switch no es un bloqueo imputable al proveedor');
});

test('el kill-switch del operador nunca empuja a un proveedor sano a candidato a baja', () => {
    // Con dos gratuitos sanos el invariante de cadena minima no interviene, asi
    // que el veredicto sale del criterio puro (era `candidato_baja` en rev-2).
    const entries = [
        ...many(10, 'fallback_selected', 'cerebras'),
        ...many(400, 'fallback_provider_disabled', 'cerebras'),
        ...many(300, 'fallback_selected', 'nvidia-nim'),
    ];
    const { verdicts } = evaluate(entries, { thresholds: { ...THRESHOLDS, min_sample: 10 } });

    assert.strictEqual(verdicts.cerebras.verdict, mod.VERDICT.MANTENER,
        'apagar un proveedor a mano no puede leerse como que el proveedor no aporta');
    assert.strictEqual(verdicts.cerebras.evidence.gatedByOperator, 400,
        'el audit deja constancia de cuanto del descarte fue decision nuestra');
});

test('el primario y el fallback del mismo kill-switch se clasifican igual', () => {
    // Son la misma causa (#3811); lo unico que cambia es la posicion en la
    // cadena. Si divergen, vuelve el agujero de REQ-SEC-3.
    assert.strictEqual(mod.EVENT_KIND.provider_disabled, 'operativo');
    assert.strictEqual(mod.EVENT_KIND.fallback_provider_disabled, 'operativo');
    assert.strictEqual(mod.EVENT_KIND.fallback_pacing_budget_red, 'operativo',
        'el freno de ritmo (#4289) tambien es una decision nuestra');

    const porPrimario = mod.computeContribution(
        many(100, 'provider_disabled', null, { primary_provider: 'cerebras' }), { now: NOW },
    ).cerebras;
    const porFallback = mod.computeContribution(
        many(100, 'fallback_provider_disabled', 'cerebras'), { now: NOW },
    ).cerebras;

    assert.strictEqual(porPrimario.evaluables, porFallback.evaluables, 'mismo denominador');
    assert.strictEqual(porPrimario.gatedByOperator, porFallback.gatedByOperator, 'mismo descuento');
    assert.strictEqual(porFallback.evaluables, 0, 'ninguno de los dos entra al denominador');
});

test('el freno de ritmo se cuenta aparte del kill-switch manual', () => {
    const m = mod.computeContribution([
        ...many(30, 'fallback_provider_disabled', 'cerebras'),
        ...many(12, 'fallback_pacing_budget_red', 'cerebras'),
    ], { now: NOW }).cerebras;

    assert.strictEqual(m.gatedByOperator, 42, 'ambos son gateo operativo');
    assert.deepStrictEqual(m.operatorGates, { kill_switch: 30, pacing: 12 },
        'pero el reporte no puede fundir dos decisiones distintas en una sola cifra');
});

// -----------------------------------------------------------------------------
// rev-3 (#6145) — `fallback_also_gated` es cupo del proveedor, no ventana horaria
// -----------------------------------------------------------------------------

test('fallback_also_gated se imputa al cupo del proveedor y no a la ventana horaria', () => {
    // Sale de `quotaModule.shouldGateSpawn` (dispatch:1797 -> :1805), que lee el
    // flag de cuota agotada de ESE proveedor (quota-exhausted.js:1802). rev-2 lo
    // rotulaba `schedule` y le imputaba a la politica horaria 41.600 eventos de
    // cupo, que era lo que publicaba el documento.
    assert.strictEqual(mod.EVENT_KIND.fallback_also_gated, 'cupo_gate');

    const m = mod.computeContribution([
        ...many(40, 'fallback_selected', 'cerebras'),
        ...many(300, 'fallback_also_gated', 'cerebras'),
    ], { now: NOW }).cerebras;

    assert.strictEqual(m.gatedBySchedule, 0, 'no es ventana horaria');
    assert.strictEqual(m.gatedByQuotaFlag, 300, 'tiene columna propia');
    assert.strictEqual(m.evaluables, 40,
        'sigue fuera del denominador: un corte de cuota emite un evento por intento (amplificacion)');
});

test('un gratuito seco cae en no_evaluable y nunca en candidato a baja por cupo amplificado', () => {
    // Contracara del test anterior: excluir el flag de cuota no puede convertirse
    // en una via para que un proveedor sin un solo aporte pase por sano.
    const entries = [
        ...many(500, 'fallback_selected', 'cerebras'),
        ...many(5000, 'fallback_also_gated', 'nvidia-nim'),   // seco toda la ventana
    ];
    const { verdicts } = evaluate(entries);

    assert.strictEqual(verdicts['nvidia-nim'].verdict, mod.VERDICT.NO_EVALUABLE,
        'invariante 2 del body: sin dato evaluable es "no evaluable", jamas "no aporta"');
});

// -----------------------------------------------------------------------------
// "Sin dato" nunca es "no aporta"
// -----------------------------------------------------------------------------

test('un proveedor sin muestra suficiente queda no_evaluable y nunca candidato a baja', () => {
    const entries = [
        // cerebras: sano, sostiene la cadena.
        ...many(200, 'fallback_selected', 'cerebras'),
        // nvidia-nim: 99 evaluables < min_sample=100, y 0 aportes.
        ...manyBlocked(99, 'nvidia-nim'),
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
    // rev-2 (#6145) — el review probó que este test NO asertaba lo que su nombre
    // promete: verificaba `contributionRate < 0.05`, o sea que la tasa SÍ bajaba.
    // El body del issue es explícito: "un gateo durable por observabilidad NO baja
    // la tasa de aporte: va a la columna bloqueo_observabilidad". Ahora el gateo
    // por causa NUESTRA queda fuera del denominador y el test asserta el número.
    const entries = [
        ...many(300, 'fallback_selected', 'cerebras'),   // sostiene la cadena
        // gemini: 120 aportes + 30 bloqueos imputables al proveedor => 150
        // evaluables reales, 80 % de tasa. Los 1.000 gateos por un flag de
        // entorno NUESTRO no entran al denominador.
        ...many(120, 'fallback_selected', 'gemini-google'),
        ...manyBlocked(30, 'gemini-google'),
        ...many(1000, 'fallback_health_gated', 'gemini-google', {
            health_state: 'red',
            health_reason: 'cli_license_unavailable',
        }),
    ];
    const { metrics, verdicts } = evaluate(entries);
    const g = metrics['gemini-google'];

    // Lo que el nombre promete, asertado de verdad:
    assert.strictEqual(g.gatedByLocalObservability, 1000, 'los gateos propios se cuentan aparte');
    assert.strictEqual(g.evaluables, 150, 'el denominador excluye el gateo por causa nuestra');
    assert.strictEqual(g.contributionRate, 120 / 150);
    assert.ok(
        g.contributionRate >= THRESHOLDS.min_contribution_rate,
        'la tasa NO baja del umbral: el gateo propio no se le imputa al proveedor',
    );
    // Contraste explícito: con el gateo dentro del denominador la tasa habría
    // sido 120/1150 = 10,4 %, muy por debajo de la real.
    assert.ok(120 / 1150 < g.contributionRate, 'incluir el gateo propio deprimiría la tasa');

    assert.strictEqual(g.dominantBlock, 'observabilidad_local', 'la columna propia se mantiene');
    assert.strictEqual(verdicts['gemini-google'].verdict, mod.VERDICT.MANTENER);
    assert.notStrictEqual(verdicts['gemini-google'].verdict, mod.VERDICT.CANDIDATO_BAJA);
});

test('el techo rol_acotado sigue tapando la baja si aun asi la tasa queda baja', () => {
    // Segunda línea de defensa del riesgo 3: aunque el gateo propio ya no entra
    // al denominador, si el proveedor igual rinde poco Y su bloqueo dominante es
    // de causa nuestra, el veredicto se topa en `rol_acotado`. Nunca se propone
    // la baja sin corregir antes el chequeo.
    const entries = [
        ...many(300, 'fallback_selected', 'cerebras'),   // sostiene la cadena
        ...many(2, 'fallback_selected', 'gemini-google'),
        ...manyBlocked(200, 'gemini-google'),
        ...many(1000, 'fallback_health_gated', 'gemini-google', {
            health_state: 'red',
            health_reason: 'cli_license_unavailable',
        }),
    ];
    const { metrics, verdicts } = evaluate(entries);

    assert.ok(metrics['gemini-google'].contributionRate < 0.05, 'la tasa sí quedó baja');
    assert.strictEqual(metrics['gemini-google'].dominantBlock, 'observabilidad_local');
    assert.strictEqual(
        verdicts['gemini-google'].verdict,
        mod.VERDICT.ROL_ACOTADO,
        'techo rol_acotado: no se propone la baja sin corregir antes el chequeo',
    );
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
        ...manyBlocked(500, 'nvidia-nim'),
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
        ...manyBlocked(500, 'cerebras'),
    ];
    const { metrics, verdicts } = evaluate(entries, { declared });

    assert.ok(metrics.cerebras.contributionRate < 0.05, 'la tasa cruda justifica el candidato');
    assert.strictEqual(verdicts.cerebras.verdict, mod.VERDICT.ROL_ACOTADO);
    assert.strictEqual(verdicts.cerebras.chainInvariantApplied, true);
    assert.match(verdicts.cerebras.reasons.join(' '), /invariante de cadena minima/);
});

// -----------------------------------------------------------------------------
// rev-2 (#6145) — BLOQUEANTE 1 del review: el invariante de cadena mínima
// tiene que proteger a la cadena que el criterio PUEDE tocar (los gratuitos).
// Estos tests usan el `declared` REAL de producción, no un sintético de uno.
// -----------------------------------------------------------------------------

test('el invariante de cadena minima no lo satisfacen los pagos de forma vacua', () => {
    // Configuración EXACTA de producción: 2 pagos + 3 gratuitos. Los 3 gratuitos
    // por debajo del umbral. En rev-1 los 2 pagos contaban como "sobrevivientes"
    // (son `mantener` por construcción), el contador nunca bajaba de
    // min_survivors=1 y el criterio proponía vaciar la cadena de gratuitos
    // ENTERA de una sola vez: el incidente del 19/08 auto-infligido.
    const entries = [
        // gemini: 5 aportes sobre 505 evaluables, bloqueo imputable al proveedor.
        ...many(5, 'fallback_selected', 'gemini-google'),
        ...many(500, 'fallback_health_gated', 'gemini-google', {
            health_state: 'red', health_reason: 'quota_exhausted',
        }),
        ...many(5, 'fallback_selected', 'cerebras'),
        ...manyBlocked(500, 'cerebras'),
        ...many(5, 'fallback_selected', 'nvidia-nim'),
        ...manyBlocked(500, 'nvidia-nim'),
        // Los pagos, con muestra de sobra y aporte alto.
        ...many(500, 'fallback_selected', 'anthropic'),
        ...many(500, 'fallback_selected', 'openai-codex'),
    ];
    const { metrics, verdicts } = evaluate(entries);

    for (const free of ['gemini-google', 'cerebras', 'nvidia-nim']) {
        assert.ok(metrics[free].contributionRate < 0.05, `${free}: la tasa cruda justifica el candidato`);
        assert.strictEqual(
            verdicts[free].verdict,
            mod.VERDICT.ROL_ACOTADO,
            `${free}: el invariante lo revierte, no se marca`,
        );
        assert.strictEqual(verdicts[free].chainInvariantApplied, true);
        assert.match(verdicts[free].reasons.join(' '), /invariante de cadena minima/);
    }

    const candidatos = Object.values(verdicts).filter((v) => v.verdict === mod.VERDICT.CANDIDATO_BAJA);
    assert.deepStrictEqual(candidatos, [], 'NINGÚN candidato: la cadena de gratuitos no se vacía');

    // Y los pagos siguen intactos, sin poder acreditarse la supervivencia.
    assert.strictEqual(verdicts.anthropic.verdict, mod.VERDICT.MANTENER);
    assert.strictEqual(verdicts['openai-codex'].verdict, mod.VERDICT.MANTENER);
    assert.strictEqual(verdicts.anthropic.chainInvariantApplied, undefined);
});

test('con gratuitos sanos de sobra el criterio si marca al que no aporta', () => {
    // Contracara del test anterior: sin este, el invariante podría estar
    // bloqueando SIEMPRE y el criterio no marcaría nunca a nadie (CA-6 vacío).
    const entries = [
        ...many(500, 'fallback_selected', 'gemini-google'),   // aporta
        ...many(500, 'fallback_selected', 'cerebras'),        // aporta
        ...many(5, 'fallback_selected', 'nvidia-nim'),        // no aporta
        ...manyBlocked(500, 'nvidia-nim'),
        ...many(500, 'fallback_selected', 'anthropic'),
        ...many(500, 'fallback_selected', 'openai-codex'),
    ];
    const { verdicts } = evaluate(entries);

    assert.strictEqual(verdicts['gemini-google'].verdict, mod.VERDICT.MANTENER);
    assert.strictEqual(verdicts.cerebras.verdict, mod.VERDICT.MANTENER);
    assert.strictEqual(
        verdicts['nvidia-nim'].verdict,
        mod.VERDICT.CANDIDATO_BAJA,
        'quedan 2 gratuitos sanos: el invariante no aplica y el criterio marca',
    );
    assert.strictEqual(verdicts['nvidia-nim'].chainInvariantApplied, undefined);
});

test('min_survivors alto exige mas gratuitos sanos antes de marcar a nadie', () => {
    // Mismo escenario que el anterior pero pidiendo 3 sobrevivientes gratuitos:
    // sólo hay 2, así que el candidato se revierte.
    const entries = [
        ...many(500, 'fallback_selected', 'gemini-google'),
        ...many(500, 'fallback_selected', 'cerebras'),
        ...many(5, 'fallback_selected', 'nvidia-nim'),
        ...manyBlocked(500, 'nvidia-nim'),
        ...many(500, 'fallback_selected', 'anthropic'),
        ...many(500, 'fallback_selected', 'openai-codex'),
    ];
    const { verdicts } = evaluate(entries, { thresholds: { ...THRESHOLDS, min_survivors: 3 } });

    assert.strictEqual(verdicts['nvidia-nim'].verdict, mod.VERDICT.ROL_ACOTADO);
    assert.strictEqual(verdicts['nvidia-nim'].chainInvariantApplied, true);
});

// -----------------------------------------------------------------------------
// rev-2 (#6145) — taxonomía completa de eventos
// -----------------------------------------------------------------------------

test('el kill-switch del operador no le baja la tasa de aporte al proveedor', () => {
    // `provider_disabled` es una decisión NUESTRA (kill-switch #3811), igual que
    // la ventana horaria. Contarlo en el denominador mediría al operador.
    const entries = [
        ...many(300, 'fallback_selected', 'cerebras'),
        ...many(100, 'fallback_selected', 'nvidia-nim'),
        ...many(900, 'provider_disabled', 'x', { primary_provider: 'nvidia-nim' }),
    ];
    const m = mod.computeContribution(entries, { now: NOW })['nvidia-nim'];

    assert.strictEqual(m.gatedByOperator, 900, 'se cuenta aparte, imputado al primario');
    assert.strictEqual(m.evaluables, 100, 'fuera del denominador');
    assert.strictEqual(m.contributionRate, 1);
    assert.strictEqual(m.attempts, 1000, 'pero sigue visible en los intentos totales');
});

test('el costo de failover reconcilia con las entradas leidas, sin eventos huerfanos', () => {
    // rev-2: el review encontró 261 eventos que quedaban FUERA del total y por lo
    // tanto fuera de los porcentajes, sin que el reporte lo mencionara.
    const entries = [
        ...many(10, 'fallback_selected', 'cerebras'),
        ...many(5, 'primary_inactive_by_schedule', 'x', { primary_provider: 'anthropic' }),
        ...many(3, 'gated_no_fallbacks', 'x', { primary_provider: 'anthropic' }),
        ...many(2, 'provider_disabled', 'x', { primary_provider: 'anthropic' }),
        ...many(7, 'evento_del_futuro_que_nadie_declaro', 'cerebras'),
    ];
    const fc = mod.computeFailoverCost(entries);

    assert.strictEqual(fc.totalEvents, 27, 'el total cuenta TODAS las entradas leídas');
    assert.strictEqual(fc.unclassified.events, 7);
    assert.deepStrictEqual({ ...fc.unclassified.byEvent }, { evento_del_futuro_que_nadie_declaro: 7 });
    assert.strictEqual(fc.operatorGating.events, 2);
    assert.strictEqual(fc.chainExhausted.events, 3, 'gated_no_fallbacks es evento de cadena');
    assert.strictEqual(fc.reconciles, true, 'los buckets cierran contra el total');
});

test('una ventana vacia se reporta como sin datos, nunca como cadena rota', () => {
    // rev-2: con 0 archivos el reporte decía "la cadena de hash no verificó
    // (0 archivo/s con integridad rota)" — una frase autocontradictoria.
    const declared = { cerebras: { billing: 'free', declaredInConfig: true } };
    const verdicts = mod.evaluatePermanence({}, THRESHOLDS, {
        chainOk: false, noData: true, declared, now: NOW,
    });
    assert.strictEqual(verdicts.cerebras.verdict, mod.VERDICT.NO_EVALUABLE);
    assert.match(verdicts.cerebras.reasons.join(' '), /sin datos en la ventana/);
    assert.ok(!verdicts.cerebras.reasons.join(' ').includes('rota'), 'no habla de corrupción');

    const rota = mod.evaluatePermanence({}, THRESHOLDS, {
        chainOk: false, noData: false, declared, now: NOW,
    });
    assert.match(rota.cerebras.reasons.join(' '), /cadena de hash rota/);
});

test('un proveedor pago nunca es candidato a baja', () => {
    const entries = [
        ...many(300, 'fallback_selected', 'cerebras'),
        // openai-codex: 1 aporte sobre 1001 evaluables, último aporte hace 40 días.
        ...many(1, 'fallback_selected', 'openai-codex', { created_at: NOW - 40 * DAY }),
        ...manyBlocked(1000, 'openai-codex'),
    ];
    const { verdicts } = evaluate(entries);

    assert.strictEqual(verdicts['openai-codex'].verdict, mod.VERDICT.MANTENER);
    assert.match(verdicts['openai-codex'].reasons.join(' '), /pago/);
});

test('un proveedor sin ningun aporte en la ventana queda marcado como candidato con evidencia', () => {
    const entries = [
        ...many(500, 'fallback_selected', 'cerebras'),
        ...manyBlocked(500, 'nvidia-nim'),   // cero wins
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
        ...manyBlocked(100, 'nvidia-nim'),
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
        ...manyBlocked(500, 'kimi-moonshot'),
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
        ts: '2026-08-19T11:41:13.000Z',
        providers: [
            { provider: 'gemini-google', state: 'red', reason_code: 'cli_license_unavailable', latency_ms: null },
            { provider: 'cerebras', state: 'green', reason_code: 'authenticated', latency_ms: 674 },
        ],
    };
    const metrics = mod.computeContribution(
        [...entries, ...many(10, 'fallback_selected', 'cerebras')],
        { now: NOW, healthSnapshot },
    );

    assert.strictEqual(metrics['gemini-google'].lastPingMs, null);
    assert.strictEqual(metrics['gemini-google'].lastPingReason, mod.ABSENCE.NO_INSTRUMENTADO);
    assert.strictEqual(metrics.cerebras.lastPingMs, 674);
    assert.strictEqual(metrics.cerebras.lastPingReason, null);
    assert.strictEqual(metrics.cerebras.lastPingAt, '2026-08-19T11:41:13.000Z', 'el dato viaja fechado');
});

test('la columna de latencia se llama ultimo live-ping y no mediana', () => {
    // rev-2 (#6145) — BLOQUEANTE 2 del review. `health.latency_ms` es UN ping
    // puntual, no un agregado de la ventana: el review midió 15,9 s / 2,3 s /
    // 1,26 s para el mismo proveedor el mismo día. Rotularlo "latencia mediana"
    // era una afirmación falsa sobre el dato — y el doc apoyaba una
    // recomendación en él. El rótulo ahora dice lo que el dato es.
    const healthSnapshot = {
        ts: '2026-08-19T11:41:13.000Z',
        providers: [{ provider: 'cerebras', state: 'green', reason_code: 'authenticated', latency_ms: 674 }],
    };
    const metrics = mod.computeContribution(many(10, 'fallback_selected', 'cerebras'), { now: NOW, healthSnapshot });
    const header = mod.renderMarkdownTable(metrics, {}).split('\n')[0];

    assert.ok(header.includes('Último live-ping'), 'la columna se llama por lo que es');
    assert.ok(header.includes('no es mediana'), 'y aclara explícitamente que no es una mediana');
    assert.ok(!/Latencia mediana/i.test(header), 'el rótulo falso de rev-1 ya no está');
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
    ];

    // rev-2 (#6145) — el review probó que este test era tautológico: pre-proyectaba
    // las entradas ANTES de alimentar el reporte, así que los asserts sobre el
    // serializado no probaban nada (el secreto ya se había removido). Ahora el
    // camino es el REAL: entradas CRUDAS, con `raw_excerpt`, directo a
    // computeContribution / renderMarkdownTable.
    for (const e of entries.map((x) => mod.projectEntry(x))) {
        assert.ok(!('raw_excerpt' in e), 'raw_excerpt no cruza la whitelist');
        assert.ok(!('chain_tried' in e), 'chain_tried no cruza la whitelist');
        assert.ok(!('issue' in e), 'issue no cruza la whitelist');
    }

    assert.ok(entries.some((e) => e.raw_excerpt === SECRETO), 'las entradas de entrada SÍ traen el secreto');
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
