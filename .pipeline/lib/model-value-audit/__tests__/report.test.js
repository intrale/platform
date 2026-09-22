'use strict';

// =============================================================================
// report.test.js — JSON canónico + tabla humana (#7519, CA-R1 / R2 / R3 / CA-22).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const report = require('../report');
const rec = require('../recommender');
const { canonicalJsonStringify } = require('../../audit-log');
const handoff = require('../../handoff');

const { VERDICT, RIESGO, EVIDENCIA_KEYS } = rec;
const { VERDICT_LABEL, MOTIVO_LABEL, ABSENCE, buildReport, renderHuman } = report;

// eslint-disable-next-line no-control-regex
const CONTROL_O_ANSI = /[\x00-\x08\x0b-\x1f\x7f]|\x1b\[/;

const FROM = Date.parse('2026-08-22T00:00:00.000Z');
const TO = Date.parse('2026-09-21T00:00:00.000Z');
const VENTANA = { from: FROM, to: TO, dias: 30 };
const VENTANA_ISO = { from: '2026-08-22T00:00:00.000Z', to: '2026-09-21T00:00:00.000Z', dias: 30 };

function evidencia(over = {}) {
    const base = {
        ahorro_mensual_estimado_usd: null, alertas_calidad: [], costo_filas_excluidas: 0, costo_reproceso_usd: null,
        costo_ventana_usd: null, difiere: false, modelo_declarado: 'claude-sonnet-4-6', modelo_destino: null,
        modelo_efectivo: 'claude-sonnet-4-6', modelos_observados: { 'anthropic|claude-sonnet-4-6': 40 }, motivo: [],
        n: 40, no_observados: 0, riesgo_estimado: RIESGO.NO_APLICA, ventana: VENTANA_ISO,
    };
    return { ...base, ...over };
}

function tasas(over = {}) {
    return { reboundRate: 0.01, earlyDeathRate: 0, qaFailRate: 0, retriesPerIssue: 1, durationP50Ms: 1000, durationP95Ms: 2000, ...over };
}

function umbrales() {
    return rec.recommend({ quality: { skills: {} }, cost: { evaluable: false, rows: [] }, models: [], pricing: { pricingByProvider: () => ({}) }, agentModels: {}, config: {}, propagationEnabled: false, allowedSkills: new Set(), allowedProviders: new Set(), providerAlias: {}, ventana: VENTANA }).umbrales;
}

function fixture({ skills, calidad, advertencias = ['propagacion_apagada'], integridad, freshness, desconocidos } = {}) {
    const verdicts = {
        skills: skills || {
            guru: { veredicto: VERDICT.SUBIR, evidencia: evidencia({ alertas_calidad: ['rebound_alto'], motivo: ['rebound_alto'], modelo_destino: 'claude-opus-4-6', costo_reproceso_usd: 3.2, costo_ventana_usd: 21 }) },
            doc: { veredicto: VERDICT.BAJAR, evidencia: evidencia({ motivo: ['calidad_ok_costo_menor', 'propagacion_apagada'], modelo_destino: 'claude-haiku-4-5', costo_ventana_usd: 12.5, ahorro_mensual_estimado_usd: 8.333, riesgo_estimado: RIESGO.NO_CUANTIFICABLE_SIN_OBSERVACION }) },
            po: { veredicto: VERDICT.NO_EVALUABLE, evidencia: evidencia({ motivo: ['modelo_sin_precio'], modelo_efectivo: 'claude-opus-5', difiere: true, n: 584, no_observados: 12 }) },
            'pipeline-dev': { veredicto: VERDICT.NO_EVALUABLE, evidencia: evidencia({ motivo: ['modelo_sin_precio'], alertas_calidad: ['early_death_alto'], modelo_efectivo: 'claude-opus-5', modelo_declarado: 'claude-opus-4-7', difiere: true, n: 573 }) },
            architect: { veredicto: VERDICT.NO_EVALUABLE, evidencia: evidencia({ motivo: ['modelo_sin_precio'], modelo_efectivo: 'claude-opus-5', difiere: true, n: 324 }) },
            planner: { veredicto: VERDICT.SIN_EVIDENCIA, evidencia: evidencia({ motivo: ['muestra_insuficiente'], n: 4 }) },
            security: { veredicto: VERDICT.MANTENER, evidencia: evidencia({ motivo: ['skill_protegido'], modelo_declarado: 'claude-opus-4-7', modelo_efectivo: 'claude-opus-4-7', n: 421 }) },
            tester: { veredicto: VERDICT.MANTENER, evidencia: evidencia({ motivo: ['ya_en_el_mas_barato'], modelo_declarado: 'deterministic', modelo_efectivo: 'deterministic', costo_ventana_usd: 0, n: 900 }) },
            commander: { veredicto: VERDICT.MANTENER, evidencia: evidencia({ motivo: ['declarado_desconocido'], modelo_declarado: null, n: 900 }) },
            'web-dev': { veredicto: VERDICT.NO_EVALUABLE, evidencia: evidencia({ motivo: ['modelo_no_observado'], modelo_efectivo: null, modelos_observados: {}, no_observados: 30, n: 30 }) },
        },
        advertencias,
        desconocidos: desconocidos || { skills: 412, providers: 1777, models: 0, phases: 0 },
        umbrales: umbrales(),
    };
    const quality = {
        skills: calidad || {
            guru: tasas({ reboundRate: 0.35 }), doc: tasas(), po: tasas({ reboundRate: null }), 'pipeline-dev': tasas({ reboundRate: null, earlyDeathRate: 0.2216, qaFailRate: 0.0576 }),
            architect: tasas({ reboundRate: null }), planner: tasas({ reboundRate: null }), security: tasas(), tester: tasas(), commander: tasas({ qaFailRate: null }), 'web-dev': tasas({ reboundRate: null, earlyDeathRate: null, qaFailRate: null }),
        },
    };
    return buildReport({
        verdicts, quality,
        freshness: freshness || { stale: true, motivo: 'antiguedad', missing_models: [{ provider: 'anthropic', model: 'claude-opus-5', n: 2801 }], sha256: 'b'.repeat(64), version: 1, updated_at: '2026-05-08T00:00:00Z', source_kind: 'json' },
        ventana: VENTANA,
        integridad: integridad || { spawn_exit: 'verificada', rebound_events: 'no_verificada', label_mutations: 'no_verificada', provider_cost: 'no_verificada', effective_model: 'no_verificada', broken_files: 0, rebound_measurable: false, cost_evaluable: false, cost_reason: 'sin_ts' },
        propagationEnabled: false,
        agentModelsSha256: 'a'.repeat(64),
        generatedAt: TO,
    });
}

// ---------------------------------------------------------------------------
// CA-R1 · JSON canónico y sha256 reproducible
// ---------------------------------------------------------------------------
test('CA-R1 · buildReport produce las claves esperadas, ordenadas, y sha256 == recalculo sin sha256 (C13 / SEC-R3)', () => {
    const r = fixture();
    assert.deepEqual(Object.keys(r), [
        'advertencias', 'agent_models_sha256', 'calidad', 'desconocidos', 'generado_en', 'integridad', 'precios',
        'propagation_enabled', 'sha256', 'skills', 'umbrales', 'ventana', 'version',
    ]);
    assert.equal(r.version, 1);
    assert.equal(r.generado_en, '2026-09-21T00:00:00.000Z');
    assert.deepEqual(r.ventana, VENTANA_ISO);
    assert.equal(r.propagation_enabled, false);
    assert.deepEqual(r.advertencias, ['propagacion_apagada']);
    assert.deepEqual(Object.keys(r.precios), ['missing_models', 'motivo', 'sha256', 'stale', 'updated_at', 'version']);
    assert.deepEqual(r.precios.missing_models, [{ model: 'claude-opus-5', n: 2801, provider: 'anthropic' }]);
    assert.equal(r.agent_models_sha256, 'a'.repeat(64));
    assert.match(r.sha256, /^[0-9a-f]{64}$/);

    const { sha256, ...sin } = r;
    const recalculado = crypto.createHash('sha256').update(canonicalJsonStringify(sin), 'utf8').digest('hex');
    assert.equal(recalculado, sha256);
    // Idempotente sobre el stringify estándar del objeto (claves ya en orden).
    assert.equal(JSON.stringify(r), canonicalJsonStringify(r));
    // Y reproducible: dos corridas iguales ⇒ mismo sha.
    assert.equal(fixture().sha256, sha256);
    // Evidencia por skill intacta (15 claves).
    for (const s of Object.values(r.skills)) assert.deepEqual(Object.keys(s.evidencia), [...EVIDENCIA_KEYS]);
    // Tasas por skill viajan aparte, sólo para los skills del reporte.
    assert.deepEqual(Object.keys(r.calidad).sort(), Object.keys(r.skills).sort());
    assert.equal(r.calidad.guru.reboundRate, 0.35);
    assert.equal(r.calidad.po.reboundRate, null);
});

test('CA-R1 · buildReport tolera entradas ausentes o basura sin lanzar', () => {
    const r = buildReport({});
    assert.equal(r.version, 1);
    assert.deepEqual(r.skills, {});
    assert.deepEqual(r.advertencias, []);
    assert.equal(r.precios.sha256, null);
    assert.equal(r.agent_models_sha256, null);
    assert.equal(r.ventana.from, null);
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
    const texto = renderHuman(r, { comando: 'node x' });
    assert.match(texto, /AUDITORÍA DE MODELOS POR AGENTE/);
    assert.match(texto, /sin muestra/);
});

// ---------------------------------------------------------------------------
// CA-R2 · cabecera, columnas, orden
// ---------------------------------------------------------------------------
test('CA-R2 · renderHuman completo: cabecera fija, 12 columnas, orden subir→bajar→no_evaluable→sin_evidencia→mantener; alertas primero', () => {
    const r = fixture();
    const texto = renderHuman(r, { comando: 'node .pipeline/scripts/model-value-report.js --dias=30 --hasta=2026-09-21' });
    const lineas = texto.split('\n');
    assert.match(lineas[1], /ventana 2026-08-22 → 2026-09-21 \(30 días · 3\.816 corridas\)/);
    assert.match(texto, / Regenerar: node \.pipeline\/scripts\/model-value-report\.js --dias=30 --hasta=2026-09-21/);
    assert.match(texto, /Precios: tabla v1 del 2026-05-08 \(tabla vencida por antigüedad\); sin precio para claude-opus-5 → 3 agente\/s no evaluable\/s \(#7507\)/);
    assert.match(texto, /Costo: no evaluable — hay filas de costo sin timestamp \(#6558\)/);
    assert.match(texto, /Rebotes: no medibles/);
    assert.match(texto, / Ojo: model_propagation\.enabled=false: el modelo declarado no se propaga; una sugerencia aceptada requiere encender el rollout \(#6274\)/);
    assert.ok(!/SEÑAL NO CONFIABLE/.test(texto));
    assert.match(texto, /Nada se cambió solo\. Un cambio de modelo es un PR sobre agent-models\.json\./);

    const head = lineas.find((l) => l.startsWith('| Skill |'));
    assert.equal(head, '| Skill | Declarado | Efectivo | Difiere | n | Rebote | Muerte temprana | QA fallido | Costo ventana | Ahorro mensual | Veredicto | Motivo |');
    const filas = lineas.filter((l) => /^\| [a-z-]+ \|/.test(l) && !l.startsWith('| Skill'));
    const orden = filas.map((l) => l.split('|')[1].trim());
    // subir → bajar → no_evaluable (con alerta primero, luego n desc) → sin_evidencia → mantener (n desc, skill asc)
    assert.deepEqual(orden, ['guru', 'doc', 'pipeline-dev', 'po', 'architect', 'web-dev', 'planner', 'commander', 'tester', 'security']);
    for (const f of filas) assert.equal(f.split('|').length, 14, `12 columnas: ${f}`);
    // Pie con contadores como metadatos, no columnas.
    assert.match(texto, /Corridas sin modelo observable: 42 · filas de costo excluidas: 0 · descartados por lista blanca: 2\.189 \(skills 412, proveedores 1\.777, modelos 0\)/);
    assert.match(texto, /Umbrales aplicados: subir si rebote ≥ 30,0 %/);
    assert.match(texto, /protegidos: po, qa, review, security, tester/);
});

test('CA-R2 · --compacto: 4 columnas, mismo orden, pie repite el hallazgo de precios', () => {
    const texto = renderHuman(fixture(), { compacto: true, comando: 'cmd' });
    const lineas = texto.split('\n');
    const head = lineas.find((l) => l.startsWith('| Skill |'));
    assert.equal(head, '| Skill | Modelo efectivo | Veredicto | n |');
    const filas = lineas.filter((l) => /^\| [a-z-]+ \|/.test(l) && !l.startsWith('| Skill'));
    assert.equal(filas.length, 10);
    for (const f of filas) assert.equal(f.split('|').length, 6, `4 columnas: ${f}`);
    assert.equal(filas[0].split('|')[1].trim(), 'guru');
    assert.match(texto, /Veredictos: subir de modelo: 1 · bajar de modelo: 1 · no evaluable: 4 · sin evidencia suficiente: 1 · mantener: 3/);
    assert.match(texto, /Sin precio para claude-opus-5: 3 agente\/s no evaluable\/s \(#7507\)/);
    assert.match(texto, /\| planner \| claude-sonnet-4-6 \| sin evidencia suficiente \| 4 \(< 10\) \|/);
    assert.ok(!/Motivo/.test(head));
});

test('CA-R2 · integridad rota ⇒ aviso dominante en la primera linea despues del titulo; la tabla se imprime igual', () => {
    const r = fixture({ integridad: { spawn_exit: 'rota', rebound_events: 'no_verificada', label_mutations: 'no_verificada', provider_cost: 'no_verificada', effective_model: 'no_verificada', broken_files: 2, rebound_measurable: true, cost_evaluable: true, cost_reason: null } });
    const lineas = renderHuman(r, { comando: 'cmd' }).split('\n');
    assert.match(lineas[2], /^ SEÑAL NO CONFIABLE — cadena de spawn-exit rota: ningún veredicto de esta tabla es accionable$/);
    assert.match(lineas.join('\n'), /Integridad: spawn-exit rota .*2 archivo\/s con cadena rota/);
    assert.match(lineas.join('\n'), /Costo: evaluable en la ventana/);
    assert.match(lineas.join('\n'), /Rebotes: medibles en toda la ventana/);
    assert.ok(lineas.some((l) => l.startsWith('| guru |')));
});

// ---------------------------------------------------------------------------
// CA-R3 · celdas
// ---------------------------------------------------------------------------
test('CA-R3 · ninguna celda vacia, null ≠ 0 %, literales de ausencia, VERDICT_LABEL exacto', () => {
    assert.deepEqual(VERDICT_LABEL, {
        bajar: 'bajar de modelo', subir: 'subir de modelo', mantener: 'mantener',
        sin_evidencia_suficiente: 'sin evidencia suficiente', no_evaluable: 'no evaluable',
    });
    assert.deepEqual(Object.keys(MOTIVO_LABEL).sort(), [...rec.MOTIVOS].sort(), 'un texto por cada codigo de MOTIVOS');
    for (const t of Object.values(MOTIVO_LABEL)) assert.ok(typeof t === 'string' && t.length > 0);
    assert.equal(MOTIVO_LABEL.skill_protegido, 'skill protegido: cambio sólo por decisión humana');
    assert.equal(MOTIVO_LABEL.ya_en_el_tope, 'ya en el modelo más caro del proveedor');
    assert.equal(report.RIESGO_LABEL.no_cuantificable_sin_observacion, 'no cuantificable — sin observación del modelo destino');

    // Fixture con todos los null posibles.
    const r = fixture({
        skills: {
            'web-dev': { veredicto: VERDICT.NO_EVALUABLE, evidencia: evidencia({ motivo: ['modelo_no_observado'], modelo_efectivo: null, modelo_declarado: null, modelos_observados: {}, no_observados: 30, n: 30 }) },
        },
        calidad: { 'web-dev': { reboundRate: null, earlyDeathRate: null, qaFailRate: null, retriesPerIssue: null, durationP50Ms: null, durationP95Ms: null } },
        freshness: { stale: false, motivo: null, missing_models: [], sha256: null, version: null, updated_at: null, source_kind: 'fallback' },
    });
    const texto = renderHuman(r, { comando: 'cmd' });
    const fila = texto.split('\n').find((l) => l.startsWith('| web-dev |'));
    const celdas = fila.split('|').slice(1, -1).map((c) => c.trim());
    assert.deepEqual(celdas, [
        'web-dev', ABSENCE.SIN_DECLARAR, ABSENCE.NO_OBSERVADO, 'no', '30', ABSENCE.SIN_DATO, ABSENCE.SIN_DATO, ABSENCE.SIN_DATO,
        ABSENCE.NO_EVALUABLE, ABSENCE.NO_CUANTIFICABLE, 'no evaluable', MOTIVO_LABEL.modelo_no_observado,
    ]);
    assert.ok(celdas.every((c) => c.length > 0));
    assert.ok(!/0,0 %/.test(fila), 'null nunca se muestra como 0 %');
    assert.match(texto, /Precios: tabla vsin dato del sin dato/);

    // Fixture completa: tasas, montos, difiere, reproceso y riesgo en Motivo.
    const full = renderHuman(fixture(), { comando: 'cmd' });
    const guru = full.split('\n').find((l) => l.startsWith('| guru |')).split('|').slice(1, -1).map((c) => c.trim());
    assert.deepEqual(guru.slice(0, 11), ['guru', 'claude-sonnet-4-6', 'claude-sonnet-4-6', 'no', '40', '35,0 %', '0,0 %', '0,0 %', '21,00 USD', 'no cuantificable', 'subir de modelo']);
    assert.equal(guru[11], 'rebote 35,0 % (umbral 30,0 %) · destino claude-opus-4-6 · reproceso estimado 3,20 USD en la ventana');
    const doc = full.split('\n').find((l) => l.startsWith('| doc |')).split('|').slice(1, -1).map((c) => c.trim());
    assert.equal(doc[8], '12,50 USD');
    assert.equal(doc[9], '8,33 USD');
    assert.equal(doc[11], 'calidad dentro de umbral y hay un modelo más barato: destino claude-haiku-4-5 · el modelo declarado no se propaga (#6274) · riesgo no cuantificable — sin observación del modelo destino');
    const pd = full.split('\n').find((l) => l.startsWith('| pipeline-dev |')).split('|').slice(1, -1).map((c) => c.trim());
    assert.equal(pd[3], 'sí');
    assert.equal(pd[11], 'muerte temprana 22,2 % (umbral 10,0 %) · el modelo no está en la tabla de precios (#7507)', 'alarma primero');
    const planner = full.split('\n').find((l) => l.startsWith('| planner |')).split('|').slice(1, -1).map((c) => c.trim());
    assert.equal(planner[4], '4 (< 10)');
    assert.equal(planner[11], 'muestra insuficiente (n = 4, mínimo 10)');
    const tester = full.split('\n').find((l) => l.startsWith('| tester |')).split('|').slice(1, -1).map((c) => c.trim());
    assert.equal(tester[8], '0,00 USD');
    assert.equal(tester[4], '900');
    // Sin motivo ⇒ literal de ausencia, nunca vacío.
    const vacio = renderHuman(fixture({ skills: { doc: { veredicto: VERDICT.MANTENER, evidencia: evidencia() } } }), { comando: 'cmd' });
    assert.match(vacio, /\| doc \| .* \| mantener \| sin observaciones \|/);
});

test('formatos copiados del hermano: fmtInt con miles, fmtRate una decimal con coma, fmtUsd dos decimales', () => {
    assert.equal(report.fmtInt(2656), '2.656');
    assert.equal(report.fmtInt(0), '0');
    assert.equal(report.fmtInt(null), ABSENCE.SIN_DATO);
    assert.equal(report.fmtRate(0.35), '35,0 %');
    assert.equal(report.fmtRate(0), '0,0 %');
    assert.equal(report.fmtRate(null), ABSENCE.SIN_DATO);
    assert.equal(report.fmtRate(NaN), ABSENCE.SIN_DATO);
    assert.equal(report.fmtUsd(12.345, 'x'), '12,35 USD');
    assert.equal(report.fmtUsd(null, 'x'), 'x');
    assert.equal(report.fmtDay('2026-09-21T10:00:00.000Z'), '2026-09-21');
    assert.equal(report.fmtDay(null), ABSENCE.SIN_DATO);
});

// ---------------------------------------------------------------------------
// CA-22 · última defensa
// ---------------------------------------------------------------------------
test('CA-22 · key AWS construida en runtime, ANSI y CRLF en skill, paths/excerpts en la fixture ⇒ ausentes de la salida', () => {
    const key = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const skillMalo = 'ux\x1b[31m\r\nX';
    const inyeccion = handoff.INJECTION_PATTERNS[0].source;
    const r = fixture({
        skills: {
            guru: { veredicto: VERDICT.SUBIR, evidencia: evidencia({ motivo: ['rebound_alto'], alertas_calidad: ['rebound_alto'], modelo_destino: `claude-opus-4-6 ${key}`, modelo_declarado: `nota ${key} fin`, raw_excerpt: 'stderr secreto', evidence: '/tmp/worktrees/agent-7519/x', issue: 'ISSUE-7519-TITULO' }) },
            [skillMalo]: { veredicto: VERDICT.MANTENER, evidencia: evidencia({ modelo_efectivo: `x\x1b[32m${inyeccion}`, n: 5 }) },
            doc: { veredicto: VERDICT.MANTENER, evidencia: evidencia({ modelo_efectivo: 'C:/Workspaces/Intrale/platform/.worktrees/agent-1', n: 3 }) },
        },
        calidad: { guru: tasas({ reboundRate: 0.35 }), [skillMalo]: tasas(), doc: tasas() },
        freshness: { stale: true, motivo: 'antiguedad', missing_models: [{ provider: 'anthropic', model: `claude-opus-5 ${key}`, n: 1 }], sha256: 'c'.repeat(64), version: 1, updated_at: '2026-05-08T00:00:00Z', source_kind: 'json' },
    });
    for (const compacto of [false, true]) {
        const texto = renderHuman(r, { compacto, comando: `node x --hasta=2026-09-21 ${key}` });
        assert.ok(!texto.includes(key), 'la key AWS no aparece');
        assert.ok(!CONTROL_O_ANSI.test(texto), 'sin control chars ni ANSI');
        assert.ok(!texto.includes('\r'), 'sin CR');
        assert.ok(!texto.includes(inyeccion), 'el patron de inyeccion no aparece');
        assert.ok(!/stderr secreto/.test(texto));
        assert.ok(!/ISSUE-7519-TITULO/.test(texto));
        assert.ok(!/worktrees?\//.test(texto), 'sin paths de worktrees');
        assert.ok(!/\/tmp\//.test(texto));
        assert.match(texto, /\[REDACTED\]/, 'el redactor central dejo marca');
        assert.match(texto, /\| ux\[31mX \|/, 'el skill sobrevive sin ESC/CR/LF (stripForOutput)');
    }
});

test('CA-22 · un sha256 hex de 64 chars y los ids de modelo sobreviven al redactor; el texto es reproducible', () => {
    const r = fixture();
    const a = renderHuman(r, { comando: 'cmd' });
    const b = renderHuman(r, { comando: 'cmd' });
    assert.equal(a, b);
    assert.match(a, /claude-opus-5/);
    assert.match(a, /claude-haiku-4-5/);
    assert.ok(!/\[REDACTED\]/.test(a), 'sin falsos positivos sobre una fixture limpia');
    assert.ok(!/HIGH_ENTROPY|\[HIGH-ENTROPY/.test(a));
});

test('SEC-R1 · Object.keys(report.skills) ⊆ skills validados y el render no interpola texto de entrada fuera de ids whitelisteados', () => {
    const r = fixture();
    const texto = renderHuman(r, { comando: 'cmd' });
    for (const skill of Object.keys(r.skills)) assert.match(texto, new RegExp(`\\| ${skill} \\|`));
    // Ningún código snake_case de motivo se filtra crudo a la tabla (sólo labels).
    for (const code of rec.MOTIVOS) {
        const filas = texto.split('\n').filter((l) => l.startsWith('| '));
        assert.ok(!filas.some((l) => l.includes(` ${code} `) || l.includes(`| ${code} |`)), `codigo crudo ${code} en la tabla`);
    }
});

test('sortRows · orden estable: grupo, alerta, n desc, skill asc', () => {
    const r = fixture();
    const orden = report.sortRows(r).map((x) => x.skill);
    assert.deepEqual(orden, ['guru', 'doc', 'pipeline-dev', 'po', 'architect', 'web-dev', 'planner', 'commander', 'tester', 'security']);
    assert.deepEqual(report.VERDICT_ORDER, ['subir', 'bajar', 'no_evaluable', 'sin_evidencia_suficiente', 'mantener']);
});
