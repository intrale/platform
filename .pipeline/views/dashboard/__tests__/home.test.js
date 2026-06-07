'use strict';

// =============================================================================
// home.test.js — Tests SSR del rediseño del main del Dashboard V3 (#3725).
//
// Cubre los criterios de aceptación del split:
//   - CA-3725.13: smoke por sub-función (state vacío + poblado), payloads XSS
//     en contexto body y atributo, snapshot de IDs DOM ↔ renderClientScript.
//   - CA-3725.3 / CA-3725.6: whitelist sin filtración (infra health / system
//     card) — sin secretos, sin hostname/cwd/env/paths.
//   - CA-3725.8: boundary <main id="view-content"> preservado.
//   - CA-3725.1: build status 'unknown' cuando el marker no existe.
//
// Framework: node --test (estándar del repo, ver lib/__tests__/).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const home = require('../home.js');
const {
    renderHomeHTML,
    renderBrandBar,
    renderControlBar,
    renderInfraHealth,
    renderKpiGrid,
    renderQueueDetailed,
    renderSystemCard,
} = home;

// Payloads canónicos (los exige CA-3725.13 / análisis /security).
const XSS_BODY = '<script>alert(1)</script>';
const XSS_DOUBLE = '&#x6a;avascript';            // detecta doble-escape (&amp;#x...)
const XSS_ATTR = '"><img src=x onerror=alert(1)>'; // rompe contexto de atributo

const SUBFNS = {
    renderBrandBar,
    renderControlBar,
    renderInfraHealth,
    renderKpiGrid,
    renderQueueDetailed,
    renderSystemCard,
};

// ---------------------------------------------------------------------------
// Smoke: cada sub-función devuelve string con state vacío y con state poblado.
// ---------------------------------------------------------------------------
test('cada sub-función devuelve string con state vacío (sin throw)', () => {
    for (const [name, fn] of Object.entries(SUBFNS)) {
        const out = fn(undefined);
        assert.equal(typeof out, 'string', name + ' debe devolver string');
        assert.ok(out.length > 0, name + ' debe devolver markup no vacío');
    }
});

test('cada sub-función devuelve string con state {} (sin throw)', () => {
    for (const [name, fn] of Object.entries(SUBFNS)) {
        const out = fn({});
        assert.equal(typeof out, 'string', name + ' con {} debe devolver string');
    }
});

test('renderBrandBar poblado emite el pill de build status', () => {
    const out = renderBrandBar({ build: { status: 'passing', branch: 'main', commit: 'abc1234' } });
    assert.match(out, /id="bld-status"/);
    assert.match(out, /Build OK/);
    assert.match(out, /in-pill-ok/);
});

test('renderInfraHealth poblado emite UP/DOWN + filas por servicio', () => {
    const out = renderInfraHealth({
        infra: {
            pulpo: { status: 'UP', lastPing: '2026-06-06T10:00:00Z' },
            dashboard: { status: 'UP', lastPing: '2026-06-06T10:00:00Z' },
            telegram: { status: 'DOWN', lastPing: null },
        },
    });
    assert.match(out, /id="infra-pulpo"/);
    assert.match(out, /id="infra-dashboard"/);
    assert.match(out, /id="infra-telegram"/);
    assert.match(out, /UP/);
    assert.match(out, /DOWN/);
});

test('renderSystemCard poblado emite las 4 celdas whitelisted', () => {
    const out = renderSystemCard({ system: { cpuPct: 42, memPct: 71, diskPct: 55, uptimeS: 3661 } });
    assert.match(out, /id="sys-cpu-value"/);
    assert.match(out, /id="sys-mem-value"/);
    assert.match(out, /id="sys-disk-value"/);
    assert.match(out, /id="sys-uptime-value"/);
    assert.match(out, /42%/);
    assert.match(out, /1h 1m/); // 3661s → 1h 1m
});

// ---------------------------------------------------------------------------
// CA-3725.1 — build status 'unknown' degradado cuando el marker no existe.
// ---------------------------------------------------------------------------
test('renderBrandBar sin build status muestra unknown sin romper', () => {
    const out = renderBrandBar({ build: { status: 'unknown', branch: '', commit: '' } });
    assert.match(out, /Build \?/);
    assert.match(out, /in-pill-info/);
});

test('renderBrandBar nunca invoca gh api (R-G4) — sin la cadena en el markup', () => {
    const out = renderBrandBar({ build: { status: 'passing', branch: 'main', commit: 'abc' } });
    assert.ok(!/gh api/.test(out) || /sin gh api/.test(out),
        'el markup no debe sugerir invocación de gh api salvo en la nota explicativa');
});

// ---------------------------------------------------------------------------
// CA-3725.13 — XSS en contexto BODY: el payload se escapa, no se inyecta crudo.
// renderBrandBar consume branch/commit (atacante-controlables vía Git).
// ---------------------------------------------------------------------------
test('XSS body: renderBrandBar escapa <script> en branch', () => {
    const out = renderBrandBar({ build: { status: 'passing', branch: XSS_BODY, commit: '' } });
    assert.ok(!out.includes(XSS_BODY), 'el <script> crudo NO debe aparecer en el body');
    assert.match(out, /&lt;script&gt;/, 'debe aparecer escapado');
});

test('XSS body: sin doble-escape de entidades existentes', () => {
    const out = renderBrandBar({ build: { status: 'passing', branch: XSS_DOUBLE, commit: '' } });
    // El & del payload se escapa una sola vez a &amp; — no debe quedar &amp;amp;.
    assert.ok(!out.includes('&amp;amp;'), 'no debe haber doble-escape');
});

// ---------------------------------------------------------------------------
// CA-3725.13 / CA-3725.10 — XSS en contexto ATRIBUTO: branch en aria-label/title.
// ---------------------------------------------------------------------------
test('XSS atributo: renderBrandBar escapa comillas en title/aria-label', () => {
    const out = renderBrandBar({ build: { status: 'passing', branch: XSS_ATTR, commit: '' } });
    // El payload rompe-atributo no debe aparecer crudo dentro de un valor.
    assert.ok(!out.includes('onerror=alert(1)>'), 'el payload no debe romper el atributo');
    assert.match(out, /&quot;|&gt;/, 'las comillas/ángulos deben quedar escapados');
});

test('XSS atributo: renderSystemCard escapa tooltips (defensa, tips estáticos)', () => {
    // Los tips son estáticos, pero validamos que pasan por escapeHtmlAttr.
    const out = renderSystemCard({ system: { cpuPct: null, memPct: null, diskPct: null, uptimeS: 0 } });
    assert.ok(!out.includes('"">'), 'no debe haber atributos rotos');
});

// ---------------------------------------------------------------------------
// CA-3725.3 — Infra health: whitelist estricta, sin secretos.
// ---------------------------------------------------------------------------
test('infra health no filtra token/chat_id/config aunque el state los traiga', () => {
    // Aunque el composer NUNCA pasa estos campos, la sub-función no debe
    // emitirlos si por error llegaran en el objeto.
    const out = renderInfraHealth({
        infra: {
            pulpo: { status: 'UP', lastPing: null },
            dashboard: { status: 'UP', lastPing: null },
            telegram: { status: 'UP', lastPing: null, token: 'SECRET-TOKEN-123', chat_id: '999' },
        },
    });
    assert.ok(!out.includes('SECRET-TOKEN-123'), 'el token NUNCA debe aparecer');
    assert.ok(!out.includes('999'), 'el chat_id NUNCA debe aparecer');
    assert.ok(!/token|chat_id/i.test(out.replace(/sin exponer token ni chat_id/i, '')),
        'no debe emitir claves token/chat_id (salvo la nota del tooltip)');
});

// ---------------------------------------------------------------------------
// CA-3725.6 — System card: prohibido hostname/cwd/userInfo/env/paths.
// ---------------------------------------------------------------------------
test('system card no filtra hostname/cwd/env aunque el state los traiga', () => {
    const out = renderSystemCard({
        system: {
            cpuPct: 10, memPct: 20, diskPct: 30, uptimeS: 100,
            hostname: 'EVIL-HOST', cwd: 'C:/secret/path', user: 'admin',
        },
    });
    assert.ok(!out.includes('EVIL-HOST'), 'no debe emitir hostname');
    assert.ok(!out.includes('C:/secret/path'), 'no debe emitir paths');
    assert.ok(!out.includes('admin'), 'no debe emitir usuario');
});

// ---------------------------------------------------------------------------
// CA-3725.8 / CA-3725.14 — render completo: boundary + sin leaks de infra.
// ---------------------------------------------------------------------------
test('renderHomeHTML preserva el boundary main#view-content', () => {
    const html = renderHomeHTML({});
    assert.match(html, /<main[^>]*id="view-content"/);
});

test('renderHomeHTML no filtra process.env / hostname / cwd / paths del host', () => {
    const html = renderHomeHTML({});
    assert.ok(!html.includes('process.env'), 'no debe contener process.env');
    assert.ok(!/[A-Za-z]:\\\\Users\\\\/.test(html), 'no debe contener paths absolutos de Windows');
    assert.ok(!/\/home\/[a-z]/.test(html), 'no debe contener paths /home');
    // hostname/cwd como labels indicativas de leak.
    assert.ok(!/hostname:/.test(html), 'no debe contener hostname:');
    assert.ok(!/cwd:/.test(html), 'no debe contener cwd:');
});

test('renderHomeHTML respeta currentView y flag unknownView (sin reflejar slug)', () => {
    const html = renderHomeHTML({ currentView: 'home', unknownViewRequested: true });
    assert.match(html, /data-current-view="home"/);
    assert.match(html, /"unknownViewRequested":true/);
});

// ---------------------------------------------------------------------------
// CA-3725.13 (R-G1) — Snapshot de acoplamiento: todo ID referenciado por el
// script cliente (getElementById/setText/setClass con literal completo) debe
// existir como id="..." en el HTML SSR. Si no, el refresh queda muerto en
// silencio. Excepciones documentadas: elementos creados en runtime por JS.
// ---------------------------------------------------------------------------
test('snapshot IDs: cada referencia literal del client script existe en SSR', () => {
    const html = renderHomeHTML({});
    const src = fs.readFileSync(path.join(__dirname, '..', 'home.js'), 'utf8');

    // Elementos creados dinámicamente por el cliente (no viven en el SSR):
    //   - in-toast: lo crea showToast() on-demand.
    //   - wave-planned-overflow: lo crea morphWaveRow() al poblar la ola.
    const RUNTIME_CREATED = new Set(['in-toast', 'wave-planned-overflow']);

    const ids = new Set();
    const re = /(?:getElementById\(\s*'([a-zA-Z0-9_-]+)'\s*\)|(?:setText|setClass)\(\s*'([a-zA-Z0-9_-]+)'\s*,)/g;
    let m;
    while ((m = re.exec(src))) ids.add(m[1] || m[2]);

    const dangling = [...ids]
        .filter((id) => !RUNTIME_CREATED.has(id))
        .filter((id) => !html.includes('id="' + id + '"'));

    assert.deepEqual(dangling, [],
        'IDs referenciados por el script pero ausentes en SSR (R-G1): ' + JSON.stringify(dangling));
});
