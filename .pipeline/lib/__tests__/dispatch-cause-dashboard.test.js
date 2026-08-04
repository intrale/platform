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
    assert.match(html, /#f85149/, 'la anomalía debe usar el borde de alerta');
});

test('render de causa normal NO usa el color de alerta', () => {
    const html = renderDispatchCauseBanner({ active: true, causa: dc.CAUSAS.REST_MODE, label: 'Modo descanso', anomalia: false });
    assert.doesNotMatch(html, /#f85149/);
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

test('#5400 sin causa y con el watchdog sano muestra el estado esperado y el chip activo', () => {
    const dir = tmpDir();
    escribirStatusWatchdog(dir, { enabled: true, killSwitch: false, lastTickTs: 1_600_000 });
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
    assert.doesNotMatch(normal, /#f85149/);
    const escalada = renderDispatchCauseBanner({
        active: true, causa: dc.CAUSAS.MODO_OLA, label: 'Modo ola', escaladoPorDuracion: true,
    });
    assert.match(escalada, /#f85149/, 'una causa sostenida deja de ser un estado esperado');
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
