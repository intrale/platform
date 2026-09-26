// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// #7440 (split de #7432) — AUTO-LEVANTAMIENTO DEL BLOQUEO DE DECISIÓN CUANDO LA
// FIRMA DEL ARQUITECTO LLEGA DESPUÉS DE LA ESCALADA
//
// LA CARRERA (#7113). El intake corrió a las 18:44:23 y el arquitecto firmó a
// las 18:44:25. Al ciclo siguiente el gate reconocía el bloqueo vivo y hacía
// `continue` seco: el issue quedaba con `needs-human` hasta que un humano lo
// notara y lo destrabara a mano.
//
// DIRECCIÓN DEL FAIL. Esta ruta QUITA UN FRENO HUMANO. Un bug acá no ensucia
// el tablero: libera issues que un humano frenó a propósito. Por eso los casos
// negativos (CN-1…CN-11) son más que el camino feliz, y cada uno asierta que
// NO se tocó GitHub (cero órdenes encoladas) y que la red NO se consultó
// cuando no correspondía.
//
// Todo se ejercita sobre `_evaluateLateSignoff` (función pura con deps
// inyectables, expuesta bajo `PULPO_NO_AUTOSTART=1`) con markers REALES
// escritos por `reportHumanBlock` en un tmpdir y `encolarOrdenGithub` REAL
// sobre `servicios/github/pendiente/`, para que el payload que se inspecciona
// sea el que va a leer `servicio-github.js`.
// =============================================================================

'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withEnv } = require('../test-helpers/with-env');

const TMP_DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'v3-late-signoff-7432-'));
const PIPELINE_DIR = path.join(TMP_DIR, '.pipeline');
const FASES = { definicion: ['analisis', 'criterios', 'sizing'], desarrollo: ['dev', 'verificacion'] };
for (const [pipe, fases] of Object.entries(FASES)) {
    for (const fase of fases) {
        for (const estado of ['pendiente', 'trabajando', 'listo', 'bloqueado-humano']) {
            fs.mkdirSync(path.join(PIPELINE_DIR, pipe, fase, estado), { recursive: true });
        }
    }
}
const GH_QUEUE = path.join(PIPELINE_DIR, 'servicios', 'github', 'pendiente');
fs.mkdirSync(GH_QUEUE, { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });

// #7489 / #7456 (D-4) — `human-block.js` resuelve `markersRoot()` EN CADA
// LLAMADA vía `write-target` (SEC-9): el override tiene que estar vivo durante
// cada test, no sólo durante la carga. El runner hereda `PIPELINE_REPO_ROOT`
// del productivo (contexto heredado, no dir de pruebas): se borra. Las
// escrituras de env van SIEMPRE por `withEnv` (helper único, #6258/#6260):
// `test` de este archivo envuelve cada cuerpo con el entorno de la corrida y
// lo restaura al salir. Mismo patrón que `human-block-env-isolation.test.js`.
const ENV_CORRIDA = Object.freeze({
    CLAUDE_PROJECT_DIR: TMP_DIR,
    PIPELINE_REPO_ROOT: undefined,
    PIPELINE_DIR_OVERRIDE: PIPELINE_DIR,
});
const test = (name, fn) => nodeTest(name, (...args) => withEnv(ENV_CORRIDA, () => fn(...args)));
test.after = nodeTest.after;

let trace, hb, pulpo;
withEnv(
    {
        CLAUDE_PROJECT_DIR: TMP_DIR,
        PULPO_NO_AUTOSTART: '1',
        PIPELINE_DIR_OVERRIDE: PIPELINE_DIR,
    },
    () => {
        delete require.cache[require.resolve('../traceability')];
        delete require.cache[require.resolve('../human-block')];
        trace = require('../traceability');
        hb = require('../human-block');
        pulpo = require('../../pulpo.js');
    },
    {
        permitirApagarControl: ['PULPO_NO_AUTOSTART'],
        motivo: 'cargar pulpo.js como módulo para ejercitar _evaluateLateSignoff sin arrancar el loop',
    },
);
const designDecision = require('../design-decision-detect');

const {
    _evaluateLateSignoff,
    _sweepLateSignoff,
    _lateSignoffRecheckDue,
    _resolveLateSignoffConfig,
    _buildLateSignoffComment,
    _lateSignoffState,
    LATE_SIGNOFF_DEFAULTS,
    LATE_SIGNOFF_NO_RECHECK_REASONS,
    encolarOrdenGithub,
    buildIntakeSearchQueries,
} = pulpo;

const SKILLS_POR_FASE = {
    definicion: { skills_por_fase: { analisis: ['guru', 'security'], criterios: ['po', 'ux'], sizing: ['po'] } },
    desarrollo: { skills_por_fase: { dev: ['pipeline-dev'], verificacion: ['qa', 'tester'] } },
};
const CFG = Object.freeze({ recheckMin: 10, maxAgeH: 48 });
const SIGNALS = ['alternativas-enumeradas', 'dato-critico'];
const T0 = Date.parse('2026-09-18T18:44:23Z');
const FIRMA_AT = '2026-09-18T18:44:25Z';

const dir = (pipe, fase, estado) => path.join(PIPELINE_DIR, pipe, fase, estado);

function resetFs() {
    for (const [pipe, fases] of Object.entries(FASES)) {
        for (const fase of fases) {
            for (const estado of ['pendiente', 'trabajando', 'listo', 'bloqueado-humano']) {
                const d = dir(pipe, fase, estado);
                try { for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { force: true }); } catch { /* vacío */ }
            }
        }
    }
    try { for (const f of fs.readdirSync(GH_QUEUE)) fs.rmSync(path.join(GH_QUEUE, f), { force: true }); } catch { /* vacío */ }
    try { fs.unlinkSync(trace.LOG_FILE); } catch { /* sin log */ }
    _lateSignoffState.clear();
}

/** Marker REAL del gate: sintético (`moveFromActive:false`, sin work-file activo) + `cause`. */
function bloquearGate(issue, extra = {}) {
    return hb.reportHumanBlock({
        issue, skill: 'definicion', phase: 'criterios', pipeline: 'definicion',
        reason: `Freno #${issue}: plantea una decisión de arquitectura.`,
        question: '¿Lo dejo pasar o esperás a que lo revise?',
        cause: 'design-decision', moveFromActive: false, skipGithubLabel: true,
        ...extra,
    });
}

/** Marker pedido por un humano (sin `cause`): work-file real en `trabajando/` de otra fase. */
function bloquearHumano(issue, { pipeline = 'definicion', phase = 'sizing', skill = 'po' } = {}) {
    fs.writeFileSync(path.join(dir(pipeline, phase, 'trabajando'), `${issue}.${skill}`),
        `issue: ${issue}\nfase: ${phase}\npipeline: ${pipeline}\n`);
    return hb.reportHumanBlock({
        issue, skill, phase, pipeline,
        reason: 'El PO pide una decisión de negocio.', question: '¿Cobramos envío?',
        skipGithubLabel: true,
    });
}

function firmaValida(issue, createdAt = FIRMA_AT) {
    return {
        createdAt, authorAssociation: 'OWNER', isMinimized: false,
        body: `<!-- architect-signoff issue=${issue} -->\n## ✅ Arquitecto — firma de pre-admisión\n\nReceta ok.`,
    };
}

function ordenesEncoladas() {
    return fs.readdirSync(GH_QUEUE).sort().map((f) => ({
        file: f, payload: JSON.parse(fs.readFileSync(path.join(GH_QUEUE, f), 'utf8')),
    }));
}

/**
 * Deps con espías. `humanBlock` y `designDecision` REALES salvo override;
 * `encolar` = `encolarOrdenGithub` REAL. Telegram: un espía que NUNCA debe
 * invocarse (RS-4.7) — se expone para que cada test lo asierte.
 */
function fakeDeps({ ctx, audit, humanBlock = hb, reconcile, logs = [] } = {}) {
    const spies = { fetch: 0, audits: [], telegram: 0, logs };
    const hbUsado = reconcile
        ? Object.assign(Object.create(humanBlock), { reconcileBlockedMarkers: reconcile })
        : humanBlock;
    return {
        spies,
        deps: {
            io: {
                fetchSignoffContext: (n) => {
                    spies.fetch += 1;
                    if (typeof ctx === 'function') return ctx(n);
                    return ctx || { ok: true, comments: [], lastEditedAt: null };
                },
                readSignoffAudit: () => audit || { available: true, corroborated: true },
                appendGateAudit: (r) => { spies.audits.push(r); return true; },
                appendUnblockAudit: () => true,
            },
            humanBlock: hbUsado,
            designDecision,
            encolar: encolarOrdenGithub,
            ghQueueDir: GH_QUEUE,
            skillsPorFase: SKILLS_POR_FASE,
            log: (brazo, msg) => logs.push(`[${brazo}] ${msg}`),
            sendTelegram: () => { spies.telegram += 1; },
        },
    };
}

function evaluar(issue, { now = T0 + 15 * 60000, cfg = CFG, ...rest } = {}) {
    const { deps, spies } = fakeDeps(rest);
    const r = _evaluateLateSignoff({
        issue, markers: hb.listBlockedMarkers(issue), signals: SIGNALS, now, cfg, deps,
    });
    return { r, spies, deps };
}

// =============================================================================
// CA-6 — camino feliz: firma tardía fuerte ⇒ se levanta solo, con procedencia
// =============================================================================

test('CA-6: firma posterior a la escalada + traza corroborada ⇒ marker descartado, remove-label CON procedencia, UN comentario, lifted_by, sin Telegram', () => {
    resetFs();
    const issue = 7113;
    bloquearGate(issue);
    assert.equal(hb.listBlockedMarkers(issue).length, 1, 'precondición: marker del gate vivo');

    const { r, spies } = evaluar(issue, {
        ctx: { ok: true, comments: [firmaValida(issue)], lastEditedAt: null },
        audit: { available: true, corroborated: true },
    });

    assert.equal(r.lifted, true, JSON.stringify(r));
    assert.equal(r.reason, 'levantado');
    assert.equal(spies.fetch, 1, 'una sola re-consulta');

    // (1) RS-4.11 — reconciliar PRIMERO: el marker del gate es sintético ⇒ `descartado` (guru 1).
    assert.equal(r.reconciled.length, 1);
    assert.equal(r.reconciled[0].action, 'descartado');
    assert.equal(hb.listBlockedMarkers(issue).length, 0, 'el marker ya no está');
    assert.deepEqual(fs.readdirSync(dir('definicion', 'criterios', 'pendiente')), [], 'CN-11: no se fabricó work-file');

    // (2) UNA orden remove-label con procedencia (SEC-B #5690) + (3) UN comentario.
    const ordenes = ordenesEncoladas();
    assert.equal(ordenes.length, 2, `dos órdenes exactas: ${ordenes.map((o) => o.file).join(', ')}`);
    const remove = ordenes.filter((o) => o.payload.action === 'remove-label');
    const comments = ordenes.filter((o) => o.payload.action === 'comment');
    assert.equal(remove.length, 1);
    assert.equal(comments.length, 1);
    assert.deepEqual(remove[0].payload, {
        action: 'remove-label', issue, label: hb.NEEDS_HUMAN_LABEL,
        guardrail_authorized: true, authorized_by: 'architect-signoff:late',
    });
    assert.match(remove[0].file, /^7113-late-signoff-remove-needs-human-\d+/);
    assert.equal(comments[0].payload.issue, issue);
    assert.equal(r.orders.length, 2, 'devuelve los paths reales escritos');

    // Copy UX-C exacto: sin línea de marcador, con footer intake, fecha de la firma sin reformatear.
    const body = comments[0].payload.body;
    assert.ok(body.startsWith('## ♻️ Bloqueo de decisión levantado — firma del arquitecto posterior\n\n'));
    assert.ok(body.includes(`La firma del arquitecto se verificó en ${FIRMA_AT} y la traza local la corrobora`));
    assert.ok(body.includes('plantea opciones excluyentes y no elige una'), 'UX-E: frases de SIGNAL_COPY, no keys');
    assert.ok(!body.includes('()'), 'nunca paréntesis vacíos');
    assert.ok(body.endsWith('\n\nNo hace falta que hagas nada.\n\n<!-- agent: intake -->'));
    assert.ok(!/architect-signoff/.test(body), 'RS-4.5: el comentario de traza NO lleva el marcador de firma');

    // (4) audit al final con el resultado real.
    assert.equal(spies.audits.length, 1);
    assert.equal(spies.audits[0].lifted_by, 'late-signoff');
    assert.equal(spies.audits[0].signoff_present, true);
    assert.equal(spies.audits[0].signoff_corroboracion, true);
    assert.equal(spies.audits[0].escalated, true);
    assert.equal(spies.audits[0].error, null);

    // (6) RS-4.7 — cero Telegram. (CA-12) state purgado.
    assert.equal(spies.telegram, 0);
    assert.equal(_lateSignoffState.has(issue), false, 'CA-12: sin marker, sin entrada');
    resetFs();
});

test('CA-6 bis: el unlocker de la reconciliación es architect-signoff:late (audita origin sin normalizar a unknown)', () => {
    resetFs();
    const issue = 7114;
    bloquearGate(issue);
    const origenes = [];
    const { deps } = fakeDeps({
        ctx: { ok: true, comments: [firmaValida(issue)], lastEditedAt: null },
        reconcile: (args) => {
            assert.equal(args.unlocker, 'architect-signoff:late');
            assert.equal(args.issue, issue);
            return hb.reconcileBlockedMarkers({
                ...args, io: { appendUnblockAudit: (rec) => { origenes.push(rec.origin); } },
            });
        },
    });
    const r = _evaluateLateSignoff({ issue, markers: hb.listBlockedMarkers(issue), signals: SIGNALS, now: T0, cfg: CFG, deps });
    assert.equal(r.lifted, true);
    assert.deepEqual(origenes, ['architect-signoff:late']);
    resetFs();
});

// =============================================================================
// Casos negativos — en todos: red NO consultada salvo que se indique, cero
// órdenes, el marker sigue vivo (el intake hace `continue`).
// =============================================================================

test('CN-1: marker legacy SIN cause ⇒ no se re-consulta ni se encola nada (RS-4.1)', () => {
    resetFs();
    const issue = 7201;
    bloquearGate(issue, { cause: undefined });
    assert.equal(hb.listBlockedMarkers(issue)[0].cause, null, 'precondición: sin cause');
    const { r, spies } = evaluar(issue, { ctx: { ok: true, comments: [firmaValida(issue)], lastEditedAt: null } });
    assert.equal(r.lifted, false);
    assert.equal(r.reason, 'bloqueo-mixto');
    assert.equal(spies.fetch, 0, 'exec no invocado');
    assert.equal(ordenesEncoladas().length, 0);
    assert.equal(hb.listBlockedMarkers(issue).length, 1, 'sigue bloqueado');
    resetFs();
});

test('CN-1 bis: .reason.json ilegible ⇒ cause null ⇒ no se re-consulta', () => {
    resetFs();
    const issue = 7202;
    const m = bloquearGate(issue);
    fs.writeFileSync(m.marker_path + '.reason.json', '{ esto no es json', 'utf8');
    assert.equal(hb.listBlockedMarkers(issue)[0].cause, null);
    assert.equal(hb.listBlockedMarkers(issue)[0].blocked_at, null, 'CA-11: blocked_at null con sidecar ilegible');
    const { r, spies } = evaluar(issue, { ctx: { ok: true, comments: [firmaValida(issue)], lastEditedAt: null } });
    assert.equal(r.lifted, false);
    assert.equal(spies.fetch, 0);
    assert.equal(ordenesEncoladas().length, 0);
    resetFs();
});

test('CN-2: bloqueo mixto (marker del gate + marker humano en otra fase) ⇒ nada se toca aunque la firma sea válida (RS-4.9)', () => {
    resetFs();
    const issue = 7203;
    bloquearGate(issue);
    bloquearHumano(issue);
    assert.equal(hb.listBlockedMarkers(issue).length, 2, 'precondición: dos markers');
    let reconcileLlamado = 0;
    const logs = [];
    const { r, spies } = evaluar(issue, {
        ctx: { ok: true, comments: [firmaValida(issue)], lastEditedAt: null },
        audit: { available: true, corroborated: true },
        reconcile: () => { reconcileLlamado += 1; return { reconciled: [] }; },
        logs,
    });
    assert.equal(r.lifted, false);
    assert.equal(r.reason, 'bloqueo-mixto');
    assert.equal(spies.fetch, 0, 'exec no invocado');
    assert.equal(reconcileLlamado, 0, 'reconcileBlockedMarkers NO invocado');
    assert.equal(ordenesEncoladas().length, 0);
    assert.equal(hb.listBlockedMarkers(issue).length, 2, 'los dos markers siguen vivos');
    assert.ok(logs.some((l) => l.includes('bloqueo mixto — hay un marker no originado por el gate')), logs.join('\n'));
    resetFs();
});

test('CN-3: firma settled pero traza local NO disponible ⇒ no se levanta; signoff_corroboracion traza-no-disponible (RS-4.2)', () => {
    resetFs();
    const issue = 7204;
    bloquearGate(issue);
    const { r, spies } = evaluar(issue, {
        ctx: { ok: true, comments: [firmaValida(issue)], lastEditedAt: null },
        audit: { available: false, corroborated: false },
    });
    assert.equal(r.lifted, false);
    assert.equal(r.reason, 'traza-no-disponible');
    assert.equal(spies.fetch, 1, 'acá SÍ se re-consultó: el veto es de corroboración');
    assert.equal(ordenesEncoladas().length, 0);
    assert.equal(hb.listBlockedMarkers(issue).length, 1);
    assert.equal(spies.audits.length, 1);
    assert.equal(spies.audits[0].signoff_present, true);
    assert.equal(spies.audits[0].signoff_corroboracion, 'traza-no-disponible');
    assert.equal(spies.audits[0].lifted_by, null);
    resetFs();
});

test('CN-3 bis: traza disponible pero NO corrobora ⇒ evaluateArchitectSignoff rechaza ⇒ firma-no-settled', () => {
    resetFs();
    const issue = 7205;
    bloquearGate(issue);
    const { r, spies } = evaluar(issue, {
        ctx: { ok: true, comments: [firmaValida(issue)], lastEditedAt: null },
        audit: { available: true, corroborated: false },
    });
    assert.equal(r.lifted, false);
    assert.equal(r.reason, 'firma-no-settled');
    assert.equal(spies.audits[0].signoff_corroboracion, false);
    assert.equal(spies.audits[0].lifted_by, null);
    assert.equal(ordenesEncoladas().length, 0);
    resetFs();
});

test('CN-3 ter: gh no responde (ctx.ok=false) ⇒ firma-no-settled, error en el audit, sin órdenes', () => {
    resetFs();
    const issue = 7206;
    bloquearGate(issue);
    const { r, spies } = evaluar(issue, { ctx: { ok: false, error: 'ENOENT gh' } });
    assert.equal(r.lifted, false);
    assert.equal(r.reason, 'firma-no-settled');
    assert.equal(spies.audits[0].error, 'ENOENT gh');
    assert.equal(spies.audits[0].signoff_corroboracion, null);
    assert.equal(ordenesEncoladas().length, 0);
    resetFs();
});

test('CN-4: segunda corrida dentro de la ventana de throttle ⇒ fetchSignoffContext NO invocado (RS-4.7)', () => {
    resetFs();
    const issue = 7207;
    bloquearGate(issue);
    const sinFirma = { ok: true, comments: [], lastEditedAt: null };
    const primera = evaluar(issue, { now: T0, ctx: sinFirma });
    assert.equal(primera.r.reason, 'firma-no-settled');
    assert.equal(primera.spies.fetch, 1);
    const segunda = evaluar(issue, { now: T0 + 9 * 60000, ctx: { ok: true, comments: [firmaValida(issue)], lastEditedAt: null } });
    assert.equal(segunda.r.lifted, false);
    assert.equal(segunda.r.reason, 'throttled');
    assert.equal(segunda.spies.fetch, 0, 'dentro de la ventana no se consulta');
    assert.equal(ordenesEncoladas().length, 0);
    const tercera = evaluar(issue, { now: T0 + 11 * 60000, ctx: { ok: true, comments: [firmaValida(issue)], lastEditedAt: null } });
    assert.equal(tercera.r.lifted, true, 'pasada la ventana, se consulta y levanta');
    resetFs();
});

test('CN-5: marker con mtime reciente pero blocked_at de hace 72 h ⇒ marker-viejo, no consulta (RS-4.12)', () => {
    resetFs();
    const issue = 7208;
    bloquearGate(issue);
    const marker = hb.listBlockedMarkers(issue)[0];
    const meta = JSON.parse(fs.readFileSync(marker.file + '.reason.json', 'utf8'));
    meta.blocked_at = new Date(Date.now() - 72 * 3600000).toISOString();
    fs.writeFileSync(marker.file + '.reason.json', JSON.stringify(meta));   // mtime = ahora
    const { r, spies } = evaluar(issue, { now: Date.now(), ctx: { ok: true, comments: [firmaValida(issue)], lastEditedAt: null } });
    assert.equal(r.lifted, false);
    assert.equal(r.reason, 'marker-viejo');
    assert.equal(spies.fetch, 0);
    assert.equal(ordenesEncoladas().length, 0);
    resetFs();
});

test('CN-5 bis: _lateSignoffRecheckDue toma la MAYOR edad (blocked_at vs mtime, y entre markers)', () => {
    const now = T0;
    const h = 3600000;
    // blocked_at reciente, mtime viejo ⇒ manda el mtime.
    let d = _lateSignoffRecheckDue({
        issue: 1, cfg: CFG, now, state: new Map(),
        markers: [{ file: 'a', blocked_at: new Date(now - 1 * h).toISOString() }],
        mtimeOf: () => now - 60 * h,
    });
    assert.equal(d.reason, 'marker-viejo');
    assert.ok(d.ageH >= 60);
    // stat que falla ⇒ edad 0 por mtime, manda blocked_at.
    d = _lateSignoffRecheckDue({
        issue: 1, cfg: CFG, now, state: new Map(),
        markers: [{ file: 'a', blocked_at: new Date(now - 2 * h).toISOString() }],
        mtimeOf: () => { throw new Error('ENOENT'); },
    });
    assert.equal(d.due, true);
    assert.ok(Math.abs(d.ageH - 2) < 0.01);
    // dos markers: uno joven y uno viejo ⇒ manda el viejo.
    d = _lateSignoffRecheckDue({
        issue: 1, cfg: CFG, now, state: new Map(),
        markers: [
            { file: 'a', blocked_at: new Date(now - 1 * h).toISOString() },
            { file: 'b', blocked_at: new Date(now - 49 * h).toISOString() },
        ],
        mtimeOf: () => now,
    });
    assert.equal(d.reason, 'marker-viejo');
    // sin blocked_at ni mtime ⇒ edad 0 ⇒ due.
    d = _lateSignoffRecheckDue({ issue: 1, cfg: CFG, now, state: new Map(), markers: [{ file: 'a', blocked_at: null }], mtimeOf: () => NaN });
    assert.equal(d.due, true);
});

test('CN-6: config no positiva (-5, 0, "abc", null, undefined) cae al default 10/48; "15" citado en YAML se acepta (RS-4.12)', () => {
    for (const v of [-5, 0, 'abc', null, undefined, NaN, Infinity, -Infinity, '']) {
        const c = _resolveLateSignoffConfig({ late_signoff_recheck_min: v, late_signoff_max_age_h: v });
        assert.deepEqual(c, { recheckMin: 10, maxAgeH: 48, maxPerTick: 5 }, `valor ${String(v)}`);
    }
    assert.deepEqual(_resolveLateSignoffConfig({ late_signoff_recheck_min: '15', late_signoff_max_age_h: '72' }), { recheckMin: 15, maxAgeH: 72, maxPerTick: 5 });
    assert.deepEqual(_resolveLateSignoffConfig(undefined), { recheckMin: 10, maxAgeH: 48, maxPerTick: 5 });
    assert.deepEqual(_resolveLateSignoffConfig('basura'), { recheckMin: 10, maxAgeH: 48, maxPerTick: 5 });
    assert.deepEqual(LATE_SIGNOFF_DEFAULTS, { recheckMin: 10, maxAgeH: 48, maxPerTick: 5 });

    // Con `-5` la ventana NO queda "siempre vencida": la segunda corrida dentro de 10 min no consulta.
    resetFs();
    const issue = 7209;
    bloquearGate(issue);
    const cfg = _resolveLateSignoffConfig({ late_signoff_recheck_min: -5 });
    const a = evaluar(issue, { now: T0, cfg, ctx: { ok: true, comments: [], lastEditedAt: null } });
    assert.equal(a.spies.fetch, 1);
    const b = evaluar(issue, { now: T0 + 5 * 60000, cfg, ctx: { ok: true, comments: [firmaValida(issue)], lastEditedAt: null } });
    assert.equal(b.r.reason, 'throttled');
    assert.equal(b.spies.fetch, 0);
    resetFs();
});

test('CN-8: el body del comentario de traza UX-C pasado por evaluateArchitectSignoff ⇒ settled:false SIN_MARCADOR (RS-4.5, A08)', () => {
    const body = _buildLateSignoffComment({ signals: SIGNALS, signedAt: FIRMA_AT, designDecision });
    const r = designDecision.evaluateArchitectSignoff({
        issue: 7113, lastEditedAt: null,
        comments: [{ createdAt: FIRMA_AT, authorAssociation: 'OWNER', isMinimized: false, body }],
    });
    assert.equal(r.settled, false);
    assert.equal(r.reason, 'sin firma de arquitecto publicada', 'ni siquiera llega a la traza de rechazados: no tiene marcador');
    assert.deepEqual(r.rejected, []);
    assert.equal(r.signedAt, undefined);
});

test('CN-9: reconcileBlockedMarkers con action error / sin-efecto ⇒ CERO órdenes, audit con lifted_by null + error (RS-4.11)', () => {
    for (const action of ['error', 'sin-efecto']) {
        resetFs();
        const issue = 7210;
        bloquearGate(issue);
        const logs = [];
        const { r, spies } = evaluar(issue, {
            ctx: { ok: true, comments: [firmaValida(issue)], lastEditedAt: null },
            reconcile: () => ({ reconciled: [{ pipeline: 'definicion', phase: 'criterios', skill: 'definicion', action }] }),
            logs,
        });
        assert.equal(r.lifted, false, action);
        assert.equal(r.reason, 'reconcile-fallido', action);
        assert.equal(ordenesEncoladas().length, 0, `${action}: no se tocó GitHub`);
        assert.equal(spies.audits.length, 1);
        assert.equal(spies.audits[0].lifted_by, null);
        assert.match(String(spies.audits[0].error), /reconciliación parcial/);
        assert.ok(logs.some((l) => l.includes('la reconciliación falló — se conserva el bloqueo')));
        assert.equal(spies.telegram, 0);
    }
    // Reconciliación que no toca ningún marker (lista vacía) tampoco autoriza el remove-label.
    resetFs();
    const issue = 7211;
    bloquearGate(issue);
    const { r } = evaluar(issue, {
        ctx: { ok: true, comments: [firmaValida(issue)], lastEditedAt: null },
        reconcile: () => ({ reconciled: [] }),
    });
    assert.equal(r.reason, 'reconcile-fallido');
    assert.equal(ordenesEncoladas().length, 0);
    resetFs();
});

test('CN-10: fetchSignoffContext lanza ⇒ nunca lanza hacia afuera, cero órdenes, issue sigue bloqueado, audit con error (RS-4.10)', () => {
    resetFs();
    const issue = 7212;
    bloquearGate(issue);
    const logs = [];
    const { r, spies } = evaluar(issue, { ctx: () => { throw new Error('boom gh'); }, logs });
    assert.equal(r.lifted, false);
    assert.equal(r.reason, 'error');
    assert.equal(r.error, 'boom gh');
    assert.equal(ordenesEncoladas().length, 0);
    assert.equal(hb.listBlockedMarkers(issue).length, 1, 'sigue bloqueado');
    assert.deepEqual(fs.readdirSync(dir('definicion', 'criterios', 'pendiente')), [], 'no aparece en pendiente/');
    assert.equal(spies.audits.length, 1);
    assert.equal(spies.audits[0].error, 'boom gh');
    assert.equal(spies.audits[0].lifted_by, null);
    assert.ok(logs.some((l) => l.includes('fail-closed')));
    assert.equal(spies.telegram, 0);
    resetFs();
});

test('CN-10 bis: reconcileBlockedMarkers lanza ⇒ mismo fail-closed, cero órdenes', () => {
    resetFs();
    const issue = 7213;
    bloquearGate(issue);
    const { r } = evaluar(issue, {
        ctx: { ok: true, comments: [firmaValida(issue)], lastEditedAt: null },
        reconcile: () => { throw new Error('skillsPorFase mal formado'); },
    });
    assert.equal(r.reason, 'error');
    assert.equal(ordenesEncoladas().length, 0);
    assert.equal(hb.listBlockedMarkers(issue).length, 1);
    resetFs();
});

test('CN-10 ter: deps ausentes / appendGateAudit que lanza ⇒ igual devuelve sin lanzar', () => {
    resetFs();
    const issue = 7214;
    bloquearGate(issue);
    assert.doesNotThrow(() => {
        const r = _evaluateLateSignoff({ issue, markers: hb.listBlockedMarkers(issue), now: T0, cfg: CFG, deps: {} });
        assert.equal(r.lifted, false);
        assert.equal(r.reason, 'error');
    });
    assert.doesNotThrow(() => {
        const r = _evaluateLateSignoff({
            issue, markers: hb.listBlockedMarkers(issue), now: T0 + 60 * 60000, cfg: CFG,
            deps: { io: { fetchSignoffContext: () => { throw new Error('x'); }, appendGateAudit: () => { throw new Error('disco lleno'); } } },
        });
        assert.equal(r.reason, 'error');
    });
    resetFs();
});

test('CN-11: marker sintético ⇒ reconcileBlockedMarkers lo descarta sin fabricar work-file ni reactivar skill', () => {
    resetFs();
    const issue = 7215;
    bloquearGate(issue);
    assert.equal(hb.listBlockedMarkers(issue)[0].synthetic, true, 'CA-11: listBlockedMarkers expone synthetic');
    const rec = hb.reconcileBlockedMarkers({ issue, unlocker: 'architect-signoff:late', skillsPorFase: SKILLS_POR_FASE });
    assert.deepEqual(rec.reconciled.map((r) => r.action), ['descartado']);
    for (const fase of FASES.definicion) {
        assert.deepEqual(fs.readdirSync(dir('definicion', fase, 'pendiente')), [], `pendiente/ de ${fase} vacío`);
    }
    assert.equal(hb.listBlockedMarkers(issue).length, 0);
    resetFs();
});

test('CA-12: sin markers ⇒ sin-marker y la entrada del throttle se purga', () => {
    resetFs();
    const issue = 7216;
    _lateSignoffState.set(issue, T0);
    const { r, spies } = evaluar(issue, { now: T0 + 1000 });
    assert.equal(r.reason, 'sin-marker');
    assert.equal(spies.fetch, 0);
    assert.equal(_lateSignoffState.has(issue), false);
    resetFs();
});

test('UX-F: las razones "sin re-consultar" son exactamente las que se resuelven antes de la red', () => {
    assert.deepEqual([..._lateSignoffState.keys()], []);
    assert.deepEqual([...LATE_SIGNOFF_NO_RECHECK_REASONS].sort(), ['bloqueo-mixto', 'marker-viejo', 'sin-marker', 'throttled']);
    for (const r of ['firma-no-settled', 'traza-no-disponible', 'traza-no-corrobora', 'reconcile-fallido', 'error']) {
        assert.equal(LATE_SIGNOFF_NO_RECHECK_REASONS.has(r), false, r);
    }
});

test('UX-C/UX-E/UX-I: builder del comentario — frases de SIGNAL_COPY, SIN fallback a keys crudas, "sin señales registradas", fecha fallback a now', () => {
    const conFrases = _buildLateSignoffComment({ signals: SIGNALS, signedAt: FIRMA_AT, designDecision });
    assert.ok(conFrases.includes('(plantea opciones excluyentes y no elige una; define dónde va a vivir un dato crítico)'));
    // UX-I (rev-2): una key que `listaSenales` no reconoce se DESCARTA; nunca
    // se renderiza cruda. Sin módulo tampoco hay fallback a keys.
    const desconocidas = _buildLateSignoffComment({ signals: ['clave-x', 'clave-y'], signedAt: FIRMA_AT, designDecision });
    assert.ok(desconocidas.includes('(sin señales registradas)'), desconocidas);
    assert.ok(!desconocidas.includes('clave-x'), 'UX-I: ninguna key cruda llega al comentario');
    const mixto = _buildLateSignoffComment({ signals: ['clave-x', 'dato-critico'], signedAt: FIRMA_AT, designDecision });
    assert.ok(mixto.includes('(define dónde va a vivir un dato crítico)'), mixto);
    const sinModulo = _buildLateSignoffComment({ signals: ['clave-x', 'clave-y'], signedAt: FIRMA_AT });
    assert.ok(sinModulo.includes('(sin señales registradas)'));
    const vacio = _buildLateSignoffComment({ signals: [], signedAt: FIRMA_AT, designDecision });
    assert.ok(vacio.includes('(sin señales registradas)'));
    assert.ok(!/\(\)/.test(vacio), 'nunca paréntesis vacíos');
    const sinFecha = _buildLateSignoffComment({ signals: SIGNALS, signedAt: '', now: T0, designDecision });
    assert.ok(sinFecha.includes(`se verificó en ${new Date(T0).toISOString()} `));
});

// =============================================================================
// Cableado estático en `pulpo.js` (patrón `human-block-reconcile-6448.test.js`)
// =============================================================================

const PULPO = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');

test('cableado: la rama PRESENTE invoca _evaluateLateSignoff con listBlockedMarkers y la rama AUSENTE sigue con github:label-removed (CN-7 / RS-4.8)', () => {
    const rama = PULPO.indexOf("} else if (live.estado === 'PRESENTE') {");
    assert.ok(rama > 0, 'la rama PRESENTE tiene que existir');
    const bloque = PULPO.slice(rama, rama + 3500);
    assert.ok(bloque.includes('_evaluateLateSignoff('), 'invoca el evaluador');
    assert.ok(bloque.includes('humanBlock.listBlockedMarkers(nIssue)'), 'RS-4.9: todos los markers, no findBlockedMarker');
    assert.ok(!bloque.includes('findBlockedMarker(nIssue).cause'), 'nunca cause del primer marker');
    assert.ok(bloque.includes('_resolveLateSignoffConfig(config.architect)'));
    assert.ok(bloque.includes('firma del arquitecto posterior a la escalada — bloqueo levantado solo (#7432)'));
    assert.ok(bloque.includes('sin re-consultar (${r.reason})'), 'UX-F variante "no miré"');
    assert.ok(bloque.includes('firma re-consultada, sin cambios (${r.reason})'), 'UX-F variante "miré y no alcanza"');
    assert.ok(bloque.includes('saltar = true'));

    // CN-7: la rama AUSENTE va ANTES y queda intacta.
    const ausente = PULPO.lastIndexOf("if (live.estado === 'AUSENTE') {", rama);
    assert.ok(ausente > 0 && ausente < rama, 'AUSENTE va antes que PRESENTE');
    const bloqueAusente = PULPO.slice(ausente, rama);
    assert.ok(bloqueAusente.includes("unlocker: 'github:label-removed'"), 'AUSENTE sigue reconciliando por label quitado');
    assert.ok(!bloqueAusente.includes('_evaluateLateSignoff'), 'AUSENTE no re-consulta la firma');
    assert.ok(!bloqueAusente.includes("action: 'comment'"), 'AUSENTE no encola comentario de traza');

    // NO_VERIFICABLE conserva el `continue` seco.
    const noVerif = PULPO.slice(rama, rama + 4000);
    assert.ok(noVerif.includes('sin re-notificar'), 'NO_VERIFICABLE: fail-closed sin gastar la segunda llamada');
});

test('cableado: authorized_by architect-signoff:late está en el evaluador y no hay Telegram entre el evaluador y su return lifted:true (RS-4.7)', () => {
    const ini = PULPO.indexOf('function _evaluateLateSignoff(');
    const fin = PULPO.indexOf('return { lifted: true', ini);
    assert.ok(ini > 0 && fin > ini);
    const cuerpo = PULPO.slice(ini, fin);
    assert.ok(cuerpo.includes("authorized_by: 'architect-signoff:late'"));
    assert.ok(cuerpo.includes('guardrail_authorized: true'));
    assert.ok(!/sendTelegram|notify[A-Z]\w*\(/.test(cuerpo), 'cero Telegram en el evaluador');
    assert.ok(cuerpo.indexOf('reconcileBlockedMarkers(') < cuerpo.indexOf("action: 'remove-label'"), 'RS-4.11: reconciliar ANTES de encolar');
    assert.ok(cuerpo.indexOf("action: 'remove-label'") < cuerpo.indexOf("lifted_by: 'late-signoff'"), 'RS-4.11: audit positivo al final');
});

test('cableado: config.yaml trae las claves con defaults 10/48 y config-schema.js no cambió (CA-7)', () => {
    const yaml = require('js-yaml');
    const cfg = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8'));
    assert.equal(cfg.architect.late_signoff_recheck_min, 10);
    assert.equal(cfg.architect.late_signoff_max_age_h, 48);
    const { architect: sinClaves } = { architect: { enabled: false, gate_mode: 'dry-run' } };
    assert.deepEqual(_resolveLateSignoffConfig(sinClaves), { recheckMin: 10, maxAgeH: 48, maxPerTick: 5 }, 'sin las claves, arranca con defaults');
    const schema = fs.readFileSync(path.join(__dirname, '..', 'config-schema.js'), 'utf8');
    assert.ok(!schema.includes('late_signoff'), 'config-schema.js no esquematiza las claves nuevas (additionalProperties:true)');
});


// =============================================================================
// rev-2 — `_sweepLateSignoff`: DISPARADOR PRIMARIO desde los markers locales
// (el search excluye `needs-human`; el rechazo de review sobre 9bf4af4b0)
// =============================================================================

/** Config del Pulpo mínima para el barrido (sólo lee `architect`). */
function configPulpo(architect = {}) {
    return { architect: { late_signoff_recheck_min: 10, late_signoff_max_age_h: 48, ...architect } };
}

/** Barrido con deps espiadas; `throttle` contado (CA-18). */
function barrer({ allowlistSet = null, architect = {}, now = T0 + 15 * 60000, state = _lateSignoffState, ...rest } = {}) {
    const { deps, spies } = fakeDeps(rest);
    spies.throttle = 0;
    deps.throttle = () => { spies.throttle += 1; };
    const out = _sweepLateSignoff({ allowlistSet, config: configPulpo(architect), now, state, deps });
    return { out, spies, deps };
}

function setBlockedAt(issue, iso) {
    for (const m of hb.listBlockedMarkers(issue)) {
        const meta = JSON.parse(fs.readFileSync(m.file + '.reason.json', 'utf8'));
        meta.blocked_at = iso;
        fs.writeFileSync(m.file + '.reason.json', JSON.stringify(meta));
    }
}

test('invariante documentado: buildIntakeSearchQueries() excluye needs-human en TODOS sus pases — la razón de existir del barrido', () => {
    const qs = buildIntakeSearchQueries();
    assert.ok(Array.isArray(qs) && qs.length >= 2, JSON.stringify(qs));
    assert.ok(qs.every((q) => q.includes('-label:needs-human')),
        `si alguien relaja esto, el camino secundario (rama PRESENTE) vuelve a alcanzar producción: ${JSON.stringify(qs)}`);
});

test('CA-13 (el escenario del review): sin ningún issue del search, el barrido levanta solo desde el marker local — payload con procedencia, UN comentario con las señales persistidas, lifted_by, state purgado, cero Telegram', () => {
    resetFs();
    const issue = 7113;
    // El gate persistió las señales en el marker (único productor, RS-C.2).
    const rep = bloquearGate(issue, { signals: ['alternativas-enumeradas', 'dato-critico'] });
    assert.deepEqual(rep.signals, ['alternativas-enumeradas', 'dato-critico']);

    const { out, spies } = barrer({
        ctx: { ok: true, comments: [firmaValida(issue)], lastEditedAt: null },
        audit: { available: true, corroborated: true },
    });

    assert.deepEqual(out, { candidates: 1, evaluated: 1, lifted: [issue], deferred: 0, error: null });
    assert.equal(spies.fetch, 1);
    assert.equal(hb.findBlockedMarker(issue), null, 'marker descartado');
    assert.equal(hb.listBlockedMarkers(issue).length, 0);

    const ordenes = ordenesEncoladas();
    const remove = ordenes.filter((o) => o.payload.action === 'remove-label');
    const comments = ordenes.filter((o) => o.payload.action === 'comment');
    assert.equal(remove.length, 1);
    assert.deepEqual(remove[0].payload, {
        action: 'remove-label', issue, label: hb.NEEDS_HUMAN_LABEL,
        guardrail_authorized: true, authorized_by: 'architect-signoff:late',
    });
    assert.equal(comments.length, 1, 'UN comentario');
    const body = comments[0].payload.body;
    assert.ok(body.includes('(plantea opciones excluyentes y no elige una; define dónde va a vivir un dato crítico)'),
        'CA-17: las frases de SIGNAL_COPY de las signals PERSISTIDAS (el barrido no tiene el veredicto):\n' + body);
    assert.ok(body.endsWith('<!-- agent: intake -->'));

    assert.equal(spies.audits.length, 1);
    assert.equal(spies.audits[0].lifted_by, 'late-signoff');
    assert.deepEqual(spies.audits[0].signals, ['alternativas-enumeradas', 'dato-critico']);
    assert.equal(_lateSignoffState.has(issue), false, 'state purgado');
    assert.equal(spies.telegram, 0, 'RS-4.7');
    assert.ok(spies.logs.some((l) => l.includes(`♻️ #${issue} firma del arquitecto posterior a la escalada — bloqueo levantado solo (#7432)`)));
    assert.ok(spies.logs.some((l) => l.includes('[late-signoff] 1 bloqueado(s) del gate, 1 re-consultado(s), 1 levantado(s)')), spies.logs.join('\n'));
    resetFs();
});

test('CA-14: allowlistSet (pausa parcial) que NO contiene el issue ⇒ candidates:0 y fetchSignoffContext no invocado', () => {
    resetFs();
    bloquearGate(7113, { signals: ['dato-critico'] });
    const { out, spies } = barrer({
        allowlistSet: new Set(['7200', '7300']),
        ctx: { ok: true, comments: [firmaValida(7113)], lastEditedAt: null },
    });
    assert.deepEqual(out, { candidates: 0, evaluated: 0, lifted: [], deferred: 0, error: null });
    assert.equal(spies.fetch, 0);
    assert.equal(spies.throttle, 0);
    assert.equal(ordenesEncoladas().length, 0);
    assert.equal(hb.listBlockedMarkers(7113).length, 1, 'marker intacto');
    assert.ok(!spies.logs.some((l) => l.includes('[late-signoff]')), 'sin candidatos no hay resumen');

    // Con el issue en la ola sí es candidato (mismo R-5 de #5113 que brazoDesbloqueoImpl).
    const dentro = barrer({ allowlistSet: new Set(['7113']), ctx: { ok: true, comments: [firmaValida(7113)], lastEditedAt: null } });
    assert.equal(dentro.out.candidates, 1);
    assert.deepEqual(dentro.out.lifted, [7113]);
    resetFs();
});

test('CA-15 (RS-4.13): 7 issues due con tope 5 ⇒ 5 evaluados (los más viejos primero), 2 diferidos; el segundo barrido evalúa exactamente los 2 restantes', () => {
    resetFs();
    const issues = [7301, 7302, 7303, 7304, 7305, 7306, 7307];
    // blocked_at distintos: 7307 es el MÁS viejo, 7301 el más nuevo.
    issues.forEach((n, i) => {
        bloquearGate(n, { signals: ['dato-critico'] });
        setBlockedAt(n, new Date(T0 - (i + 1) * 60000).toISOString());
    });
    const evaluados = [];
    const ctx = (n) => { evaluados.push(n); return { ok: true, comments: [], lastEditedAt: null }; };   // sin firma: no levanta

    const primero = barrer({ ctx, architect: { late_signoff_max_issues_per_tick: 5 } });
    assert.equal(primero.out.candidates, 7);
    assert.equal(primero.out.evaluated, 5);
    assert.equal(primero.out.deferred, 2);
    assert.deepEqual(evaluados, [7307, 7306, 7305, 7304, 7303], 'orden determinístico: blocked_at más viejo primero');
    assert.equal(primero.spies.fetch, 5);
    assert.equal(primero.spies.throttle, 5, 'CA-18: un throttle por re-consulta');
    assert.ok(primero.spies.logs.some((l) => l.includes('7 bloqueado(s) del gate, 5 re-consultado(s), 0 levantado(s), 2 diferido(s) al próximo tick')),
        primero.spies.logs.join('\n'));

    // Segundo barrido inmediato: los 5 ya consultados están throttled ⇒ sólo los 2 restantes.
    evaluados.length = 0;
    const segundo = barrer({ ctx, architect: { late_signoff_max_issues_per_tick: 5 } });
    assert.equal(segundo.out.candidates, 7);
    assert.equal(segundo.out.evaluated, 2);
    assert.equal(segundo.out.deferred, 0);
    assert.deepEqual(evaluados, [7302, 7301]);
    // UX-H: el resumen lista los no re-consultados con su motivo, así `grep "#N"` funciona.
    const resumen = segundo.spies.logs.find((l) => l.includes('[late-signoff]'));
    assert.ok(resumen, segundo.spies.logs.join('\n'));
    for (const n of [7307, 7306, 7305, 7304, 7303]) assert.ok(resumen.includes(`#${n} throttled`), resumen);
    assert.ok(!resumen.includes('#7302') && !resumen.includes('#7301'), 'los re-consultados no van entre paréntesis');
    assert.ok(resumen.includes('2 re-consultado(s), 0 levantado(s)'));
    assert.ok(!segundo.spies.logs.some((l) => /#\d+ decisión de arquitectura ya escalada — sin re-consultar/.test(l)),
        'silencio por issue en throttled: sólo el resumen');

    // Config no positiva / no numérica ⇒ default 5.
    for (const v of [0, -1, 'abc', null, undefined]) {
        assert.equal(_resolveLateSignoffConfig({ late_signoff_max_issues_per_tick: v }).maxPerTick, 5, String(v));
    }
    assert.equal(_resolveLateSignoffConfig({ late_signoff_max_issues_per_tick: '3' }).maxPerTick, 3);
    assert.deepEqual(LATE_SIGNOFF_DEFAULTS, { recheckMin: 10, maxAgeH: 48, maxPerTick: 5 });
    resetFs();
});

test('CA-15 bis: marker-viejo figura en el resumen con su motivo y no consume slot ni red', () => {
    resetFs();
    bloquearGate(7308, { signals: ['dato-critico'] });
    setBlockedAt(7308, new Date(T0 - 72 * 3600000).toISOString());
    bloquearGate(7309, { signals: ['dato-critico'] });
    const { out, spies } = barrer({ now: T0 + 60000, ctx: { ok: true, comments: [], lastEditedAt: null } });
    assert.equal(out.candidates, 2);
    assert.equal(out.evaluated, 1);
    assert.equal(spies.fetch, 1);
    const resumen = spies.logs.find((l) => l.includes('[late-signoff]'));
    assert.ok(resumen.includes('2 bloqueado(s) del gate (#7308 marker-viejo), 1 re-consultado(s), 0 levantado(s)'), resumen);
    assert.ok(spies.logs.some((l) => l.includes('#7309 decisión de arquitectura ya escalada — firma re-consultada, sin cambios (firma-no-settled)')));
    resetFs();
});

test('CA-16 (fail-closed del levantamiento / fail-open del intake): listBlockedIssues que lanza ⇒ error poblado, no lanza, cero órdenes; deps ausentes ⇒ ídem', () => {
    resetFs();
    bloquearGate(7113, { signals: ['dato-critico'] });
    const roto = Object.assign(Object.create(hb), { listBlockedIssues: () => { throw new Error('disco roto'); } });
    const { out, spies } = barrer({ humanBlock: roto, ctx: { ok: true, comments: [firmaValida(7113)], lastEditedAt: null } });
    assert.equal(out.error, 'disco roto');
    assert.deepEqual({ ...out, error: null }, { candidates: 0, evaluated: 0, lifted: [], deferred: 0, error: null });
    assert.equal(spies.fetch, 0);
    assert.equal(ordenesEncoladas().length, 0);
    assert.equal(hb.listBlockedMarkers(7113).length, 1, 'se conserva todo bloqueo');
    assert.ok(spies.logs.some((l) => l.includes('[WARN] barrido de firmas tardías falló — se conserva todo bloqueo (fail-closed, #7440): disco roto')));

    // Sin deps: tampoco lanza.
    const sinDeps = _sweepLateSignoff({ config: configPulpo() });
    assert.equal(typeof sinDeps.error, 'string');
    assert.deepEqual(sinDeps.lifted, []);
    resetFs();
});

test('CA-16 estático: en brazoIntake, _sweepLateSignoff( va ANTES de buildIntakeSearchQueries() y dentro de un try, con ghThrottle como throttle y detrás de los guards paused/degraded', () => {
    const ini = PULPO.indexOf('function brazoIntake(');
    assert.ok(ini > 0);
    const fin = PULPO.indexOf('\nfunction ', ini + 10);
    const cuerpo = PULPO.slice(ini, fin);
    const sweep = cuerpo.indexOf('_sweepLateSignoff(');
    const search = cuerpo.indexOf('for (const search of buildIntakeSearchQueries())');   // la invocación real, no el comentario
    assert.ok(sweep > 0 && search > 0 && sweep < search, 'el barrido va ANTES del search');
    const tryPos = cuerpo.lastIndexOf('try {', sweep);
    assert.ok(tryPos > 0 && cuerpo.slice(tryPos, sweep).trim() === 'try {', 'envuelto en try {');
    assert.ok(cuerpo.indexOf("pipelineMode.mode === 'paused'") < sweep, 'detrás del guard paused');
    assert.ok(cuerpo.indexOf('pipelineMode.degraded === true') < sweep, 'detrás del guard degraded');
    assert.ok(cuerpo.indexOf('const allowlistSet') < sweep, 'después de calcular allowlistSet');
    const llamada = cuerpo.slice(sweep, cuerpo.indexOf('} catch', sweep));
    assert.ok(llamada.includes('throttle: ghThrottle'), 'ghThrottle inyectado');
    assert.ok(llamada.includes('allowlistSet, config'));
    assert.ok(llamada.includes('encolar: encolarOrdenGithub'));
    // El productor único de `signals` es el reportHumanBlock del gate (junto a `cause: causaDD`).
    const llamadas = [];
    for (let i = PULPO.indexOf('reportHumanBlock({'); i >= 0; i = PULPO.indexOf('reportHumanBlock({', i + 1)) {
        llamadas.push(PULPO.slice(i, PULPO.indexOf('});', i)));
    }
    const conSignals = llamadas.filter((c) => c.includes(' signals:'));
    assert.equal(conSignals.length, 1, `un solo productor de signals entre ${llamadas.length} llamadas a reportHumanBlock`);
    assert.ok(conSignals[0].includes('cause: causaDD') && conSignals[0].includes('signals: final.signals'));
});

test('CA-17: marker legacy sin `signals` ⇒ comentario "sin señales registradas"; con signals:[dato-critico] ⇒ la frase de SIGNAL_COPY', () => {
    resetFs();
    bloquearGate(7310);   // legacy: sin signals
    const legacy = barrer({ ctx: { ok: true, comments: [firmaValida(7310)], lastEditedAt: null } });
    assert.deepEqual(legacy.out.lifted, [7310]);
    const c1 = ordenesEncoladas().find((o) => o.payload.action === 'comment');
    assert.ok(c1.payload.body.includes('(sin señales registradas)'), c1.payload.body);
    resetFs();

    bloquearGate(7311, { signals: ['dato-critico'] });
    const nuevo = barrer({ ctx: { ok: true, comments: [firmaValida(7311)], lastEditedAt: null } });
    assert.deepEqual(nuevo.out.lifted, [7311]);
    const c2 = ordenesEncoladas().find((o) => o.payload.action === 'comment');
    assert.ok(c2.payload.body.includes('(define dónde va a vivir un dato crítico)'), c2.payload.body);
    resetFs();
});

test('CA-18: deps.throttle se invoca exactamente 1 vez por re-consulta y 0 veces cuando la razón está en LATE_SIGNOFF_NO_RECHECK_REASONS', () => {
    resetFs();
    bloquearGate(7312, { signals: ['dato-critico'] });
    const uno = barrer({ ctx: { ok: true, comments: [], lastEditedAt: null } });
    assert.equal(uno.out.evaluated, 1);
    assert.equal(uno.spies.throttle, 1);
    assert.equal(uno.spies.fetch, 1);
    // Throttled: ni throttle ni fetch.
    const dos = barrer({ ctx: { ok: true, comments: [], lastEditedAt: null } });
    assert.equal(dos.out.evaluated, 0);
    assert.equal(dos.spies.throttle, 0);
    assert.equal(dos.spies.fetch, 0);
    // Directo al evaluador con bloqueo mixto: tampoco.
    bloquearHumano(7312);
    const { deps, spies } = fakeDeps({ ctx: { ok: true, comments: [], lastEditedAt: null } });
    spies.throttle = 0; deps.throttle = () => { spies.throttle += 1; };
    _lateSignoffState.clear();
    const r = _evaluateLateSignoff({ issue: 7312, markers: hb.listBlockedMarkers(7312), signals: [], now: T0 + 3600000, cfg: CFG, deps });
    assert.equal(r.reason, 'bloqueo-mixto');
    assert.equal(spies.throttle, 0);
    // Un throttle que lanza no impide el fail-closed ni la re-consulta.
    resetFs();
    bloquearGate(7313, { signals: ['dato-critico'] });
    const d3 = fakeDeps({ ctx: { ok: true, comments: [firmaValida(7313)], lastEditedAt: null } });
    d3.deps.throttle = () => { throw new Error('throttle roto'); };
    const r3 = _evaluateLateSignoff({ issue: 7313, markers: hb.listBlockedMarkers(7313), signals: [], now: T0, cfg: CFG, deps: d3.deps });
    assert.equal(r3.lifted, true, JSON.stringify(r3));
    resetFs();
});

test('CN-12: issue con marker del gate + marker con otra causa ⇒ ni candidato (candidates:0) y listBlockedMarkers de ese issue no se consulta', () => {
    resetFs();
    bloquearGate(7314, { signals: ['dato-critico'] });
    bloquearHumano(7314);
    const consultados = [];
    const espiado = Object.assign(Object.create(hb), {
        listBlockedMarkers: (n) => { consultados.push(Number(n)); return hb.listBlockedMarkers(n); },
    });
    const { out, spies } = barrer({ humanBlock: espiado, ctx: { ok: true, comments: [firmaValida(7314)], lastEditedAt: null } });
    assert.deepEqual(out, { candidates: 0, evaluated: 0, lifted: [], deferred: 0, error: null });
    assert.deepEqual(consultados, [], 'el pre-filtro sale de listBlockedIssues, sin abrir los markers');
    assert.equal(spies.fetch, 0);
    assert.equal(hb.listBlockedMarkers(7314).length, 2, 'los dos markers intactos');
    assert.equal(ordenesEncoladas().length, 0);
    // Legacy sin cause tampoco es candidato (RS-4.1).
    resetFs();
    bloquearGate(7315, { cause: undefined });
    assert.equal(hb.listBlockedMarkers(7315)[0].cause, null);
    assert.equal(barrer({ ctx: { ok: true, comments: [firmaValida(7315)], lastEditedAt: null } }).out.candidates, 0);
    resetFs();
});

test('CN-13 (doble camino): barrido y luego _evaluateLateSignoff directo (rama PRESENTE) con el MISMO state ⇒ fetchSignoffContext invocado 1 sola vez', () => {
    resetFs();
    bloquearGate(7316, { signals: ['dato-critico'] });
    const ctx = { ok: true, comments: [], lastEditedAt: null };   // sin firma: el marker sigue vivo para el segundo camino
    const { spies } = barrer({ ctx });
    assert.equal(spies.fetch, 1);
    // La rama PRESENTE del mismo tick usa el mismo `_lateSignoffState` ⇒ throttled.
    const { deps, spies: s2 } = fakeDeps({ ctx });
    const r = _evaluateLateSignoff({ issue: 7316, markers: hb.listBlockedMarkers(7316), signals: ['dato-critico'], now: T0 + 15 * 60000 + 5000, cfg: CFG, deps });
    assert.equal(r.reason, 'throttled');
    assert.equal(s2.fetch, 0, 'cero llamadas extra dentro de la ventana');
    resetFs();
});

test('CN-14: marker sintético del gate descartado por el barrido no fabrica work-file ni reactiva skill (CN-11 vía el camino primario)', () => {
    resetFs();
    bloquearGate(7317, { signals: ['servicio-externo'] });
    const { out } = barrer({ ctx: { ok: true, comments: [firmaValida(7317)], lastEditedAt: null } });
    assert.deepEqual(out.lifted, [7317]);
    for (const [pipe, fases] of Object.entries(FASES)) {
        for (const fase of fases) {
            assert.deepEqual(fs.readdirSync(dir(pipe, fase, 'pendiente')), [], `${pipe}/${fase}/pendiente`);
            assert.deepEqual(fs.readdirSync(dir(pipe, fase, 'trabajando')), [], `${pipe}/${fase}/trabajando`);
        }
    }
    resetFs();
});

test('cableado: config.yaml trae late_signoff_max_issues_per_tick: 5 y config-schema.js sigue sin esquematizar las claves', () => {
    const yaml = require('js-yaml');
    const cfg = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8'));
    assert.equal(cfg.architect.late_signoff_max_issues_per_tick, 5);
    assert.deepEqual(_resolveLateSignoffConfig(cfg.architect), { recheckMin: 10, maxAgeH: 48, maxPerTick: 5 });
    assert.deepEqual(_resolveLateSignoffConfig({}), { recheckMin: 10, maxAgeH: 48, maxPerTick: 5 }, 'CA-7: sin claves, defaults');
    const schema = fs.readFileSync(path.join(__dirname, '..', 'config-schema.js'), 'utf8');
    assert.ok(!schema.includes('late_signoff'));
});

test.after(() => {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
});
