'use strict';

// Tests de la propuesta pura (#7520 CA-26 / CA-UX-5 / SEC-16 / P9).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const proposalMod = require('../proposal');
const { buildReport } = require('../report');
const rec = require('../recommender');
const redact = require('../../redact');

const { VERDICT, RIESGO } = rec;
const { buildProposal, buildTitulo, validateProposal, PROPOSAL_KEYS, NIVEL } = proposalMod;

const FROM = Date.parse('2026-08-22T00:00:00.000Z');
const TO = Date.parse('2026-09-21T00:00:00.000Z');
const VENTANA = { from: FROM, to: TO, dias: 30 };
const VENTANA_ISO = { from: '2026-08-22T00:00:00.000Z', to: '2026-09-21T00:00:00.000Z', dias: 30 };

function evidencia(over = {}) {
    return {
        ahorro_mensual_estimado_usd: null, alertas_calidad: [], costo_filas_excluidas: 0, costo_reproceso_usd: null,
        costo_ventana_usd: null, difiere: false, modelo_declarado: 'claude-sonnet-4-6', modelo_destino: null,
        modelo_efectivo: 'claude-sonnet-4-6', modelos_observados: { 'anthropic|claude-sonnet-4-6': 40 }, motivo: [],
        n: 40, no_observados: 0, riesgo_estimado: RIESGO.NO_APLICA, ventana: VENTANA_ISO, ...over,
    };
}
function tasas(over = {}) {
    return { reboundRate: 0.01, earlyDeathRate: 0, qaFailRate: 0, retriesPerIssue: 1, durationP50Ms: 1000, durationP95Ms: 2000, ...over };
}
function umbrales() {
    return rec.recommend({ quality: { skills: {} }, cost: { evaluable: false, rows: [] }, models: [], pricing: { pricingByProvider: () => ({}) }, agentModels: {}, config: {}, propagationEnabled: false, allowedSkills: new Set(), allowedProviders: new Set(), providerAlias: {}, ventana: VENTANA }).umbrales;
}

/** Reporte con un `subir` (guru), un `bajar` (doc) y hallazgo de precios. */
function fixture({ skills, calidad, freshness, propagationEnabled = false } = {}) {
    const verdicts = {
        skills: skills || {
            guru: { veredicto: VERDICT.SUBIR, evidencia: evidencia({ alertas_calidad: ['rebound_alto'], motivo: ['rebound_alto'], modelo_destino: 'claude-opus-4-6' }) },
            doc: { veredicto: VERDICT.BAJAR, evidencia: evidencia({ motivo: ['calidad_ok_costo_menor'], modelo_destino: 'claude-haiku-4-5', ahorro_mensual_estimado_usd: 8.333, riesgo_estimado: RIESGO.NO_CUANTIFICABLE_SIN_OBSERVACION }) },
            po: { veredicto: VERDICT.NO_EVALUABLE, evidencia: evidencia({ motivo: ['modelo_sin_precio'], modelo_efectivo: 'claude-opus-5', n: 584 }) },
            security: { veredicto: VERDICT.MANTENER, evidencia: evidencia({ motivo: ['skill_protegido'], n: 421 }) },
        },
        advertencias: propagationEnabled ? [] : ['propagacion_apagada'],
        desconocidos: {},
        umbrales: umbrales(),
    };
    const quality = { skills: calidad || { guru: tasas({ reboundRate: 0.35 }), doc: tasas({ reboundRate: 0 }), po: tasas(), security: tasas() } };
    return buildReport({
        verdicts, quality,
        freshness: freshness || { stale: true, motivo: 'antiguedad', missing_models: [{ provider: 'anthropic', model: 'claude-opus-5', n: 2801 }], sha256: 'b'.repeat(64), version: 1, updated_at: '2026-05-08T00:00:00Z', source_kind: 'json' },
        ventana: VENTANA,
        integridad: { spawn_exit: 'verificada', rebound_events: 'no_verificada', label_mutations: 'no_verificada', provider_cost: 'no_verificada', effective_model: 'no_verificada', broken_files: 0, rebound_measurable: true, cost_evaluable: true, cost_reason: null },
        propagationEnabled,
        agentModelsSha256: 'a'.repeat(64),
        generatedAt: TO,
    });
}

const soloSkills = (skills) => ({ ...skills });
const alDia = { stale: false, motivo: null, missing_models: [], sha256: 'b'.repeat(64), version: 1, updated_at: '2026-09-01T00:00:00Z', source_kind: 'json' };

function walkStrings(obj, out = []) {
    if (typeof obj === 'string') out.push(obj);
    else if (obj && typeof obj === 'object') for (const v of Object.values(obj)) walkStrings(v, out);
    return out;
}

// ---------------------------------------------------------------------------
test('CA-26 / CA-UX-5 · forma completa: claves cerradas, sin productor ni campos de presentación', () => {
    const r = fixture();
    const p = buildProposal(r, { referencia: r.sha256, propagationEnabled: false });
    assert.deepEqual(Object.keys(p).sort(), [...PROPOSAL_KEYS]);
    assert.deepEqual(Object.keys(p.evidencia).sort(), ['referencia', 'resumen', 'tipo']);
    assert.equal(p.tipo, 'cambio-de-configuracion');
    assert.equal(p.evidencia.tipo, 'metrica');
    assert.equal(p.evidencia.referencia, r.sha256);
    assert.equal(p.sensible, false);
    for (const k of ['productor', 'parse_mode', 'chat_id', 'reply_markup', 'voice', 'text']) assert.equal(k in p, false, k);
    assert.equal(proposalMod.PRODUCTOR, 'auditor-modelos');
    assert.ok(p.evidencia.resumen.length <= 500);
    assert.ok(p.beneficio.length <= 300);
    assert.ok(p.accion.length <= 200);
    assert.deepEqual(validateProposal(p), { ok: true, reason: null });
});

test('CA-UX-3.1 · titulo === buildTitulo(report), 57 chars, dentro de 12–90, sin markdown ni URL', () => {
    const r = fixture();
    const p = buildProposal(r, { referencia: r.sha256 });
    assert.equal(p.titulo, buildTitulo(r));
    assert.equal(p.titulo, 'Auditoría de modelos por agente · 2026-08-22 → 2026-09-21');
    assert.equal(p.titulo.length, 57);
    assert.ok(p.titulo.length >= 12 && p.titulo.length <= 90);
    assert.ok(!/[\n*_]|http/i.test(p.titulo));
});

test('SEC-16 · titulo de 91 chars, < 12, con _, *, salto de línea o http ⇒ ok:false', () => {
    const r = fixture();
    const base = buildProposal(r, { referencia: r.sha256 });
    const casos = [
        ['x'.repeat(91), 'titulo_fuera_de_rango'],
        ['corto', 'titulo_fuera_de_rango'],
        ['Auditoría de modelos_por agente', 'titulo_invalido'],
        ['Auditoría de *modelos* por agente', 'titulo_invalido'],
        ['Auditoría de modelos\npor agente', 'titulo_invalido'],
        ['Auditoría http://x.y de modelos', 'titulo_invalido'],
        ['Auditoría de modelos HTTPS por agente', 'titulo_invalido'],
    ];
    for (const [titulo, reason] of casos) {
        const v = validateProposal({ ...base, titulo });
        assert.equal(v.ok, false, titulo);
        assert.equal(v.reason, reason, titulo);
    }
});

test('SEC-16 · costo.nivel "alto " (con espacio) o fuera del enum ⇒ rechazo; detalle fuera de forma ⇒ rechazo', () => {
    const r = fixture();
    const base = buildProposal(r, { referencia: r.sha256 });
    assert.equal(validateProposal({ ...base, costo: { nivel: 'alto ' } }).ok, false);
    assert.equal(validateProposal({ ...base, costo: { nivel: 'crítico' } }).ok, false);
    assert.equal(validateProposal({ ...base, riesgo: { nivel: 'bajo', detalle: 'con\nsalto' } }).ok, false);
    assert.equal(validateProposal({ ...base, riesgo: { nivel: 'bajo', extra: 1 } }).ok, false);
    assert.equal(validateProposal({ ...base, riesgo: { nivel: 'alto', detalle: 'ok' } }).ok, true);
    assert.deepEqual([...NIVEL], ['bajo', 'medio', 'alto']);
    assert.ok(Object.isFrozen(NIVEL));
});

test('SEC-16 · claves extra, tipo distinto, sensible true, referencia no hex ⇒ rechazo', () => {
    const r = fixture();
    const base = buildProposal(r, { referencia: r.sha256 });
    assert.equal(validateProposal({ ...base, productor: 'auditor-modelos' }).reason, 'claves_invalidas');
    assert.equal(validateProposal({ ...base, tipo: 'otro' }).reason, 'tipo_invalido');
    assert.equal(validateProposal({ ...base, sensible: true }).reason, 'sensible_invalido');
    assert.equal(validateProposal({ ...base, evidencia: { ...base.evidencia, referencia: 'zz' } }).reason, 'referencia_invalida');
    assert.equal(validateProposal({ ...base, evidencia: { ...base.evidencia, extra: 1 } }).reason, 'evidencia_invalida');
    assert.equal(validateProposal(null).ok, false);
    assert.equal(validateProposal([]).ok, false);
});

test('P9 · mapeo cerrado: bajar ⇒ costo bajo / riesgo medio sin propagación (detalle fijo), bajo con propagación', () => {
    const r = fixture();
    const soloBajar = { doc: r.skills.doc };
    const rep = fixture({ skills: soloSkills(soloBajar), freshness: alDia });
    const sin = buildProposal(rep, { referencia: rep.sha256, propagationEnabled: false });
    assert.deepEqual(sin.costo, { nivel: 'bajo' });
    assert.deepEqual(sin.riesgo, { nivel: 'medio', detalle: 'no cuantificable — sin observación del modelo destino' });
    assert.equal(sin.accion, 'bajar de modelo a doc');
    const con = buildProposal(fixture({ skills: soloSkills(soloBajar), freshness: alDia, propagationEnabled: true }), { referencia: rep.sha256, propagationEnabled: true });
    assert.deepEqual(con.costo, { nivel: 'bajo' });
    assert.deepEqual(con.riesgo, { nivel: 'bajo' });
});

test('P9 · subir ⇒ costo medio / riesgo bajo; sólo precios ⇒ bajo/bajo y accion = refrescar la tabla (#7507)', () => {
    const r = fixture();
    const subir = buildProposal(fixture({ skills: { guru: r.skills.guru }, freshness: alDia }), { referencia: r.sha256 });
    assert.deepEqual(subir.costo, { nivel: 'medio' });
    assert.deepEqual(subir.riesgo, { nivel: 'bajo' });
    assert.equal(subir.accion, 'subir de modelo a guru');
    assert.match(subir.beneficio, /^reduce rebote 35,0 % de guru$/);

    const precios = buildProposal(fixture({ skills: { security: r.skills.security, po: r.skills.po } }), { referencia: r.sha256 });
    assert.deepEqual(precios.costo, { nivel: 'bajo' });
    assert.deepEqual(precios.riesgo, { nivel: 'bajo' });
    assert.equal(precios.accion, proposalMod.ACCION_PRECIOS);
    assert.equal(precios.accion, 'refrescar pricing' + '.json (#7507)');
    assert.equal(precios.beneficio, 'vuelve evaluables los agentes sin precio');
    assert.match(precios.evidencia.resumen, /tabla de precios vencida; sin precio para claude-opus-5 \(2\.801 corridas\)/);
});

test('CA-27 · varios ítems ⇒ una sola accion "revisar N sugerencias: …" ≤ 200 y costo/riesgo = el mayor de cada eje', () => {
    const r = fixture();
    const p = buildProposal(r, { referencia: r.sha256, propagationEnabled: false });
    assert.equal(p.accion, 'revisar 2 sugerencias: subir guru, bajar doc; refrescar pricing' + '.json');
    assert.deepEqual(p.costo, { nivel: 'medio' });
    assert.equal(p.riesgo.nivel, 'medio');
    assert.equal(p.beneficio, 'ahorra ~8,33 USD por mes en doc; reduce rebote 35,0 % de guru; vuelve evaluables los agentes sin precio');
    assert.equal(p.evidencia.resumen, '4 agentes evaluados; subir de modelo: guru; bajar de modelo: doc; tabla de precios vencida; sin precio para claude-opus-5 (2.801 corridas)');
});

test('SEC-16 · ningún campo contiene \\n, /, \\\\ ni matchea SECRET_VALUE_PATTERNS; el validador lo rechazaría', () => {
    const r = fixture();
    const p = buildProposal(r, { referencia: r.sha256 });
    for (const s of walkStrings(p)) {
        assert.ok(!/[\n\r/\\]/.test(s), `campo con caracteres prohibidos: ${s}`);
        for (const { re } of redact.SECRET_VALUE_PATTERNS) {
            re.lastIndex = 0;
            assert.ok(!re.test(s), `campo con forma de secreto: ${s}`);
        }
    }
    // Un valor con forma de clave AWS colado en el resumen ⇒ rechazo.
    const aws = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    assert.equal(validateProposal({ ...p, evidencia: { ...p.evidencia, resumen: `ok ${aws}` } }).reason, 'resumen_invalido');
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'abc'].join('.');
    assert.equal(validateProposal({ ...p, beneficio: `ok ${jwt}` }).reason, 'beneficio_invalido');
    assert.equal(validateProposal({ ...p, accion: 'con/barra' }).reason, 'accion_invalida');
    assert.equal(validateProposal({ ...p, accion: 'con\\barra' }).reason, 'accion_invalida');
});

test('SEC-16 · mismo reporte ⇒ misma referencia; un char distinto en el reporte ⇒ referencia distinta', () => {
    const a = fixture();
    const b = fixture();
    assert.equal(a.sha256, b.sha256);
    assert.equal(buildProposal(a, { referencia: a.sha256 }).evidencia.referencia, buildProposal(b, { referencia: b.sha256 }).evidencia.referencia);
    const c = fixture({ freshness: { stale: true, motivo: 'antiguedad', missing_models: [{ provider: 'anthropic', model: 'claude-opus-5', n: 2802 }], sha256: 'b'.repeat(64), version: 1, updated_at: '2026-05-08T00:00:00Z', source_kind: 'json' } });
    assert.notEqual(c.sha256, a.sha256);
    // Sin `referencia` explícita, cae al sha256 del reporte.
    assert.equal(buildProposal(c, {}).evidencia.referencia, c.sha256);
    // Con `registrar: true` la referencia es el hash_self del audit, no el del reporte.
    const hash = crypto.createHash('sha256').update('audit').digest('hex');
    assert.equal(buildProposal(a, { referencia: hash }).evidencia.referencia, hash);
});

test('SEC-12 · un skill con id fuera de forma o un modelo que no pasa safeModel no se nombran', () => {
    const r = fixture();
    const raro = { ...r, skills: { ...r.skills, 'Skill Raro!': { veredicto: 'subir', evidencia: evidencia({ alertas_calidad: ['rebound_alto'] }) } } };
    const p = buildProposal(raro, { referencia: r.sha256 });
    assert.ok(!walkStrings(p).some((s) => s.includes('Skill Raro')), 'skill fuera de forma no aparece');
    assert.equal(p.accion, 'revisar 2 sugerencias: subir guru, bajar doc; refrescar pricing' + '.json');
    const modeloRaro = fixture({ skills: { security: r.skills.security }, freshness: { ...alDia, stale: true, motivo: 'antiguedad', missing_models: [{ provider: 'anthropic', model: 'Modelo Con Espacios', n: 2 }] } });
    const q = buildProposal(modeloRaro, { referencia: r.sha256 });
    assert.ok(!walkStrings(q).some((s) => s.includes('Modelo Con Espacios')));
    assert.match(q.evidencia.resumen, /sin precio para sin dato \(2 corridas\)/);
});

test('buildProposal sin reporte lanza; recorta accion/resumen/beneficio a sus topes', () => {
    assert.throws(() => buildProposal(null, {}), /reporte requerido/);
    const muchos = {};
    for (let i = 0; i < 60; i++) muchos[`skill-${String(i).padStart(2, '0')}`] = { veredicto: VERDICT.BAJAR, evidencia: evidencia({ ahorro_mensual_estimado_usd: 1 + i }) };
    const rep = fixture({ skills: muchos, freshness: alDia });
    const p = buildProposal(rep, { referencia: rep.sha256 });
    assert.ok(p.accion.length <= 200);
    assert.ok(p.evidencia.resumen.length <= 500);
    assert.ok(p.beneficio.length <= 300);
    assert.deepEqual(validateProposal(p), { ok: true, reason: null });
});
