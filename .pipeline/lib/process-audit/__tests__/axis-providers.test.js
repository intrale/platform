// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// #6809 H4 — eje proveedores: los tres Gherkin de cuota, el orden de descarte
// en la propuesta, el crédito como confusor, flag falso y schedule.

const test = require('node:test');
const assert = require('node:assert/strict');

const ax = require('../axis-providers');
const { construirPayload } = require('../publish');

const H = 3600 * 1000;
const D = 24 * H;
const HASTA = Date.parse('2026-10-01T00:00:00.000Z');
const DESDE = HASTA - 14 * D;
const iso = (ms) => new Date(ms).toISOString();

const CFG = {
    multi_provider: {
        quota: {
            anthropic: { plan: 'Claude Max', periodo: 'semanal', techo: 100, unidad: 'porcentaje', reposicion: 'dom 21:00' },
            'openai-codex': { plan: 'ChatGPT Plus', periodo: 'semanal', techo: 100, unidad: 'porcentaje', reposicion: 'rolling' },
        },
    },
};
const AGENT_MODELS = { default_provider: 'anthropic', skills: { 'backend-dev': { provider: 'anthropic', fallbacks: [{ provider: 'openai-codex' }] } } };

function det(event, provider, ms, extra = {}) {
    return { timestamp: iso(ms), event, agent: extra.agent || null, provider, error_type: extra.error_type || null, raw_excerpt: extra.raw_excerpt || null, flag_set: event === 'flag_set' };
}

/** Muestras semanales cada 6 h: sube 20 pts/día y se repone al inicio de cada semana. */
function muestrasAgotadas(provider) {
    const out = [];
    for (let t = DESDE; t < HASTA; t += 6 * H) {
        const dia = ((t - DESDE) % (7 * D)) / D;
        out.push({ ts: iso(t), provider, bucket: 'weekly', pct: Math.min(100, Math.round(dia * 20)), confidence: 'fresh' });
    }
    return out;
}

function muestrasPlanas(provider, pct) {
    const out = [];
    for (let t = DESDE; t < HASTA; t += 6 * H) out.push({ ts: iso(t), provider, bucket: 'weekly', pct, confidence: 'fresh' });
    return out;
}

/** codex gateado por cuota semanal desde el día 5 de cada semana hasta la reposición, con trabajo frenado. */
function eventosCodexAgotado() {
    const ev = [];
    for (const semana of [0, 1]) {
        const ini = DESDE + semana * 7 * D;
        ev.push(det('flag_set', 'openai-codex', ini + 5 * D, { error_type: 'insufficient_quota' }));
        ev.push(det('gate_blocked_spawn', null, ini + 5 * D + H, { agent: 'backend-dev', raw_excerpt: `issue=${700 + semana} fase=dev pipeline=desarrollo` }));
        ev.push(det('dispatch_resumed', null, ini + 7 * D - H, { agent: 'backend-dev', raw_excerpt: `issue=${700 + semana} fase=dev` }));
        ev.push(det('drained_post_reset', 'openai-codex', ini + 7 * D - 1000));
    }
    return ev;
}

/** anthropic fuera de circulación (health en rojo) toda la ventana. */
const ANTHROPIC_CAIDO = [{ type: 'health_state_transition', provider: 'anthropic', from_state: 'green', to_state: 'red', reason_code: 'x', created_at: DESDE - D }];

function evaluar(extra) {
    return ax.evaluarProveedores({
        cfgRoot: CFG, agentModels: AGENT_MODELS, desde: DESDE, hasta: HASTA, ventana: '14d hasta 2026-10-01',
        isActiveAt: () => true, healthEvents: [], scheduleEntries: {}, creditRedemptions: [], costRecords: [],
        ...extra,
    });
}

test('Gherkin: agotamiento sostenido con trabajo frenado y sin otra pata ⇒ subir el plan de codex, con descarte explícito', () => {
    const r = evaluar({
        samples: muestrasAgotadas('openai-codex'),
        detectorEvents: eventosCodexAgotado(),
        healthEvents: ANTHROPIC_CAIDO,
        creditRedemptions: [{ provider: 'openai-codex', redeemed_at: iso(DESDE + 7 * D) }],
    });
    const h = r.hallazgos.find((x) => x.clave === 'plan_subir');
    assert.ok(h, JSON.stringify(r.detalle.providers));
    assert.equal(h.params.provider, 'openai-codex');
    assert.equal(h.metrica.valor, 2);
    assert.ok(h.params.horas_frenadas > 0);
    assert.equal(h.params.issues_afectados, 2);
    assert.equal(h.params.techo, 100);
    assert.equal(h.params.plan, 'ChatGPT Plus');
    assert.equal(h.params.creditos_confusores, 1, 'el crédito de reset se marca como confusor');
    assert.equal(h.params.descarte, '1. flag falso: no, 2. schedule: no, 3. cadena: no, 4. plan: causa');
    const p = construirPayload(h);
    assert.equal(p.payload.tipo, 'cambio-de-configuracion');
    assert.match(p.payload.evidencia.resumen, /h frenadas, 2 issues afectados/);
    assert.match(p.payload.costo.detalle, /Techo actual 100 porcentaje \(ChatGPT Plus\)/);
    assert.equal(r.detalle.semanas_limpias, 2);
});

test('el salto de un reinicio por crédito nunca suma consumo', () => {
    const muestras = [
        { ts: DESDE + H, provider: 'openai-codex', valor: 40, window_reset: false },
        { ts: DESDE + 2 * H, provider: 'openai-codex', valor: 90, window_reset: false },
        { ts: DESDE + 3 * H, provider: 'openai-codex', valor: 5, window_reset: true, reset_motivo: 'credito' },
        { ts: DESDE + 4 * H, provider: 'openai-codex', valor: 15, window_reset: false },
    ];
    const [b] = ax.consumoPorBloque(muestras, [{ desde: DESDE, hasta: DESDE + 7 * D }]);
    assert.equal(b.consumo, 60, '50 antes del crédito + 10 después; el reinicio no cuenta');
    assert.equal(b.creditos, 1);
});

test('Gherkin: agotamiento con otra pata disponible NO pide más plan: reordena/rebalancea citando el saldo', () => {
    const r = evaluar({
        samples: [...muestrasAgotadas('openai-codex'), ...muestrasPlanas('anthropic', 35)],
        detectorEvents: eventosCodexAgotado(),
    });
    assert.ok(!r.hallazgos.some((h) => h.clave === 'plan_subir'));
    const h = r.hallazgos.find((x) => x.clave === 'cadena_reordenar');
    assert.ok(h);
    assert.equal(h.params.provider, 'openai-codex');
    assert.equal(h.params.otra_pata, 'anthropic');
    assert.equal(h.params.saldo_otra_pata, 65);
    const p = construirPayload(h);
    assert.match(p.payload.accion, /no subir el plan de openai-codex/);
    assert.match(p.payload.evidencia.resumen, /saldo de anthropic 65 pts/);
    assert.match(h.params.descarte, /3\. cadena: causa, 4\. plan: no evaluado/);
});

test('Gherkin: serie contaminada (<2 ventanas semanales limpias) ⇒ ninguna sugerencia de plan y queda registrado desde cuándo', () => {
    const hasta = Date.parse('2026-09-20T00:00:00.000Z');
    const r = ax.evaluarProveedores({
        cfgRoot: CFG, agentModels: AGENT_MODELS, desde: hasta - 14 * D, hasta, ventana: 'v', isActiveAt: () => true,
        samples: muestrasAgotadas('openai-codex').map((s) => ({ ...s, ts: iso(Date.parse(s.ts) - 11 * D) })),
        detectorEvents: eventosCodexAgotado().map((e) => ({ ...e, timestamp: iso(Date.parse(e.timestamp) - 11 * D) })),
        healthEvents: ANTHROPIC_CAIDO.map((e) => ({ ...e, created_at: e.created_at - 11 * D })),
    });
    assert.ok(!r.hallazgos.some((h) => h.clave === 'plan_subir' || h.clave === 'plan_bajar'));
    assert.equal(r.detalle.ventana_limpia_desde, ax.QUOTA_CLEAN_SINCE);
    assert.equal(r.detalle.semanas_limpias, 1);
    assert.equal(r.detalle.providers['openai-codex'].veredicto, 'sin_evidencia_suficiente');
});

test('flag de cuota activo con la ventana observada lejos del 100 % ⇒ revisar el detector, nunca más plan', () => {
    const r = evaluar({
        samples: muestrasPlanas('openai-codex', 60),
        detectorEvents: eventosCodexAgotado(),
        healthEvents: ANTHROPIC_CAIDO,
    });
    const h = r.hallazgos.find((x) => x.clave === 'detector_revisar');
    assert.ok(h);
    assert.equal(h.params.max_observado, 60);
    assert.ok(!r.hallazgos.some((x) => x.clave === 'plan_subir'));
    assert.match(h.params.descarte, /^1\. flag falso: causa/);
    assert.equal(construirPayload(h).payload.tipo, 'mejora-de-proceso');
});

test('horario de reposo que deja una sola pata viva y gateada ⇒ mover schedule, con horas por día', () => {
    const r = evaluar({
        samples: muestrasAgotadas('openai-codex'),
        detectorEvents: eventosCodexAgotado(),
        scheduleEntries: { anthropic: { active: true } },
        isActiveAt: (p) => p !== 'anthropic',
    });
    const h = r.hallazgos.find((x) => x.clave === 'schedule_mover');
    assert.ok(h);
    assert.equal(h.params.pata, 'openai-codex');
    assert.deepEqual(h.params.en_reposo, ['anthropic']);
    assert.ok(h.params.horas_unica_por_dia > 20);
    assert.ok(!r.hallazgos.some((x) => x.clave === 'plan_subir'), 'el schedule es la causa: no se evalúa plan para esa pata');
});

test('consumo semanal bajo y sin horas gateadas ⇒ bajar plan (con dos semanas limpias)', () => {
    const r = evaluar({ samples: muestrasPlanas('anthropic', 12), detectorEvents: [] });
    const h = r.hallazgos.find((x) => x.clave === 'plan_bajar');
    assert.ok(h);
    assert.equal(h.params.provider, 'anthropic');
    assert.equal(h.metrica.valor, 12);
});

test('sin techos declarados o sin muestras ⇒ sin_evidencia_suficiente', () => {
    assert.equal(evaluar({ cfgRoot: {}, samples: muestrasPlanas('anthropic', 12) }).veredicto, 'sin_evidencia_suficiente');
    assert.equal(evaluar({ samples: [] }).veredicto, 'sin_evidencia_suficiente');
});

test('el orden de descarte es fijo', () => {
    assert.deepEqual(ax.DESCARTE_ORDEN, ['flag_falso', 'schedule', 'cadena', 'plan']);
    assert.equal(ax.QUOTA_CLEAN_SINCE, '2026-09-10');
});

test('otra pata viva pero sin cadena frenada: el fallback absorbió el agotamiento ⇒ ni reordena ni sube plan', () => {
    const eventos = eventosCodexAgotado().filter((e) => e.event !== 'gate_blocked_spawn' && e.event !== 'dispatch_resumed');
    const r = evaluar({ samples: [...muestrasAgotadas('openai-codex'), ...muestrasPlanas('anthropic', 35)], detectorEvents: eventos });
    assert.ok(!r.hallazgos.some((h) => h.clave === 'cadena_reordenar' || h.clave === 'plan_subir'));
    assert.ok(r.detalle.providers['openai-codex'].otra_pata_viva_horas.anthropic > 0);
});

test('una pata SIN muestras en la ventana no cuenta como saldo disponible', () => {
    const r = evaluar({ samples: muestrasAgotadas('openai-codex'), detectorEvents: eventosCodexAgotado() });
    // anthropic está "viva" (sin gates) pero no tiene ni una muestra: no se la cita como saldo.
    assert.ok(!r.hallazgos.some((h) => h.clave === 'cadena_reordenar'));
    assert.ok(r.hallazgos.some((h) => h.clave === 'plan_subir'));
});
