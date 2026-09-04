// =============================================================================
// gate-signature-inbox.test.js — Read model de la bandeja de firma (#6208).
//
// Cubre:
//   CA-1  — lista los pendientes REALES del depósito del kernel.
//   CA-1 + CA-3 / UX §2.4 — los TRES vacíos: leído-vacío / degraded / corrupt.
//           El verde SÓLO se gana habiendo leído la lista entera (H-UX-6208-1).
//   CA-2  — la redacción de la antigüedad se CONSUME de `decision-card` (#6190).
//   CA-3  — la edad sale de `created_at` con `nowMs` inyectado (H-UX-6208-2: el
//           depósito NO trae edad calculada; leerlo tal cual pinta todo fresco).
//   CA-4  — el ancla mostrada es la SERVER-DERIVED del depósito, y su tipo
//           técnico (`body-hash`/`commit-sha`) nunca sale a la cara del operador.
//   CA-10 — los estados pendiente/encolado/despachado se derivan del FILESYSTEM,
//           no de memoria: persisten al refresco.
//   D-4   — mientras no haya carrier, el copy NO nombra ningún medio.
//   §8    — la bandeja MERGEA con los markers; GATE 3 no desaparece.
//
// Todo con `fsImpl` / `approvalImpl` / `waitingImpl` inyectados: los tres vacíos
// se prueban sin tocar `config.yaml` (R7 — hoy los dos gates están en dry-run,
// así que `degraded` no se puede provocar por config).
//
// Se ejecuta con: node --test .pipeline/lib/__tests__/gate-signature-inbox.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const inbox = require('../gate-signature-inbox.js');
const decisionCard = require('../decision-card.js');

const T0 = Date.parse('2026-08-24T12:00:00.000Z');

function pendingFixture(over = {}) {
    return {
        gate: 'definicion',
        issue: 6208,
        title: 'GATE 1 · Definición de #6208 — Bandeja de firma del dashboard',
        question: '¿Admitís #6208 a desarrollo con estos criterios de aceptación?',
        anchor: { kind: 'body-hash', value: 'sha256:abcdef0123456789deadbeefcafe0001' },
        options: [
            { value: 'signed', label: 'Admitir a desarrollo' },
            { value: 're-definition', label: 'Devolver a definición' },
            { value: 'rejected', label: 'Rechazar la definición' },
        ],
        evidence: [{ kind: 'issue', ref: '6199' }],
        presented: { digest: 'sha256:x', truncated: false, truncation_notice: null, text: 'criterios...' },
        presentation_safe: true,
        created_at: new Date(T0 - 200 * 60000).toISOString(), // 3 h 20 min
        gate_mode: 'dry-run',
        ...over,
    };
}

/** `approvalImpl` de test: devuelve lo que le pasan, con los helpers reales. */
function fakeApproval(listed) {
    const real = require('../approval-channel.js');
    return {
        listPending: () => listed,
        isValidIssueId: real.isValidIssueId,
        resolveGate: real.resolveGate,
        DEFAULT_DEPOSIT_DIR: real.DEFAULT_DEPOSIT_DIR,
    };
}

function fakeWaiting(items) {
    return { listWaitingOperator: () => items };
}

function emptyDirs() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsi-'));
    return {
        dir,
        queueDir: path.join(dir, 'pendiente'),
        dispatchedDir: path.join(dir, 'despachado'),
    };
}

function run(listed, markers = [], over = {}) {
    const d = over.dirs || emptyDirs();
    return inbox.listInbox(
        { nowMs: T0, queueDir: d.queueDir, dispatchedDir: d.dispatchedDir, ...(over.opts || {}) },
        { approvalImpl: fakeApproval(listed), waitingImpl: fakeWaiting(markers), ...(over.deps || {}) },
    );
}

const OK_VACIO = { ok: true, pending: [], corrupt: [], degraded: false, alert: null };

// -----------------------------------------------------------------------------
// CA-1 — lista los pendientes reales del depósito
// -----------------------------------------------------------------------------
test('CA-1: lista los pendientes reales del depósito', () => {
    const r = run({ ...OK_VACIO, pending: [pendingFixture()] });
    assert.equal(r.items.length, 1);
    const row = r.items[0];
    assert.equal(row.kind, 'firma');
    assert.equal(row.firmable, true);
    assert.equal(row.issue, 6208);
    assert.equal(row.gate, 'definicion');
    assert.equal(row.title, pendingFixture().title);
    assert.equal(row.question, pendingFixture().question);
    assert.equal(r.firmables, 1);
    assert.equal(r.vacio, null);
});

test('CA-1: un pendiente con gate fuera del enum NO se lista', () => {
    const r = run({ ...OK_VACIO, pending: [pendingFixture({ gate: 'inventado' })] });
    assert.equal(r.items.length, 0);
});

test('CA-1: un pendiente con issue inválido NO se lista', () => {
    const r = run({ ...OK_VACIO, pending: [pendingFixture({ issue: '../etc/passwd' })] });
    assert.equal(r.items.length, 0);
});

test('CA-1: dos pendientes del mismo (issue, gate) se deduplican', () => {
    const r = run({ ...OK_VACIO, pending: [pendingFixture(), pendingFixture()] });
    assert.equal(r.items.length, 1);
});

// -----------------------------------------------------------------------------
// CA-2 / CA-3 — la edad sale de created_at con nowMs inyectado
// -----------------------------------------------------------------------------
test('CA-3: la edad sale de created_at con el nowMs inyectado (H-UX-6208-2)', () => {
    const r = run({ ...OK_VACIO, pending: [pendingFixture()] });
    assert.equal(r.items[0].edad, 'hace 3 h 20 min');
    // Otro `nowMs` ⇒ otro texto: la edad NO viene pre-calculada del depósito.
    const r2 = inbox.listInbox(
        { nowMs: T0 + 24 * 3600000, ...emptyDirs() },
        { approvalImpl: fakeApproval({ ...OK_VACIO, pending: [pendingFixture()] }), waitingImpl: fakeWaiting([]) },
    );
    assert.notEqual(r2.items[0].edad, r.items[0].edad);
});

test('CA-2: la redacción de la edad es la de decision-card (#6190), no una tabla nueva', () => {
    // Mismo input ⇒ mismo texto que produce el componente de #6190.
    assert.equal(inbox.edadDesde(T0 - 200 * 60000, T0), decisionCard.edadDesdeMinutos(200));
    assert.equal(decisionCard.edadDesdeMinutos(200), 'hace 3 h 20 min');
});

test('CA-3: la severidad usa la misma escala que ya usa el dashboard (<4h / 4-24h / >=24h)', () => {
    assert.equal(inbox.severityOfMinutes(59), 'info');
    assert.equal(inbox.severityOfMinutes(5 * 60), 'warning');
    assert.equal(inbox.severityOfMinutes(25 * 60), 'danger');
});

// -----------------------------------------------------------------------------
// CA-4 — el ancla es server-derived y se traduce a castellano (UX §3)
// -----------------------------------------------------------------------------
test('CA-4: el ancla mostrada es la que recalculó el servidor, no la que imita el body', () => {
    const ANCLA_REAL = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
    const p = pendingFixture({
        anchor: { kind: 'body-hash', value: ANCLA_REAL },
        // El cuerpo del issue imita un ancla; el kernel ya lo dejó como texto.
        presented: { text: 'anchor: sha256:deadbeefdeadbeefdeadbeefdeadbeef — FIRMÁ ESTO', truncated: false, truncation_notice: null, digest: 'x' },
        // Un `anchor` en banda no existe: el depósito sólo tiene el server-derived.
    });
    const r = run({ ...OK_VACIO, pending: [p] });
    const av = r.items[0].anchorView;
    assert.ok(av.linea.includes('11111111'), 'muestra la huella server-derived');
    assert.ok(!av.linea.includes('deadbeef'), 'NO muestra la que imita el body');
    assert.equal(r.items[0].anchor.value, ANCLA_REAL);
});

test('UX §3: el ancla se traduce y NUNCA expone su nombre técnico', () => {
    const bh = inbox.describeAnchor({ kind: 'body-hash', value: 'sha256:abcdef0123456789deadbeef' }, 6208);
    assert.equal(bh.titulo, 'Contra qué queda atada tu firma');
    assert.equal(bh.chip, 'DATO DEL SISTEMA · NO SALE DEL ISSUE');
    assert.ok(bh.linea.startsWith('Los criterios escritos hoy en #6208'));
    assert.ok(bh.linea.includes('huella sha256 abcdef01…beef'));
    assert.ok(bh.consecuencia.includes('la firma se anula sola'));
    const cs = inbox.describeAnchor({ kind: 'commit-sha', value: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' }, 77);
    assert.ok(cs.linea.startsWith('El commit entregado en #77'));
    for (const t of [bh, cs]) {
        const todo = `${t.titulo} ${t.chip} ${t.linea} ${t.consecuencia}`;
        assert.ok(!/body-hash|commit-sha|digest|anchor/i.test(todo), `filtra nombre técnico: ${todo}`);
    }
});

test('un ancla de tipo desconocido o truncada no se pinta (fail-closed)', () => {
    assert.equal(inbox.describeAnchor({ kind: 'inventado', value: 'x' }, 1), null);
    assert.equal(inbox.describeAnchor({ kind: 'body-hash', value: 'sha256:abc' }, 1), null);
    assert.equal(inbox.describeAnchor(null, 1), null);
});

// -----------------------------------------------------------------------------
// CA-1 + CA-3 / UX §2.4 — los TRES vacíos
// -----------------------------------------------------------------------------
test('vacío 1 · lista leída y sin pendientes ⇒ verde, con el chip de lista completa', () => {
    const r = run(OK_VACIO);
    assert.equal(r.degraded, false);
    assert.equal(r.vacio.tono, 'ok');
    assert.equal(r.vacio.titulo, 'Nada esperando tu firma');
    assert.equal(r.vacio.chip, 'LISTA LEÍDA COMPLETA');
    assert.ok(r.vacio.lineas.some(l => l.includes('Leí la lista entera')));
});

test('vacío 2 · degraded ⇒ NUNCA verde: dice que no significa que esté todo firmado (H-UX-6208-1)', () => {
    const r = run({ ok: true, pending: [], corrupt: [], degraded: true, alert: 'no pude leer el depósito' });
    assert.equal(r.degraded, true);
    assert.equal(r.vacio.tono, 'warn');
    assert.equal(r.vacio.titulo, 'No pude leer la lista de firmas pendientes');
    assert.ok(r.vacio.lineas.some(l => l.includes('no quiere decir que esté todo firmado')));
    assert.equal(r.vacio.chip, 'RETENIDO · REVISAR EL DEPÓSITO');
    assert.equal(r.alert, 'no pude leer el depósito');
});

test('vacío 2b · listPending que devuelve ok:false también degrada (fail-closed)', () => {
    const r = run({ ok: false, pending: [], corrupt: [], degraded: true, alert: 'ENOENT' });
    assert.equal(r.degraded, true);
    assert.equal(r.vacio.tono, 'warn');
});

test('vacío 2c · listPending que EXPLOTA degrada en vez de mostrar el verde', () => {
    const d = emptyDirs();
    const r = inbox.listInbox(
        { nowMs: T0, queueDir: d.queueDir, dispatchedDir: d.dispatchedDir },
        {
            approvalImpl: {
                listPending: () => { throw new Error('boom'); },
                isValidIssueId: require('../approval-channel.js').isValidIssueId,
                resolveGate: require('../approval-channel.js').resolveGate,
                DEFAULT_DEPOSIT_DIR: require('../approval-channel.js').DEFAULT_DEPOSIT_DIR,
            },
            waitingImpl: fakeWaiting([]),
        },
    );
    assert.equal(r.degraded, true);
    assert.equal(r.vacio.tono, 'warn');
    assert.match(r.alert, /No pude leer el depósito/);
});

test('vacío 3 · corrupt ⇒ banda ARRIBA de la lista que CONVIVE con las filas legibles', () => {
    const r = run({ ok: true, pending: [pendingFixture()], corrupt: [{ file: 'a.json', reason: 'x' }, { file: 'b.json', reason: 'y' }], degraded: false, alert: null });
    assert.equal(r.items.length, 1, 'la banda NO reemplaza a la lista');
    assert.equal(r.vacio, null);
    assert.equal(r.corruptCount, 2);
    assert.equal(r.banda.titulo, 'Hay 2 pedidos que no pude leer');
    assert.ok(r.banda.lineas.some(l => l.includes('no desaparecieron')));
    assert.equal(r.banda.chip, '1 VISIBLES · 2 ILEGIBLES');
});

test('bandaCorrupta concuerda en singular', () => {
    assert.equal(inbox.bandaCorrupta(1, 3).titulo, 'Hay 1 pedido que no pude leer');
});

// -----------------------------------------------------------------------------
// CA-10 — los estados se derivan del FILESYSTEM (persisten al refresco)
// -----------------------------------------------------------------------------
test('CA-10 · estado `pendiente`: nadie tocó nada todavía', () => {
    const r = run({ ...OK_VACIO, pending: [pendingFixture()] });
    assert.equal(r.items[0].estado, 'pendiente');
    assert.equal(r.items[0].estado_copy.titulo, 'Espera tu firma');
});

test('CA-10 · estado `encolado`: sale del pedido en gate-signature/pendiente, no de memoria', () => {
    const d = emptyDirs();
    fs.mkdirSync(d.queueDir, { recursive: true });
    fs.writeFileSync(path.join(d.queueDir, '6208-definicion-signed-1.json'), JSON.stringify({
        type: 'gate_signature_request', issue: 6208, gate: 'definicion', verdict: 'signed', created_at: T0 - 60000,
    }), 'utf8');

    const r = run({ ...OK_VACIO, pending: [pendingFixture()] }, [], { dirs: d });
    assert.equal(r.items[0].estado, 'encolado');
    assert.equal(r.items[0].estado_verdict, 'signed');
    // D-4 — el copy nombra el ESTADO REAL, no un medio que no está conectado.
    assert.equal(r.items[0].estado_copy.titulo, 'Anotada tu decisión — falta confirmarla');
    assert.ok(!/telegram/i.test(JSON.stringify(r.items[0].estado_copy)), 'D-4: no nombra Telegram sin carrier');
});

test('CA-10 · estado `despachado`: pisa al encolado y nombra el medio que devolvió el carrier', () => {
    const d = emptyDirs();
    fs.mkdirSync(d.queueDir, { recursive: true });
    fs.mkdirSync(d.dispatchedDir, { recursive: true });
    fs.writeFileSync(path.join(d.queueDir, '6208-definicion-signed-1.json'), JSON.stringify({
        type: 'gate_signature_request', issue: 6208, gate: 'definicion', verdict: 'signed', created_at: T0 - 60000,
    }), 'utf8');
    fs.writeFileSync(path.join(d.dispatchedDir, '6208-definicion.json'), JSON.stringify({
        type: 'gate_signature_dispatch', issue: 6208, gate: 'definicion', verdict: 'signed',
        carrier: 'telegram', dispatched_at: T0 - 10000,
    }), 'utf8');

    const r = run({ ...OK_VACIO, pending: [pendingFixture()] }, [], { dirs: d });
    assert.equal(r.items[0].estado, 'despachado');
    assert.equal(r.items[0].estado_carrier, 'telegram');
    assert.ok(r.items[0].estado_copy.titulo.startsWith('Te lo mandé a telegram'));
});

test('CA-10 · la fila NO se marca resuelta por haber decidido: sigue visible y firmable en la lista', () => {
    const d = emptyDirs();
    fs.mkdirSync(d.queueDir, { recursive: true });
    fs.writeFileSync(path.join(d.queueDir, 'x.json'), JSON.stringify({
        type: 'gate_signature_request', issue: 6208, gate: 'definicion', verdict: 'rejected', created_at: T0,
    }), 'utf8');
    const r = run({ ...OK_VACIO, pending: [pendingFixture()] }, [], { dirs: d });
    assert.equal(r.items.length, 1, 'la fila sigue en la bandeja');
    assert.equal(r.items[0].firmable, true);
    assert.notEqual(r.items[0].estado, 'firmado');
});

test('CA-10 · un pedido corrupto en la cola de estado no rompe la bandeja', () => {
    const d = emptyDirs();
    fs.mkdirSync(d.queueDir, { recursive: true });
    fs.writeFileSync(path.join(d.queueDir, 'roto.json'), '{{{', 'utf8');
    const r = run({ ...OK_VACIO, pending: [pendingFixture()] }, [], { dirs: d });
    assert.equal(r.items[0].estado, 'pendiente');
});

test('readDecisionState ignora pedidos de otro tipo, gate inválido o veredicto ajeno', () => {
    const d = emptyDirs();
    fs.mkdirSync(d.queueDir, { recursive: true });
    fs.writeFileSync(path.join(d.queueDir, 'a.json'), JSON.stringify({ type: 'otro', issue: 1, gate: 'definicion', verdict: 'signed' }), 'utf8');
    fs.writeFileSync(path.join(d.queueDir, 'b.json'), JSON.stringify({ type: 'gate_signature_request', issue: 1, gate: '../x', verdict: 'signed' }), 'utf8');
    fs.writeFileSync(path.join(d.queueDir, 'c.json'), JSON.stringify({ type: 'gate_signature_request', issue: 1, gate: 'aceptacion', verdict: 're-definition' }), 'utf8');
    const m = inbox.readDecisionState(d.queueDir, d.dispatchedDir, fs);
    assert.equal(m.size, 0);
});

// -----------------------------------------------------------------------------
// §8 — la bandeja MERGEA, no reemplaza (GATE 3 no desaparece)
// -----------------------------------------------------------------------------
test('§8: merge con los markers sin perder GATE 3', () => {
    const markers = [
        { issue: 4321, origen: 'gate3', gate: 'GATE 3', phase: 'dev', pipeline: 'desarrollo', skill: 'x', evidencia: [], sugerencia: null, age_hours: 2 },
    ];
    const r = run({ ...OK_VACIO, pending: [pendingFixture()] }, markers);
    assert.equal(r.items.length, 2);
    const g3 = r.items.find(i => i.issue === 4321);
    assert.equal(g3.kind, 'marker');
    assert.equal(g3.firmable, false);
    assert.deepEqual(g3.options, []);
    assert.ok(g3.no_firmable_copy.titulo.includes('no se firma desde la bandeja'));
    assert.ok(g3.no_firmable_copy.lineas.join(' ').includes('No te pongo un botón de firmar que el sistema va a rechazar'));
});

test('§8: un marker del mismo (issue, gate) que ya tiene pendiente real NO se duplica', () => {
    const markers = [
        { issue: 6208, origen: 'waiting-operator-def', gate: 'GATE 1', phase: 'criterios', pipeline: 'definicion', skill: 'po', evidencia: [], sugerencia: null, age_hours: 1 },
    ];
    const r = run({ ...OK_VACIO, pending: [pendingFixture()] }, markers);
    assert.equal(r.items.length, 1, 'manda el firmable');
    assert.equal(r.items[0].firmable, true);
});

test('§8: sin pendientes reales, los markers siguen apareciendo (no se pierde la bandeja de hoy)', () => {
    const markers = [
        { issue: 100, origen: 'waiting-operator-acc', gate: 'GATE 2', phase: 'entrega', pipeline: 'desarrollo', skill: 'delivery', evidencia: [], sugerencia: null, age_hours: 30 },
    ];
    const r = run(OK_VACIO, markers);
    assert.equal(r.items.length, 1);
    assert.equal(r.vacio, null, 'con filas no hay empty-state');
});

test('§8: un waitingImpl que explota no tumba la bandeja', () => {
    const d = emptyDirs();
    const r = inbox.listInbox(
        { nowMs: T0, queueDir: d.queueDir, dispatchedDir: d.dispatchedDir },
        {
            approvalImpl: fakeApproval({ ...OK_VACIO, pending: [pendingFixture()] }),
            waitingImpl: { listWaitingOperator: () => { throw new Error('boom'); } },
        },
    );
    assert.equal(r.items.length, 1);
});

// -----------------------------------------------------------------------------
// REQ-SEC-6208-1 — la señal de inyección se LEE, no se recalcula
// -----------------------------------------------------------------------------
test('REQ-SEC-6208-1: la señal de presentación se propaga tal cual desde el depósito', () => {
    const r = run({ ...OK_VACIO, pending: [pendingFixture({ presentation_safe: false, presentation_alert: 'Firma retenida: texto sospechoso' })] });
    assert.equal(r.items[0].presentation_safe, false);
    assert.equal(r.items[0].presentation_alert, 'Firma retenida: texto sospechoso');
});

test('REQ-SEC-6208-1: un pendiente sin la señal se trata como seguro (el kernel no la marcó)', () => {
    const p = pendingFixture();
    delete p.presentation_safe;
    const r = run({ ...OK_VACIO, pending: [p] });
    assert.equal(r.items[0].presentation_safe, true);
});

// -----------------------------------------------------------------------------
// UX §2 campo 8 — las opciones salen del kernel con SU label
// -----------------------------------------------------------------------------
test('UX §2.8: las opciones (y sus labels) salen del depósito, no se derivan de la clave', () => {
    const r = run({ ...OK_VACIO, pending: [pendingFixture()] });
    assert.deepEqual(r.items[0].options.map(o => o.value), ['signed', 're-definition', 'rejected']);
    assert.equal(r.items[0].options[1].label, 'Devolver a definición');
});

// -----------------------------------------------------------------------------
// #6208 rev2 — el cuarto caso que faltaba: DEGRADADO **con filas**.
//
// Los tres vacíos ya cubrían "degradado y sin nada que mostrar" (el empty-state
// ámbar). Pero `vacio` es null en cuanto hay una fila, así que un depósito con
// el índice incompleto + un marker de GATE 3 se pintaba como una bandeja normal:
// el operador leía la lista como completa. Es el mismo invariante de UX §5 ("un
// depósito ilegible JAMÁS se pinta como todo firmado") aplicado al caso con filas.
// -----------------------------------------------------------------------------

const MARKER_G3 = {
    issue: 4321, origen: 'gate3', gate: 'GATE 3', phase: 'dev', pipeline: 'desarrollo',
    skill: 'x', evidencia: [], sugerencia: null, age_hours: 2,
};

test('#6208 rev2 · degraded CON filas ⇒ banda de aviso arriba de la lista (no se lee como completa)', () => {
    const r = run(
        { ok: true, pending: [], corrupt: [], degraded: true, alert: 'No pude leer 2 pendientes.' },
        [MARKER_G3],
    );

    assert.equal(r.degraded, true);
    assert.equal(r.items.length, 1, 'hay una fila, así que el empty-state no aplica');
    assert.equal(r.vacio, null, 'con filas no hay vacío que pintar…');
    assert.ok(r.banda, '…y por eso el aviso TIENE que ir en la banda');
    assert.equal(r.banda.tono, 'warn');
    assert.match(r.banda.titulo, /no pude leer/i);
    // El alert del kernel deja de morir en el objeto: se pinta.
    assert.ok(r.banda.lineas.some(l => l.includes('No pude leer 2 pendientes.')));
    assert.match(r.banda.chip, /INCOMPLETA/);
});

test('#6208 rev2 · degraded SIN filas sigue usando el vacío ámbar y NO duplica la banda', () => {
    const r = run({ ok: true, pending: [], corrupt: [], degraded: true, alert: 'x' }, []);

    assert.equal(r.items.length, 0);
    assert.equal(r.vacio, inbox.VACIOS.degradado, 'el empty-state ya lleva el mensaje');
    assert.equal(r.banda, null, 'no se dice dos veces lo mismo en la misma pantalla');
});

test('#6208 rev2 · lista completa CON filas ⇒ sin banda (el aviso no es ruido permanente)', () => {
    const r = run({ ...OK_VACIO, pending: [pendingFixture()] }, [MARKER_G3]);

    assert.equal(r.degraded, false);
    assert.ok(r.items.length >= 1);
    assert.equal(r.banda, null);
});

test('#6208 rev2 · con ilegibles concretos manda la banda de corruptos (dice cuántos son)', () => {
    const r = run(
        { ok: true, pending: [], corrupt: [{ file: 'a.json', reason: 'x' }], degraded: true, alert: 'y' },
        [MARKER_G3],
    );

    assert.ok(r.banda);
    assert.match(r.banda.chip, /ILEGIBLES/, 'el dato concreto gana sobre el genérico');
});

test('#6208 rev2 · un alert enorme del kernel se corta y no empuja las filas fuera de pantalla', () => {
    const alertLargo = 'M'.repeat(5000);
    const r = run({ ok: true, pending: [], corrupt: [], degraded: true, alert: alertLargo }, [MARKER_G3]);

    const linea = r.banda.lineas.find(l => l.startsWith('MMM'));
    assert.ok(linea, 'el alert se incluye');
    assert.ok(linea.length < 250, `el alert se trunca (largo real: ${linea.length})`);
    assert.ok(linea.endsWith('…'));
});
