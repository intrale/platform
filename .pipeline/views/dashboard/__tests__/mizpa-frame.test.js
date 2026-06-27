// =============================================================================
// Tests del marco común MIZPÁ reutilizable (#4236, sobre #4234).
//
// Cubre:
//   - collectWave() degrada a {active:false} con waves.json ausente/ inválido,
//     y mapea bien una ola activa (CA-2).
//   - renderBrandBar() emite la cabecera MIZPÁ común (.in-header-brand + marca +
//     selector de proyecto), idéntica al resto (CA-1).
//   - renderMissionBanner() emite el banner canónico mz-* con tag de ola + título
//     + métricas (ETA · velocidad · entregados) + bloque AVANCE con barra y
//     leyenda de puntitos (CA-2). Estado vacío sin romper.
//   - El marco NO duplica las clases legacy lv-mission (CA-5): el markup usa mz-*.
//   - MIZPA_FRAME_CSS trae las reglas .mz-mission para vistas que sólo cargan
//     theme.css (LOGS).
//   - logs.js CONSUME el marco compartido: misma referencia de función y su
//     render incluye el marco mz-* + CSS, sin lv-mission (CA-5).
//   - No inyecta markup peligroso (escape de datos de la ola).
//
// Se ejecuta con: node --test .pipeline/views/dashboard/__tests__/mizpa-frame.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    collectWave,
    renderBrandBar,
    renderMissionBanner,
    MIZPA_FRAME_CSS,
} = require('../mizpa-frame');

const logs = require('../logs');

const SAMPLE_WAVE = Object.freeze({
    active: true,
    number: '7',
    name: 'Ola 7 · auditoría',
    desc: 'Independizar el modelo operativo del producto.',
    tag: 'ÚLTIMA DEL PLAN',
    eta: '2h 30m',
    velocity: '1.4',
    delivered: 5,
    total: 16,
    done: 5,
    activeCount: 3,
    blocked: 2,
    queue: 6,
    pct: 31,
});

// ── collectWave ──────────────────────────────────────────────────────────────

test('collectWave degrada a {active:false} cuando waves.json no existe', () => {
    const fake = path.join(os.tmpdir(), 'no-existe-' + process.pid + '.json');
    const w = collectWave(fake);
    assert.equal(w.active, false);
});

test('collectWave degrada a {active:false} con JSON inválido (no lanza)', () => {
    const tmp = path.join(os.tmpdir(), 'waves-bad-' + process.pid + '.json');
    fs.writeFileSync(tmp, '{ esto no es json');
    try {
        const w = collectWave(tmp);
        assert.equal(w.active, false);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
});

test('collectWave mapea una ola activa y deriva queue/pct', () => {
    const tmp = path.join(os.tmpdir(), 'waves-ok-' + process.pid + '.json');
    fs.writeFileSync(tmp, JSON.stringify({
        active_wave: { number: 7, name: 'Ola 7', total: 10, done: 4, active: 2, blocked: 1 },
    }));
    try {
        const w = collectWave(tmp);
        assert.equal(w.active, true);
        assert.equal(w.number, '7');
        assert.equal(w.total, 10);
        assert.equal(w.done, 4);
        assert.equal(w.queue, 3); // 10 - 4 - 2 - 1
        assert.equal(w.pct, 40); // 4/10
    } finally {
        fs.rmSync(tmp, { force: true });
    }
});

// ── renderBrandBar ───────────────────────────────────────────────────────────

test('renderBrandBar emite la cabecera MIZPÁ común (marca + selector de proyecto)', () => {
    const html = renderBrandBar();
    assert.match(html, /class="in-header-brand"/);
    assert.match(html, /class="mz-logo"/);
    assert.match(html, />MIZPÁ</);
    assert.match(html, /class="mz-projsel"/);
    assert.match(html, /PROYECTO ACTIVO/);
});

// ── renderMissionBanner ──────────────────────────────────────────────────────

test('renderMissionBanner (ola activa) usa el markup canónico mz-* con AVANCE', () => {
    const html = renderMissionBanner(SAMPLE_WAVE);
    assert.match(html, /class="mz-mission"/);
    assert.match(html, /class="mz-wavetag"/);
    assert.match(html, /class="mz-mission-prog"/);
    assert.match(html, /class="mz-prog-bar"/);
    assert.match(html, /class="mz-dot"/);
    assert.match(html, /AVANCE/);
    assert.match(html, /ETA DE LA OLA/);
    assert.match(html, /VELOCIDAD/);
    assert.match(html, /ENTREGADOS/);
    // tag + número + porcentaje reales
    assert.ok(html.includes('ÚLTIMA DEL PLAN'));
    assert.ok(html.includes('>7<'));
    assert.ok(html.includes('31%'));
    // leyenda de puntitos con conteos
    assert.ok(html.includes('hechos'));
    assert.ok(html.includes('activos'));
    assert.ok(html.includes('bloq.'));
    assert.ok(html.includes('cola'));
});

test('renderMissionBanner NO emite las clases legacy lv-mission (no duplica markup, CA-5)', () => {
    assert.ok(!renderMissionBanner(SAMPLE_WAVE).includes('lv-mission'));
    assert.ok(!renderMissionBanner({ active: false }).includes('lv-mission'));
});

test('renderMissionBanner (sin ola) rinde estado vacío sin romper', () => {
    const html = renderMissionBanner({ active: false });
    assert.match(html, /mz-mission is-empty/);
    assert.match(html, /Sin ola activa/);
});

test('renderMissionBanner escapa datos de la ola (no inyecta markup)', () => {
    const evil = { ...SAMPLE_WAVE, name: '<img src=x onerror=alert(1)>', tag: '<script>x</script>' };
    const html = renderMissionBanner(evil);
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<script>x</script>'));
    assert.match(html, /&lt;img/);
});

// ── MIZPA_FRAME_CSS ──────────────────────────────────────────────────────────

test('MIZPA_FRAME_CSS trae las reglas .mz-mission para vistas con sólo theme.css', () => {
    assert.match(MIZPA_FRAME_CSS, /\.mz-mission\s*\{/);
    assert.match(MIZPA_FRAME_CSS, /\.mz-prog-bar/);
    assert.match(MIZPA_FRAME_CSS, /\.mz-dot/);
});

// ── Consumo desde logs.js (CA-5) ─────────────────────────────────────────────

test('logs.js reexporta las mismas funciones del marco compartido (consume, no duplica)', () => {
    assert.equal(logs.collectWave, collectWave);
    assert.equal(logs.renderMissionBanner, renderMissionBanner);
});

test('renderLogViewer compone el marco común MIZPÁ (cabecera + banner mz-* + nav + CSS) y no deja lv-mission', () => {
    const html = logs.renderLogViewer('agent-4236-pipeline-dev.log', false, {});
    // ① cabecera MIZPÁ
    assert.match(html, /class="in-header-brand"/);
    // ② banner de ola canónico
    assert.match(html, /class="mz-mission/);
    // ③ barra de subventanas (nav compartida)
    assert.match(html, /aria-current="page"/);
    // CSS del marco presente
    assert.match(html, /\.mz-mission\s*\{/);
    // sin markup legacy duplicado
    assert.ok(!html.includes('lv-mission'));
});
