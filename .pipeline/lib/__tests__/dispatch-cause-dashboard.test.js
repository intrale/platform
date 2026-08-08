'use strict';

// =============================================================================
// test-dispatch-cause-dashboard.js — Tests de la integración dashboard del
// artifact de causa declarada (#4709): detección por `dispatchCauseSlice` y
// escape del render (`renderDispatchCauseBanner`). Framework: node --test.
//
// Cubre AC-4/AC-6:
//   - El slice detecta el artifact `dispatch-cause.json` y lo normaliza.
//   - El slice degrada a `{ active:false }` ante artifact ausente/corrupto o
//     causa fuera del enum (fail-safe, no confiar en el disco).
//   - El render ESCAPA `detalle`/`label` (payload XSS `<img onerror>` neutralizado
//     en contexto texto Y atributo).
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const slices = require('../dashboard-slices');
const dc = require('../dispatch-cause');
const { renderDispatchCauseBanner } = require('../dispatch-cause-render');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dc-dash-'));
}

// #5400 — helpers para los artifacts de estado nuevos.
function escribirEstado(dir, nombre, obj) {
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, nombre), JSON.stringify(obj));
}
function escribirEstampa(dir, ts) {
    escribirEstado(dir, 'last-dispatch.json', { ts, issue: '5400', skill: 'pipeline-dev' });
}
function escribirStatusWatchdog(dir, obj) {
    escribirEstado(dir, 'dispatch-watchdog-status.json', obj);
}

// --- dispatchCauseSlice: detección -------------------------------------------

test('slice inactivo cuando no hay artifact', () => {
    const dir = tmpDir();
    assert.deepStrictEqual(slices.dispatchCauseSlice({}, { PIPELINE: dir }), { active: false });
});

test('slice detecta el artifact publicado y normaliza label/relTime', () => {
    const dir = tmpDir();
    dc.publish({
        pipelineDir: dir,
        snapshot: { anyLaunched: false, hayPendientes: true, gatesActivos: new Set([dc.CAUSAS.COOLDOWN]), detalles: { [dc.CAUSAS.COOLDOWN]: 'penalizado' } },
        now: 1_000_000,
    });
    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: 1_000_000 + 125_000 });
    assert.strictEqual(s.active, true);
    assert.strictEqual(s.causa, dc.CAUSAS.COOLDOWN);
    assert.strictEqual(s.label, 'En cooldown');
    assert.strictEqual(s.anomalia, false);
    assert.strictEqual(s.relTime, 'hace 2 min');
});

test('slice degrada a inactivo si el artifact trae una causa fuera del enum', () => {
    const dir = tmpDir();
    // Escribir a mano un artifact con causa inválida (simula corrupción/version vieja).
    fs.writeFileSync(dc.artifactPath(dir), JSON.stringify({ causa: 'valor_pirata', anomalia: false, ts: 1 }));
    assert.deepStrictEqual(slices.dispatchCauseSlice({}, { PIPELINE: dir }), { active: false });
});

test('slice degrada a inactivo ante artifact corrupto (no-JSON)', () => {
    const dir = tmpDir();
    fs.writeFileSync(dc.artifactPath(dir), 'no-es-json{{{');
    assert.deepStrictEqual(slices.dispatchCauseSlice({}, { PIPELINE: dir }), { active: false });
});

test('#4751: slice detecta MODO_OLA y lo muestra con su label (banner no se filtra)', () => {
    const dir = tmpDir();
    // MODO_OLA es silenciosa (no alerta a Telegram) pero SÍ se publica el banner.
    dc.publish({
        pipelineDir: dir,
        snapshot: { anyLaunched: false, hayPendientes: true, gatesActivos: new Set([dc.CAUSAS.MODO_OLA]), detalles: { [dc.CAUSAS.MODO_OLA]: 'sólo se despachan los issues de la ola activa' } },
        now: 2_000_000,
    });
    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: 2_000_000 });
    assert.strictEqual(s.active, true);
    assert.strictEqual(s.causa, dc.CAUSAS.MODO_OLA);
    assert.strictEqual(s.label, 'Modo de ejecución en olas');
    assert.strictEqual(s.anomalia, false);
    const html = renderDispatchCauseBanner(s);
    assert.match(html, /Modo de ejecución en olas/);
    assert.doesNotMatch(html, /Detenido por humano/i);
    assert.doesNotMatch(html, /pausa parcial/i);
});

test('slice marca anomalia y su label destacado', () => {
    const dir = tmpDir();
    dc.publish({ pipelineDir: dir, snapshot: { anyLaunched: false, hayPendientes: true, gatesActivos: new Set() }, now: 1 });
    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir });
    assert.strictEqual(s.anomalia, true);
    assert.strictEqual(s.causa, dc.CAUSAS.ANOMALIA);
    assert.match(s.label, /Anomal/);
});

// --- renderDispatchCauseBanner: escape XSS -----------------------------------

test('render vacío cuando el slice está inactivo', () => {
    assert.strictEqual(renderDispatchCauseBanner({ active: false }), '');
    assert.strictEqual(renderDispatchCauseBanner(null), '');
});

test('render ESCAPA payload XSS en detalle (texto y atributo)', () => {
    const html = renderDispatchCauseBanner({
        active: true,
        causa: dc.CAUSAS.BLOQUEO_DEPENDENCIA,
        label: 'Bloqueado por dependencia',
        detalle: '<img src=x onerror=alert(1)> "pwn"',
        anomalia: false,
        relTime: 'hace 1 min',
    });
    assert.ok(html.length > 0);
    assert.doesNotMatch(html, /<img src=x/, 'el <img> crudo no debe aparecer');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'el payload debe quedar escapado como texto');
    assert.match(html, /&quot;pwn&quot;/, 'las comillas del atributo title deben escaparse');
});

test('render de anomalía usa el color de alerta (destacado, UX-2)', () => {
    const html = renderDispatchCauseBanner({ active: true, causa: dc.CAUSAS.ANOMALIA, label: '⚠ Anomalía', anomalia: true });
    assert.match(html, /var\(--danger, #F85149\)/, 'la anomalía debe consumir el token de alerta');
});

test('render de causa normal NO usa el color de alerta', () => {
    const html = renderDispatchCauseBanner({ active: true, causa: dc.CAUSAS.REST_MODE, label: 'Modo descanso', anomalia: false });
    assert.doesNotMatch(html, /var\(--danger, #F85149\)/);
});

test('render escapa también un label malicioso', () => {
    const html = renderDispatchCauseBanner({ active: true, causa: dc.CAUSAS.SIN_AGENTES, label: '<script>x</script>', anomalia: false });
    assert.doesNotMatch(html, /<script>x<\/script>/);
    assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
});

// =============================================================================
// #5400 — Visibilidad del no-despacho y del estado del propio watchdog.
// =============================================================================

test('#5400 el slice expone tiempo desde el último despacho, causa y estado del watchdog', () => {
    const dir = tmpDir();
    dc.writeArtifact(dir, {
        causa: dc.CAUSAS.HALT_HUMANO, label: 'Detenido por humano',
        detalle: 'pausa preservada por restart', ts: 1_000_000, anomalia: false,
    });
    escribirEstampa(dir, 1_000_000);
    escribirStatusWatchdog(dir, { enabled: true, killSwitch: false, lastTickTs: 1_500_000 });

    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: 1_600_000 });
    assert.strictEqual(s.active, true);
    assert.strictEqual(s.causa, dc.CAUSAS.HALT_HUMANO);
    // Tiempo desde el último despacho (CA-6).
    assert.strictEqual(s.lastDispatchTs, 1_000_000);
    assert.strictEqual(s.lastDispatchAgeMs, 600_000);
    assert.strictEqual(s.lastDispatchRelTime, 'hace 10 min');
    // Estado del watchdog (SEC-5).
    assert.strictEqual(s.watchdogEnabled, true);
    assert.strictEqual(s.watchdogDegraded, false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('#5400 un watchdog apagado se muestra explícitamente aunque no haya causa declarada', () => {
    // El meta-bug: `enabled: false` desde el merge y nada lo avisaba. Ausencia
    // de banner NO puede seguir significando "todo OK".
    const dir = tmpDir();
    escribirStatusWatchdog(dir, { enabled: false, killSwitch: false, lastTickTs: 1_500_000 });
    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: 1_600_000 });
    assert.strictEqual(s.active, true, 'debe mostrarse aunque no haya causa');
    assert.strictEqual(s.causa, null);
    assert.strictEqual(s.watchdogDegraded, true);
    assert.strictEqual(s.watchdogReason, 'apagado');

    const html = renderDispatchCauseBanner(s);
    assert.match(html, /watchdog OFF — nadie vigila el despacho/);
    assert.match(html, /href="#ic-watchdog-off"/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('#5400 un watchdog con kill-switch o sin latido cuenta como degradado', () => {
    const dir = tmpDir();
    escribirStatusWatchdog(dir, { enabled: true, killSwitch: true, lastTickTs: 1_500_000 });
    let s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: 1_600_000 });
    assert.strictEqual(s.watchdogDegraded, true);
    assert.strictEqual(s.watchdogReason, 'kill-switch');

    // Brazo vivo por config pero sin latir hace más de 10 min → murió callado.
    escribirStatusWatchdog(dir, { enabled: true, killSwitch: false, lastTickTs: 1_000_000 });
    s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: 1_000_000 + 11 * 60_000 });
    assert.strictEqual(s.watchdogDegraded, true);
    assert.strictEqual(s.watchdogReason, 'sin latido');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('#5400 (rev-1) un watchdog vivo pero con el RELOJ degradado también se dice', () => {
    // Vigila igual, pero la estampa de despacho está ausente, corrida al futuro
    // o no se pudo escribir: la duración que informa es la mínima conocida.
    // Callarlo sería la misma clase de error que este issue vino a arreglar.
    const dir = tmpDir();
    escribirStatusWatchdog(dir, {
        enabled: true, killSwitch: false, lastTickTs: 1_500_000,
        degraded: true, stampState: 'missing',
    });
    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: 1_600_000 });
    assert.strictEqual(s.watchdogEnabled, true, 'sigue encendido');
    assert.strictEqual(s.watchdogStaleTick, false, 'y late');
    assert.strictEqual(s.watchdogDegraded, true);
    assert.strictEqual(s.watchdogReason, 'con reloj degradado');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('#5400 sin archivo de estado el watchdog reporta "no consta", no un OK inventado', () => {
    const dir = tmpDir();
    dc.writeArtifact(dir, {
        causa: dc.CAUSAS.MODO_OLA, label: 'Modo de ejecución en olas',
        detalle: '', ts: 1_000_000, anomalia: false,
    });
    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: 1_600_000 });
    assert.strictEqual(s.watchdogEnabled, null);
    assert.strictEqual(s.watchdogDegraded, null);
    assert.strictEqual(s.lastDispatchTs, null, 'sin estampa: no consta');

    const html = renderDispatchCauseBanner(s);
    assert.match(html, /estado no consta/);
    assert.match(html, /Último despacho: sin registro/);
    fs.rmSync(dir, { recursive: true, force: true });
});

// rev-11: este test traía `action: 'skip'` A SECAS y esperaba silencio sano.
// Esa expectativa ERA el bug: `skip` es la acción de cuatro situaciones y sólo
// `no-enabled-work` significa "no hay nada para despachar". Se le agrega la
// razón para que siga probando su intención real (watchdog sano + cola vacía →
// chip activo); el caso de `skip` sin razón lo cubre el test de más abajo.
test('#5400 sin causa y con el watchdog sano muestra el estado esperado y el chip activo', () => {
    const dir = tmpDir();
    escribirStatusWatchdog(dir, {
        enabled: true, killSwitch: false, lastTickTs: 1_600_000, action: 'skip',
        reason: 'no-enabled-work', pendientes: 0,
    });
    escribirEstampa(dir, 1_590_000);
    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: 1_600_000 });
    assert.strictEqual(s.active, true);
    assert.strictEqual(s.healthySilence, true);
    const html = renderDispatchCauseBanner(s);
    assert.match(html, /Cola sin trabajo elegible/);
    assert.match(html, /watchdog activo/);
    assert.match(html, /href="#ic-health-ok"/);
    fs.rmSync(dir, { recursive: true, force: true });
});

// rev-6 (S1/B3) — El silencio "sano" colgaba SÓLO de `degraded === false`, o sea
// de la salud del watchdog, no de la del pipeline. Un watchdog perfectamente vivo
// que está ALERTANDO por despacho detenido caía en la misma rama y se pintaba
// como silencio saludable: el banner decía "todo bien" mientras el control
// gritaba lo contrario.
test('#5400 (S1/B3) un watchdog sano que ALERTA no puede pintarse como silencio sano', () => {
    const dir = tmpDir();
    escribirStatusWatchdog(dir, {
        enabled: true, killSwitch: false, lastTickTs: 1_600_000, action: 'alert',
    });
    escribirEstampa(dir, 1_590_000);
    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: 1_600_000 });
    assert.strictEqual(s.watchdogDegraded, false, 'el watchdog en sí está sano');
    assert.strictEqual(s.watchdogAction, 'alert');
    assert.strictEqual(s.healthySilence, false, 'alertando NO es silencio sano');

    // rev-10 — ESTA es la aserción que faltaba y por la que el guard no vio la
    // regresión: el test verificaba el CAMPO de la slice, pero el render nunca lo
    // leía. Un campo correcto que nadie consume no protege al operador.
    const html = renderDispatchCauseBanner(s);
    assert.doesNotMatch(html, /nada que despachar no es una falla/,
        'el banner NO puede declarar salud mientras el watchdog alerta');
    assert.doesNotMatch(html, /Cola sin trabajo elegible/);
    assert.match(html, /sin causa declarada/);
    assert.match(html, /href="#ic-dispatch-stalled"/, 'estado "detención" del mockup 47');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('#5400 (S1/B3) un status sin `action` no afirma silencio sano', () => {
    const dir = tmpDir();
    escribirStatusWatchdog(dir, { enabled: true, killSwitch: false, lastTickTs: 1_600_000 });
    escribirEstampa(dir, 1_590_000);
    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: 1_600_000 });
    assert.strictEqual(s.watchdogAction, null);
    assert.strictEqual(s.healthySilence, false, 'sin decisión observada no se afirma salud');

    // rev-10 — sin decisión observada el banner tampoco inventa una alerta: dice
    // que no consta. Ausencia de dato no se rellena con un OK ni con un incendio.
    const html = renderDispatchCauseBanner(s);
    assert.doesNotMatch(html, /nada que despachar no es una falla/);
    assert.match(html, /Estado del despacho sin confirmar/);
    assert.match(html, /el watchdog no registró su última decisión/);
    fs.rmSync(dir, { recursive: true, force: true });
});

// =============================================================================
// rev-10 — Guard de la regresión del rechazo de QA: el banner pintaba "silencio
// sano" en verde en el MISMO instante en que Telegram avisaba "0 despacho hace
// 3 h. 9 issue(s) habilitado(s) esperando; 3 agente(s) en curso".
//
// La causa: `dispatch-cause-render.js` decidía la rama `sano` con
// `!slice.causa && slice.watchdogDegraded === false`, o sea con la salud del
// WATCHDOG, y nunca leía `healthySilence`. Un watchdog que alerta no está
// degradado: está haciendo exactamente su trabajo.
//
// Este test recorre la cadena completa (status del tick → slice → HTML) con el
// escenario que reprodujo el QA, y afirma sobre el TEXTO RENDERIZADO.
// =============================================================================
test('#5400 (rev-10) con el watchdog alertando por detención de 3 h el banner NO dice silencio sano', () => {
    const dir = tmpDir();
    const NOW = 1_700_000_000_000;
    const MS_3H = 180 * 60_000;
    // Escenario E del QA: agentes clavados en `trabajando/`, sin causa declarada
    // (el artifact fue borrado por clearArtifact), watchdog vivo y alertando.
    escribirEstado(dir, 'last-dispatch.json', {
        ts: NOW - MS_3H, issue: '5388', skill: 'pipeline-dev', fase: 'dev',
    });
    escribirStatusWatchdog(dir, {
        enabled: true, killSwitch: false, lastTickTs: NOW - 20_000,
        degraded: false, action: 'alert', reason: 'unexplained-stall',
        episodeId: '9c11', alertCount: 1,
        lastAlertTs: NOW - 60_000, nextAlertTs: NOW + 29 * 60_000,
        alertThresholdMinutes: 20, pendientes: 9, dispatching: 3,
    });

    const s = slices.dispatchCauseSlice(null, { PIPELINE: dir, nowMs: NOW });
    assert.strictEqual(s.causa, null, 'no hay causa declarada');
    assert.strictEqual(s.watchdogDegraded, false, 'el watchdog está sano');
    assert.strictEqual(s.healthySilence, false);

    const html = renderDispatchCauseBanner(s);
    const texto = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // 1. Lo prohibido: declarar salud mientras el control grita.
    assert.doesNotMatch(texto, /nada que despachar no es una falla/);
    assert.doesNotMatch(texto, /Cola sin trabajo elegible/);
    // 2. El banner cuenta el MISMO episodio que Telegram: duración y elegibles.
    assert.match(texto, /Cola sin despachar hace 3 h — sin causa declarada/);
    assert.match(texto, /9 issues elegibles esperando/);
    assert.match(texto, /#5388 pipeline-dev/);
    // 3. Backoff verificable del mismo episodio (CA-4).
    assert.match(texto, /aviso 1 del episodio 9c11/);
    // 4. El chip sigue diciendo la verdad sobre el watchdog: está activo.
    assert.match(html, /watchdog activo/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('#5400 (rev-10) una detención ESCALADA sin causa se pinta con semántica grave', () => {
    const dir = tmpDir();
    const NOW = 1_700_000_000_000;
    escribirEstado(dir, 'last-dispatch.json', { ts: NOW - 300 * 60_000, issue: '5388', skill: 'pipeline-dev' });
    escribirStatusWatchdog(dir, {
        enabled: true, killSwitch: false, lastTickTs: NOW, degraded: false,
        action: 'escalate', reason: 'stale-declared-cause', pendientes: 9,
    });
    const s = slices.dispatchCauseSlice(null, { PIPELINE: dir, nowMs: NOW });
    const html = renderDispatchCauseBanner(s);
    assert.match(html, /Sin despachar hace 5 h — sin causa declarada/);
    assert.match(html, /var\(--danger/, 'escalada ⇒ semántica danger del mockup 47');
    assert.doesNotMatch(html, /nada que despachar no es una falla/);
    fs.rmSync(dir, { recursive: true, force: true });
});

// El caso legítimo NO se rompe: cola vacía + watchdog que decidió `skip`.
test('#5400 (rev-10) el silencio realmente sano sigue pintándose sano', () => {
    const dir = tmpDir();
    const NOW = 1_700_000_000_000;
    escribirEstampa(dir, NOW - 10 * 60_000);
    escribirStatusWatchdog(dir, {
        enabled: true, killSwitch: false, lastTickTs: NOW, degraded: false,
        action: 'skip', reason: 'no-enabled-work', pendientes: 0,
    });
    const s = slices.dispatchCauseSlice(null, { PIPELINE: dir, nowMs: NOW });
    assert.strictEqual(s.healthySilence, true);
    const html = renderDispatchCauseBanner(s);
    assert.match(html, /Cola sin trabajo elegible/);
    assert.match(html, /nada que despachar no es una falla/);
    assert.match(html, /href="#ic-health-ok"/);
    fs.rmSync(dir, { recursive: true, force: true });
});

// Invariante de la capa de render, independiente de la slice: la rama de salud
// se decide SÓLO por `healthySilence`. Si alguien vuelve a colgarla de
// `watchdogDegraded`, este test cae.
test('#5400 (rev-10) ningún estado sin `healthySilence:true` puede renderizar el copy de salud', () => {
    const combinaciones = [
        { watchdogDegraded: false, watchdogAction: 'alert' },
        { watchdogDegraded: false, watchdogAction: 'escalate' },
        { watchdogDegraded: false, watchdogAction: null },
        { watchdogDegraded: false },
        { watchdogDegraded: true, watchdogAction: 'skip' },
        { watchdogDegraded: null, watchdogAction: 'skip' },
        { watchdogDegraded: false, watchdogAction: 'skip', healthySilence: false },
    ];
    for (const wd of combinaciones) {
        const html = renderDispatchCauseBanner({ active: true, causa: null, ...wd });
        assert.doesNotMatch(html, /nada que despachar no es una falla/,
            `pintó salud con ${JSON.stringify(wd)}`);
    }
    // Y con el campo en true, sí.
    assert.match(
        renderDispatchCauseBanner({ active: true, causa: null, healthySilence: true, watchdogDegraded: false }),
        /nada que despachar no es una falla/,
    );
});

test('#5400 causa y autoría se renderizan escapadas', () => {
    const html = renderDispatchCauseBanner({
        active: true,
        causa: dc.CAUSAS.HALT_HUMANO,
        label: '<img src=x onerror=alert(1)>',
        detalle: '"><script>pwn()</script>',
        lastDispatchRelTime: '<b>hace 2 h</b>',
        watchdogDegraded: true,
        watchdogReason: '<svg onload=alert(2)>',
    });
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<script>pwn/);
    assert.doesNotMatch(html, /<svg onload/);
    assert.doesNotMatch(html, /<b>hace 2 h<\/b>/);
    assert.match(html, /&lt;svg onload=alert\(2\)&gt;/);
    assert.match(html, /&lt;b&gt;hace 2 h&lt;\/b&gt;/);
});

test('#5400 una causa escalada por duración se destaca como grave', () => {
    const normal = renderDispatchCauseBanner({
        active: true, causa: dc.CAUSAS.MODO_OLA, label: 'Modo ola', escaladoPorDuracion: false,
    });
    assert.doesNotMatch(normal, /var\(--danger, #F85149\)/);
    const escalada = renderDispatchCauseBanner({
        active: true, causa: dc.CAUSAS.MODO_OLA, label: 'Modo ola', escaladoPorDuracion: true,
    });
    assert.match(escalada, /var\(--danger, #F85149\)/, 'una causa sostenida usa el token de peligro');
});

test('#5400 el banner consume el sistema de tokens visuales', () => {
    const html = renderDispatchCauseBanner({
        active: true, causa: dc.CAUSAS.ANOMALIA, label: 'Anomalía', anomalia: true,
        watchdogDegraded: false,
    });
    assert.match(html, /var\(--danger, #F85149\)/);
    assert.match(html, /var\(--danger-bg, rgba\(248, 81, 73, 0\.14\)\)/);
    assert.match(html, /var\(--success, #3FB950\)/);
    assert.match(html, /var\(--text-secondary, #B1BAC4\)/);
});

// =============================================================================
// #5400 (rev-8) — QA visual contra el mockup 47 (#4568). El banner rompía tres
// reglas de copy que el propio mockup versionado en el PR declara inquebrantables.
// =============================================================================

// BLOQUEANTE rev-7: `formatRelativeAge` era de UNA unidad, así que el episodio de
// 1h33 que ORIGINÓ el issue se mostraba como "hace 1 h" — 33 minutos de detención
// evaporados — mientras Telegram decía "1 h 33 min" por el mismo hecho.
test('#5400 la duración del banner va en dos unidades: 93 min es "1 h 33 min", nunca "1 h"', () => {
    const dir = tmpDir();
    const NOW = 1_700_000_000_000;
    const MS_1H33 = 93 * 60_000;
    // Mismo caso que reprodujo el QA visual: 1h33, escalado por duración (A3).
    dc.writeArtifact(dir, {
        causa: dc.CAUSAS.HALT_HUMANO, label: 'Pausa total del pipeline',
        detalle: 'pausa preservada por restart', ts: NOW - MS_1H33, anomalia: false,
        escaladoPorDuracion: true,
    });
    escribirEstampa(dir, NOW - MS_1H33);

    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: NOW });
    assert.strictEqual(s.relTime, 'hace 1 h 33 min');
    assert.strictEqual(s.lastDispatchRelTime, 'hace 1 h 33 min');

    const html = renderDispatchCauseBanner(s);
    assert.match(html, /Sin despachar hace 1 h 33 min/,
        'el título tiene que llevar la duración exacta, no el redondeo');
    assert.doesNotMatch(html, /hace 1 h(?! 33)/, 'el redondeo a una unidad está prohibido');
    fs.rmSync(dir, { recursive: true, force: true });
});

// Regla de copy 7 del mockup: un episodio, una conversación. Dos duraciones
// distintas para el mismo hecho según dónde se lo mire queman la confianza en las
// dos superficies.
test('#5400 el banner y el aviso de Telegram cuentan el MISMO episodio con la MISMA duración', () => {
    const watchdog = require('../wave-stall-watchdog');
    const MS_1H33 = 93 * 60_000;
    const enTelegram = watchdog.formatDurationEs(MS_1H33);
    const enBanner = slices.__test__formatRelativeAge(MS_1H33);
    assert.strictEqual(enTelegram, '1 h 33 min');
    assert.strictEqual(enBanner, `hace ${enTelegram}`,
        'el banner tiene que usar el MISMO formateador que el canal');
});

test('#5400 la granularidad de dos unidades se sostiene en todo el rango', () => {
    const f = slices.__test__formatRelativeAge;
    assert.strictEqual(f(45_000), 'hace 45 s');
    assert.strictEqual(f(12 * 60_000), 'hace 12 min');
    assert.strictEqual(f(60 * 60_000), 'hace 1 h', 'una hora exacta no inventa "0 min"');
    assert.strictEqual(f(93 * 60_000), 'hace 1 h 33 min');
    assert.strictEqual(f(185 * 60_000), 'hace 3 h 05 min', 'mockup 47 B2: minutos con cero a la izquierda');
});

// Delta 1 del rechazo: se perdía el "(sin verificar)", que es la mitigación de
// SEC-2 hecha visible — la autoría pelada se lee como un hecho auditado.
test('#5400 la autoría se muestra declarada, SIN VERIFICAR y con el instante de inicio', () => {
    const dir = tmpDir();
    const NOW = 1_700_000_000_000;
    dc.writeArtifact(dir, {
        causa: dc.CAUSAS.HALT_HUMANO, label: 'Pausa total del pipeline',
        detalle: '', ts: NOW - 93 * 60_000, anomalia: false,
    });
    escribirStatusWatchdog(dir, {
        enabled: true, killSwitch: false, lastTickTs: NOW,
        authorDeclared: 'leitolarreta', causeSinceTs: NOW - 93 * 60_000,
    });

    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: NOW });
    assert.strictEqual(s.autoriaDeclarada, 'leitolarreta');
    assert.strictEqual(s.autoriaDesdeTs, NOW - 93 * 60_000);

    const html = renderDispatchCauseBanner(s);
    assert.match(html, /autoría declarada: leitolarreta \(sin verificar, desde \d{2}:\d{2}\)/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('#5400 sin autoría registrada el banner JAMÁS atribuye la pausa a una persona', () => {
    const dir = tmpDir();
    dc.writeArtifact(dir, {
        causa: dc.CAUSAS.HALT_HUMANO, label: 'Pausa total del pipeline',
        detalle: '', ts: 1_000_000, anomalia: false,
    });
    escribirStatusWatchdog(dir, { enabled: true, killSwitch: false, lastTickTs: 1_600_000 });
    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: 1_600_000 });
    assert.strictEqual(s.autoriaDeclarada, null);

    const html = renderDispatchCauseBanner(s);
    assert.match(html, /autoría no registrada/);
    assert.doesNotMatch(html, /autoría declarada/);
    fs.rmSync(dir, { recursive: true, force: true });
});

// Delta 2 del rechazo: la estampa ya persiste issue/skill/fase y el banner los
// tiraba a la basura.
test('#5400 el banner nombra el issue y el skill del último despacho', () => {
    const dir = tmpDir();
    const NOW = 1_700_000_000_000;
    escribirEstado(dir, 'last-dispatch.json', {
        ts: NOW - 93 * 60_000, issue: '5388', skill: 'pipeline-dev', fase: 'dev',
    });
    dc.writeArtifact(dir, {
        causa: dc.CAUSAS.HALT_HUMANO, label: 'Pausa total del pipeline',
        detalle: '', ts: NOW - 93 * 60_000, anomalia: false,
    });

    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: NOW });
    assert.strictEqual(s.lastDispatchIssue, '5388');
    assert.strictEqual(s.lastDispatchSkill, 'pipeline-dev');
    assert.match(s.lastDispatchClock, /^\d{2}:\d{2}$/);

    const html = renderDispatchCauseBanner(s);
    assert.match(html, /Último despacho: \d{2}:\d{2} \(hace 1 h 33 min\) · #5388 pipeline-dev/);
    fs.rmSync(dir, { recursive: true, force: true });
});

// Delta 3 del rechazo: CA-4 (backoff verificable) no era verificable MIRANDO el
// dashboard. El operador no podía distinguir "el watchdog ya gritó" de "está mudo".
test('#5400 el banner muestra la línea de backoff: aviso emitido, número de aviso y próximo', () => {
    const dir = tmpDir();
    const NOW = 1_700_000_000_000;
    dc.writeArtifact(dir, {
        causa: dc.CAUSAS.HALT_HUMANO, label: 'Pausa total del pipeline',
        detalle: '', ts: NOW - 93 * 60_000, anomalia: false,
    });
    escribirStatusWatchdog(dir, {
        enabled: true, killSwitch: false, lastTickTs: NOW, action: 'alert',
        episodeId: '4f2a', alertCount: 1,
        lastAlertTs: NOW - 15 * 60_000, nextAlertTs: NOW + 15 * 60_000,
    });

    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: NOW });
    assert.strictEqual(s.episodioId, '4f2a');
    assert.strictEqual(s.avisosEmitidos, 1);

    const html = renderDispatchCauseBanner(s);
    assert.match(html, /avisado a Telegram \d{2}:\d{2}/);
    assert.match(html, /aviso 1 del episodio 4f2a/);
    assert.match(html, /próximo aviso no antes de \d{2}:\d{2}/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('#5400 bajo el umbral el banner anuncia CUÁNDO avisaría y aclara que no destraba', () => {
    const dir = tmpDir();
    const NOW = 1_700_000_000_000;
    dc.writeArtifact(dir, {
        causa: dc.CAUSAS.HALT_HUMANO, label: 'Pausa total del pipeline',
        detalle: '', ts: NOW - 12 * 60_000, anomalia: false,
    });
    escribirStatusWatchdog(dir, {
        enabled: true, killSwitch: false, lastTickTs: NOW, action: 'skip',
        alertCount: 0, alertEtaTs: NOW + 33 * 60_000, alertThresholdMinutes: 45,
    });

    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: NOW });
    assert.strictEqual(s.avisoEtaMin, 33);
    assert.strictEqual(s.avisoUmbralMin, 45);

    const html = renderDispatchCauseBanner(s);
    assert.match(html, /aviso a Telegram si sigue así en 33 min \(umbral 45 min\)/);
    assert.match(html, /el watchdog mira, no destraba/, 'SEC-3: nunca prometer destrabe');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('#5400 la línea de contexto escapa autoría, episodio e identidad del despacho', () => {
    const html = renderDispatchCauseBanner({
        active: true,
        causa: dc.CAUSAS.HALT_HUMANO,
        label: 'Pausa total',
        autoriaDeclarada: '<img src=x onerror=alert(1)>',
        autoriaDesdeClock: '<b>13:12</b>',
        lastDispatchIssue: '<script>a()</script>',
        lastDispatchSkill: '<svg onload=alert(2)>',
        avisosEmitidos: 1,
        episodioId: '<i>4f2a</i>',
        avisoUltimoClock: '14:45',
    });
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<script>a\(\)/);
    assert.doesNotMatch(html, /<svg onload/);
    assert.doesNotMatch(html, /<i>4f2a<\/i>/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('#5400 el banner usa los iconos del sprite y no emojis', () => {
    const html = renderDispatchCauseBanner({
        active: true,
        causa: dc.CAUSAS.HALT_HUMANO,
        label: 'Pausa total del pipeline',
        detalle: '7 issues elegibles esperando',
        relTime: 'hace 1 h',
        lastDispatchRelTime: 'hace 1 h',
        watchdogDegraded: false,
        escaladoPorDuracion: true,
    });
    assert.match(html, /href="#ic-dispatch-stalled"/);
    assert.match(html, /href="#ic-health-ok"/);
    assert.doesNotMatch(html, /⚠️|⏸️|▶️/u);
    assert.match(html, /dispatch-watchdog-chip/);
});

// =============================================================================
// rev-11 — Guard por RAZÓN de skip (BLOQUEANTE 1 del rechazo de review).
//
// El guard de rev-10 quedó fijado a `action` ('alert' / 'escalate' / null) y por
// eso no vio la regresión: `healthySilence` era
// `watchdogDegraded === false && watchdogAction === 'skip'`, y `decide()` emite
// CUATRO skips distintos. Tres de ellos son un pipeline PARADO con cola llena:
//
//   reason              | ¿sano? | por qué
//   --------------------|--------|--------------------------------------------
//   no-enabled-work     |   SÍ   | no hay trabajo elegible: no despachar es OK
//   within-threshold    |   NO   | parado, todavía por debajo del umbral
//   cooldown            |   NO   | YA alertó y sigue parado (backoff corriendo)
//   declared-cause:*    |   NO   | parado por una pausa declarada, con nombre
//
// El más caro es `cooldown`: con backoff 30→60→120 min y tick de 1 min, el
// watchdog pasa la mayoría de los ticks de un episodio largo ahí, así que el
// operador veía verde casi todo lo que duraba la caída.
//
// Estos tests recorren la cadena completa (status del tick → slice → HTML) y
// afirman sobre el TEXTO RENDERIZADO, no sólo sobre el campo de la slice.
// =============================================================================

const RAZONES_NO_SANAS = [
    {
        reason: 'within-threshold',
        causeKind: null,
        // En t=10 con 9 elegibles el banner decía "Cola sin trabajo elegible":
        // literalmente falso, y en estado estable.
        esperado: /todavía dentro del umbral de vigilancia/,
    },
    {
        reason: 'cooldown',
        causeKind: null,
        esperado: /aviso ya emitido, la detención continúa/,
    },
    {
        reason: 'declared-cause:human-halt',
        causeKind: 'human-halt',
        esperado: /pausa total declarada por el operador/,
    },
    {
        reason: 'declared-cause:wave-empty',
        causeKind: 'wave-empty',
        esperado: /allowlist vacía/,
    },
];

for (const caso of RAZONES_NO_SANAS) {
    test(`#5400 (rev-11) skip:${caso.reason} con elegibles esperando NO se pinta como silencio sano`, () => {
        const dir = tmpDir();
        const NOW = 1_700_000_000_000;
        escribirEstado(dir, 'last-dispatch.json', {
            ts: NOW - 40 * 60_000, issue: '5388', skill: 'pipeline-dev', fase: 'dev',
        });
        escribirStatusWatchdog(dir, {
            enabled: true, killSwitch: false, lastTickTs: NOW - 20_000, degraded: false,
            action: 'skip', reason: caso.reason, causeKind: caso.causeKind,
            pendientes: 9,
        });

        const s = slices.dispatchCauseSlice(null, { PIPELINE: dir, nowMs: NOW });
        // El watchdog está sano; el PIPELINE no. Son dos cosas distintas.
        assert.strictEqual(s.watchdogDegraded, false, 'el watchdog en sí está sano');
        assert.strictEqual(s.watchdogAction, 'skip');
        assert.strictEqual(s.watchdogDecisionReason, caso.reason,
            'la razón del skip tiene que llegar a la slice (antes se perdía)');
        assert.strictEqual(s.healthySilence, false,
            `skip:${caso.reason} con 9 elegibles NO es silencio sano`);

        const html = renderDispatchCauseBanner(s);
        const texto = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        // 1. Lo prohibido: el copy de salud con la cola llena.
        assert.doesNotMatch(texto, /nada que despachar no es una falla/);
        assert.doesNotMatch(texto, /Cola sin trabajo elegible/);
        // 2. El estado principal es "detención", no el ícono de salud.
        assert.match(html, /href="#ic-dispatch-stalled"/);
        // 3. El banner NOMBRA por qué está parado, no dice "no consta".
        assert.match(texto, caso.esperado);
        assert.doesNotMatch(texto, /Estado del despacho sin confirmar/,
            'hay decisión registrada: no corresponde el copy de "sin confirmar"');
        // 4. Cuenta el mismo episodio que Telegram: elegibles esperando.
        assert.match(texto, /9 issues elegibles esperando/);
        fs.rmSync(dir, { recursive: true, force: true });
    });
}

test('#5400 (rev-11) skip:no-enabled-work es el ÚNICO skip que declara salud', () => {
    const dir = tmpDir();
    const NOW = 1_700_000_000_000;
    escribirEstampa(dir, NOW - 40 * 60_000);
    escribirStatusWatchdog(dir, {
        enabled: true, killSwitch: false, lastTickTs: NOW - 20_000, degraded: false,
        action: 'skip', reason: 'no-enabled-work', pendientes: 0,
    });
    const s = slices.dispatchCauseSlice(null, { PIPELINE: dir, nowMs: NOW });
    assert.strictEqual(s.healthySilence, true);
    assert.match(renderDispatchCauseBanner(s), /nada que despachar no es una falla/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('#5400 (rev-11) un skip sin razón registrada no afirma salud: sin dato no se pinta verde', () => {
    const dir = tmpDir();
    const NOW = 1_700_000_000_000;
    escribirEstampa(dir, NOW - 40 * 60_000);
    // `action: 'skip'` a secas — sin `reason` y sin `pendientes`. Es el estado
    // que el guard de rev-10 daba por sano. Ausencia de dato no es evidencia de
    // salud: fail-closed.
    escribirStatusWatchdog(dir, {
        enabled: true, killSwitch: false, lastTickTs: NOW - 20_000, degraded: false,
        action: 'skip',
    });
    const s = slices.dispatchCauseSlice(null, { PIPELINE: dir, nowMs: NOW });
    assert.strictEqual(s.watchdogDecisionReason, null);
    assert.strictEqual(s.watchdogElegibles, null, 'no consta el conteo');
    assert.strictEqual(s.healthySilence, false, 'sin evidencia positiva, no hay verde');
    const html = renderDispatchCauseBanner(s);
    assert.doesNotMatch(html, /nada que despachar no es una falla/);
    assert.match(html, /Estado del despacho sin confirmar/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('#5400 (rev-11) within-threshold con la cola REALMENTE vacía sí es silencio sano', () => {
    const dir = tmpDir();
    const NOW = 1_700_000_000_000;
    escribirEstampa(dir, NOW - 5 * 60_000);
    // No-regresión en el otro sentido: exigir `no-enabled-work` a secas
    // convertiría en alarma un pipeline ocioso legítimo (CA-3). Un conteo de
    // elegibles observado en CERO alcanza para el verde.
    escribirStatusWatchdog(dir, {
        enabled: true, killSwitch: false, lastTickTs: NOW - 20_000, degraded: false,
        action: 'skip', reason: 'within-threshold', pendientes: 0,
    });
    const s = slices.dispatchCauseSlice(null, { PIPELINE: dir, nowMs: NOW });
    assert.strictEqual(s.healthySilence, true);
    assert.match(renderDispatchCauseBanner(s), /nada que despachar no es una falla/);
    fs.rmSync(dir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// rev-11 — BLOQUEANTE 2 (agravante): el fallback tiene que poder NOMBRAR la causa.
// El Pulpo escribía `causeKind` y la slice lo tiraba, así que el banner decía
// "sin causa declarada" mientras Telegram nombraba la pausa sobre el mismo
// episodio (rompía CA-6 y la regla de copy 7).
// -----------------------------------------------------------------------------
test('#5400 (rev-11) alertando con causa clasificada el banner la nombra en vez de decir "sin causa declarada"', () => {
    const dir = tmpDir();
    const NOW = 1_700_000_000_000;
    escribirEstado(dir, 'last-dispatch.json', {
        ts: NOW - 93 * 60_000, issue: '5388', skill: 'pipeline-dev', fase: 'dev',
    });
    escribirStatusWatchdog(dir, {
        enabled: true, killSwitch: false, lastTickTs: NOW - 20_000, degraded: false,
        action: 'alert', reason: 'stale-declared-cause:human-halt',
        causeKind: 'human-halt', pendientes: 9,
    });
    const s = slices.dispatchCauseSlice(null, { PIPELINE: dir, nowMs: NOW });
    assert.strictEqual(s.watchdogCauseKind, 'human-halt');
    const texto = renderDispatchCauseBanner(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.match(texto, /pausa total declarada por el operador/);
    assert.doesNotMatch(texto, /sin causa declarada/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('#5400 (rev-11) sin causeKind el banner sigue diciendo la verdad: sin causa declarada', () => {
    const dir = tmpDir();
    const NOW = 1_700_000_000_000;
    escribirEstampa(dir, NOW - 93 * 60_000);
    escribirStatusWatchdog(dir, {
        enabled: true, killSwitch: false, lastTickTs: NOW - 20_000, degraded: false,
        action: 'alert', reason: 'unexplained-stall', pendientes: 9,
    });
    const s = slices.dispatchCauseSlice(null, { PIPELINE: dir, nowMs: NOW });
    assert.strictEqual(s.watchdogCauseKind, null);
    assert.match(renderDispatchCauseBanner(s), /sin causa declarada/);
    fs.rmSync(dir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// rev-11 — El escenario completo del rechazo: el incidente del 2026-08-02
// (`.paused` + allowlist podada) NO puede terminar en un cartel verde.
// -----------------------------------------------------------------------------
test('#5400 (rev-11) pipeline detenido a mano hace 1 h 33 min: el banner jamás dice que no hay nada que despachar', () => {
    const dir = tmpDir();
    const NOW = 1_700_000_000_000;
    escribirEstado(dir, 'last-dispatch.json', {
        ts: NOW - 93 * 60_000, issue: '5388', skill: 'pipeline-dev', fase: 'dev',
    });
    // Primeros 45 min del episodio: la causa declarada todavía es válida, así
    // que el watchdog está en `skip:declared-cause:human-halt` con degraded:false.
    // Ese era exactamente el camino al falso verde.
    escribirStatusWatchdog(dir, {
        enabled: true, killSwitch: false, lastTickTs: NOW - 20_000, degraded: false,
        action: 'skip', reason: 'declared-cause:human-halt', causeKind: 'human-halt',
        authorDeclared: 'leitolarreta', causeSinceTs: NOW - 93 * 60_000, pendientes: 9,
    });
    const s = slices.dispatchCauseSlice(null, { PIPELINE: dir, nowMs: NOW });
    assert.strictEqual(s.healthySilence, false);
    const texto = renderDispatchCauseBanner(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.doesNotMatch(texto, /nada que despachar no es una falla/);
    assert.doesNotMatch(texto, /Cola sin trabajo elegible/);
    // Nombra la pausa y su autoría declarada, igual que Telegram.
    assert.match(texto, /pausa total declarada por el operador/);
    assert.match(texto, /leitolarreta/);
    assert.match(texto, /9 issues elegibles esperando/);
    fs.rmSync(dir, { recursive: true, force: true });
});
