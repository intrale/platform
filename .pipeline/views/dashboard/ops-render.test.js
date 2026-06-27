'use strict';

// Tests SSR de la vista Ops rediseñada (EP8-H7 #3960).
// node --test .pipeline/views/dashboard/ops-render.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const ops = require('./ops');

const baseState = () => ({
    procesos: {
        pulpo: { pid: '9512', alive: true, uptime: 190000000 },
        listener: { pid: '10244', alive: true, uptime: 172800000 },
        'svc-drive': { pid: null, alive: false },
        'svc-github': { pid: '11820', alive: true, uptime: 172800000 },
        dashboard: { pid: '1', alive: true, uptime: 3600000 },
    },
    servicios: {},
    infraHealth: { ok: true },
    qaEnv: { emulator: true },
    qaRemote: { active: true },
    telegramHealth: { ok: true },
});

test('renderOps produce un grafo jerárquico con conectores (CA-5)', () => {
    const html = ops.renderOps(baseState(), {});
    assert.ok(html.includes('ops-topo'), 'tiene el contenedor de topología');
    assert.ok(html.includes('ops-topo-root'), 'tiene capa raíz (pulpo)');
    assert.ok(html.includes('ops-topo-services'), 'tiene capa de servicios');
    assert.ok(html.includes('ops-topo-bus'), 'tiene conectores');
    assert.ok(html.includes('data-node="pulpo"'), 'nodo pulpo presente');
});

test('nodo caído usa dual-encoding (borde + ícono ic-health-dead + texto), no solo color', () => {
    const html = ops.nodeCardSsr('svc-drive', { pid: null, alive: false }, {});
    assert.ok(html.includes('is-dead'), 'clase is-dead (borde rojo)');
    assert.ok(html.includes('ic-health-dead'), 'ícono de caído');
    assert.ok(/caído/i.test(html), 'label textual de caído');
    assert.ok(html.includes('data-deadlabel'), 'placeholder para "caído hace N m" client-side');
});

test('nodo vivo muestra PID + uptime ("desde cuándo" sano, CA-1)', () => {
    const html = ops.nodeCardSsr('pulpo', { pid: '9512', alive: true, uptime: 190000000 }, {});
    assert.ok(html.includes('is-alive'));
    assert.ok(html.includes('PID 9512'));
    assert.ok(/\dd \d+h|\dh \d+m/.test(html), 'muestra uptime formateado');
    assert.ok(html.includes('ops-node-dot alive'), 'punto verde');
});

test('el panel de detalle, confirm-modal y la acción restart están presentes', () => {
    const html = ops.renderOps(baseState(), {});
    assert.ok(html.includes('ops-detail'), 'panel de detalle');
    assert.ok(html.includes('inConfirm'), 'confirm-modal embebido (CA-3)');
    assert.ok(html.includes("action:'restart'"), 'POST restart en el cliente');
    assert.ok(html.includes('/logs/stream/'), 'log inline SSE (CA-2)');
    assert.ok(html.includes('ops-recon-spark'), 'sparkline del reconciler (CA-4)');
});

test('el último error y motivos runtime pasan por sanitizeRuntime (REQ-SEC-H7-1/6)', () => {
    const state = baseState();
    state.telegramHealth = { ok: false, lastError: { description: 'fallo token=AKIAIOSFODNN7EXAMPLE', code: 'X', source: 'api' }, updatedAt: '2026-06-20' };
    const html = ops.renderOps(state, {});
    assert.ok(!html.includes('AKIAIOSFODNN7EXAMPLE'), 'el secret del banner queda redactado');
});

test('render inerte visible si el state es inválido (REQ-SEC-7)', () => {
    const html = ops.renderOps(null, {});
    assert.ok(html.includes('Ventana Ops no disponible'));
    assert.ok(html.length > 100, 'no es string vacío');
});

test('QA environment se renderiza como pills con dual-encoding', () => {
    const html = ops.renderQaPillsSsr({ qaEnv: { emulator: true }, qaRemote: { active: true }, infraHealth: { ok: false }, telegramHealth: { ok: true } });
    assert.ok(html.includes('ops-qa-pill'));
    assert.ok(html.includes('data-health="bad"'), 'infra caída en rojo');
    assert.ok(html.includes('ic-health-dead') || html.includes('ic-ok'), 'íconos de estado, no solo color');
});

// ───────────────────────── #4197 (Ola 7.1) — rediseño MIZPÁ ─────────────────────────

test('#4197 · hereda el shell MIZPÁ: barra de marca + tagline + selector multiproyecto', () => {
    const html = ops.renderOps(baseState(), {});
    assert.ok(html.includes('class="mz-logo"'), 'logo atalaya MIZPÁ');
    assert.ok(html.includes('>MIZPÁ<'), 'nombre de marca MIZPÁ');
    assert.ok(html.includes('atalaya de agentes'), 'tagline MIZPÁ');
    assert.ok(html.includes('mz-projsel'), 'selector multiproyecto');
    // El header legacy con logo "i" plano se reemplazó por la marca MIZPÁ.
    assert.ok(!/<div class="in-header-logo">i<\/div>/.test(html), 'no debe quedar el header legacy "i"');
});

test('#4197 · miga de pan «⋯ Más › 🛰 Ops»', () => {
    const html = ops.renderOps(baseState(), {});
    assert.ok(html.includes('mz-crumb'), 'tiene miga de pan');
    assert.ok(/⋯ Más/.test(html), 'la miga referencia el popover «⋯ Más»');
    assert.ok(/Ops</.test(html), 'la miga marca Ops como ubicación actual');
});

test('#4197 · banner de misión presente: calmo con todo vivo', () => {
    const state = {
        procesos: {
            pulpo: { pid: '1', alive: true, uptime: 7200000 },
            listener: { pid: '2', alive: true, uptime: 7200000 },
            dashboard: { pid: '3', alive: true, uptime: 7200000 },
        },
        telegramHealth: { ok: true },
    };
    const html = ops.renderOpsMissionBanner(state);
    assert.ok(html.includes('ops-mission'), 'contenedor del banner de misión');
    assert.ok(/class="ops-mission is-calm"/.test(html), 'modo calmo cuando no hay caídos');
    assert.ok(html.includes('están vivos'), 'título calmo');
    assert.ok(html.includes('id="ops-wm-uptime"'), 'métrica de uptime del Pulpo');
    assert.ok(html.includes('id="ops-wm-recon"'), 'métrica de descartes del reconciler');
});

test('#4197 · banner de misión en alarma cuando hay un servicio caído', () => {
    const state = {
        procesos: {
            pulpo: { pid: '1', alive: true, uptime: 7200000 },
            'svc-drive': { pid: null, alive: false },
        },
        telegramHealth: { ok: true },
    };
    const html = ops.renderOpsMissionBanner(state);
    assert.ok(!/is-calm/.test(html), 'NO debe estar calmo con un caído real');
    assert.ok(html.includes('svc-drive'), 'nombra el servicio caído');
    assert.ok(/ACCIÓN SUGERIDA/.test(html), 'reco accionable en alarma');
});

// ── Evaluación bloqueante de outbox-drain (CA): representación condicional ──

test('#4197 · outbox-drain caído con Pulpo VIVO → standby (reposo sano), NO falsa alarma', () => {
    const opts = { pulpoAlive: true };
    const html = ops.nodeCardSsr('outbox-drain', { pid: null, alive: false }, opts);
    assert.equal(ops.nodeStateOf('outbox-drain', { alive: false }, opts), 'standby');
    assert.ok(html.includes('is-standby'), 'clase standby (neutro)');
    assert.ok(!html.includes('is-dead'), 'NO debe marcarse como caído (rojo)');
    assert.ok(/en reposo/.test(html), 'label textual de reposo');
    assert.ok(!html.includes('data-deadlabel'), 'no es un nodo caído');
});

test('#4197 · outbox-drain caído con Pulpo TAMBIÉN caído → alarma real (is-dead)', () => {
    const opts = { pulpoAlive: false };
    const html = ops.nodeCardSsr('outbox-drain', { pid: null, alive: false }, opts);
    assert.equal(ops.nodeStateOf('outbox-drain', { alive: false }, opts), 'dead');
    assert.ok(html.includes('is-dead'), 'es alarma real cuando nadie drena');
    assert.ok(html.includes('ic-health-dead'), 'ícono de caído');
});

test('#4197 · outbox-drain vivo → fallback activo (is-alive)', () => {
    const html = ops.nodeCardSsr('outbox-drain', { pid: '99', alive: true, uptime: 60000 }, { pulpoAlive: false });
    assert.ok(html.includes('is-alive'), 'fallback corriendo');
    assert.ok(html.includes('PID 99'));
});

test('#4197 · computeOpsHealth excluye el fallback en standby del conteo de caídos', () => {
    const h = ops.computeOpsHealth({
        pulpo: { alive: true, uptime: 1000 },
        listener: { alive: true, uptime: 1000 },
        'outbox-drain': { alive: false },   // standby: NO cuenta como caído
    });
    assert.equal(h.down.length, 0, 'sin caídos reales');
    assert.equal(h.standby, 1, 'el fallback cuenta como standby');
    assert.equal(h.alive, 2, 'pulpo + listener vivos');
    assert.equal(h.total, 2, 'el standby no suma al total operativo');
});

test('#4197 · nombre de servicio caído en el banner se escapa (anti-XSS)', () => {
    const state = {
        procesos: {
            pulpo: { alive: true, uptime: 1000 },
            '<img src=x onerror=alert(1)>': { alive: false },
        },
        telegramHealth: { ok: true },
    };
    const html = ops.renderOpsMissionBanner(state);
    assert.ok(!html.includes('<img src=x'), 'el nombre malicioso NO queda crudo');
    assert.ok(html.includes('&lt;img'), 'el nombre se renderiza escapado');
});

// #4242 (Ola 7.1) — OPS adopta el marco común MIZPÁ reusando el helper
// compartido renderMissionBanner de la HOME (CA-5: no se duplica markup). El
// marco respeta el orden ① marca → ② ola → ③ accesos → ④ contenido propio.
test('#4242 · marco común MIZPÁ: banner de ola común (② AVANCE) presente, reusado de la HOME', () => {
    const html = ops.renderOps(baseState(), {});
    // ② cabecera de ola común (helper compartido renderMissionBanner)
    assert.ok(html.includes('<section class="mz-mission"'), 'banner de ola común presente');
    assert.ok(html.includes('mission-wave-num'), 'tag OLA con número de ola');
    assert.ok(html.includes('ETA DE LA OLA') && html.includes('VELOCIDAD') && html.includes('ENTREGADOS'),
        'métricas ⏱/🚀/📦 de la ola');
    assert.ok(html.includes('mz-prog-head') && html.includes('>AVANCE<'), 'bloque AVANCE con barra de progreso');
    assert.ok(/hechos/.test(html) && /activos/.test(html) && /bloq\./.test(html) && /cola/.test(html),
        'leyenda de puntitos hechos · activos · bloq. · cola');
    assert.ok(html.includes('tickOpsMission'), 'hidratación cliente del banner de ola (/api/dash/waves)');
});

test('#4242 · orden del marco común: ① marca → ② ola → ④ contenido propio', () => {
    const html = ops.renderOps(baseState(), {});
    const idxBrand = html.indexOf('in-header-brand');
    const idxMission = html.indexOf('<section class="mz-mission"');
    const idxBody = html.indexOf('<main class="satellite-body"');
    assert.ok(idxBrand > -1 && idxMission > -1 && idxBody > -1, 'los tres bloques presentes');
    assert.ok(idxBrand < idxMission, 'la marca (①) va antes del banner de ola (②)');
    assert.ok(idxMission < idxBody, 'el banner de ola (②) va antes del contenido propio (④)');
    // CSS de margen del banner común (alineado al padding del cuerpo)
    assert.ok(html.includes('.satellite-frame > .mz-mission'), 'CSS de margen del banner común');
});
