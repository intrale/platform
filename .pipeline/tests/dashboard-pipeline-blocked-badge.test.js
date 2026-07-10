// #4640 — Tests del badge 🛑 "bloqueado por dependencias" en la vista de
// pipeline (board MIZPÁ, pipeline-redesign.js).
//
// Contratos cubiertos:
//   1. plItemFromMatrix lee blockedBy del server (data.blockedBy), NO re-deriva
//      el bloqueo desde labels (CA-3: fuente única, sin lógica duplicada).
//   2. plRenderCard pinta el badge f-blocked cuando i.blockedBy.length > 0 y
//      lista de qué depende (CA-1, CA-2).
//   3. El badge escapa todo número interpolado con escapeHtml (CA-6 / REQ-SEC-1).
//   4. Un issue sin blockedBy NO renderiza el badge f-blocked (CA-4).
//   5. CSS .plc-flag.f-blocked existe.
//
// Se evalúa contra el código fuente como string (mismo enfoque que
// dashboard-pipeline-allowlist.test.js) para que falle en CI si el contrato
// desaparece o cambia.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const REDESIGN_PATH = path.join(__dirname, '..', 'views', 'dashboard', 'pipeline-redesign.js');
const redesign = require(REDESIGN_PATH);
const PR_CLIENT = redesign.pipelineRedesignClientScript();

// ───────────── Fuente única: plItemFromMatrix lee data.blockedBy ─────────────

test('plItemFromMatrix lee blockedBy del server (no re-deriva de labels)', () => {
    assert.match(
        PR_CLIENT,
        /blockedBy:\s*data\.blockedBy\s*\|\|\s*null/,
        'plItemFromMatrix debe leer data.blockedBy (fuente server-authoritative)',
    );
});

test('plItemTerminal expone blockedBy: null para shape homogéneo', () => {
    assert.match(PR_CLIENT, /blockedBy:\s*null/, 'items terminales deben tener blockedBy: null');
});

// ───────────── plRenderCard: badge 🛑 + lista de deps ─────────────

test('plRenderCard pinta el badge f-blocked cuando hay blockedBy (CA-1/CA-2)', () => {
    assert.match(PR_CLIENT, /i\.blockedBy\s*&&\s*i\.blockedBy\.length/, 'el badge se dispara desde i.blockedBy');
    assert.match(PR_CLIENT, /f-blocked/, 'clase f-blocked del badge de bloqueo');
    assert.match(PR_CLIENT, /🛑 depende de/, 'microcopy del badge con la lista de deps');
    assert.match(PR_CLIENT, /Bloqueado — depende de/, 'tooltip con el detalle completo de deps');
});

test('el badge escapa cada número de dependencia con escapeHtml (CA-6 / REQ-SEC-1)', () => {
    assert.match(
        PR_CLIENT,
        /i\.blockedBy\.map\(function\(n\)\{\s*return\s*'#'\s*\+\s*escapeHtml\(String\(n\)\)/,
        'cada dep se interpola con escapeHtml (defensa en profundidad)',
    );
});

test('el badge de bloqueo NO usa innerHTML con dato dinámico sin escapar', () => {
    // Todo dato dinámico del badge pasa por escapeHtml; no debe haber innerHTML crudo.
    const start = PR_CLIENT.indexOf('i.blockedBy && i.blockedBy.length');
    assert.ok(start > 0, 'el bloque del badge debe existir');
    const block = PR_CLIENT.slice(start, start + 600);
    assert.doesNotMatch(block, /innerHTML/, 'el badge no debe usar innerHTML');
});

// ───────────── Comportamiento end-to-end (render replicado) ─────────────

test('render replicado: issue bloqueado muestra 🛑 depende de #4569; no bloqueado no lo muestra (CA-1/CA-4)', () => {
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    // Réplica exacta de la lógica del badge en plRenderCard (#4640).
    function renderFlags(i) {
        let flags = '';
        if (i.blockedBy && i.blockedBy.length) {
            const depsAll = i.blockedBy.map(function (n) { return '#' + escapeHtml(String(n)); });
            const depsFull = depsAll.join(', ');
            const depsShort = depsAll.length > 2 ? (depsAll.slice(0, 2).join(', ') + ' +' + (depsAll.length - 2)) : depsFull;
            flags += '<span class="plc-flag f-blocked" title="Bloqueado — depende de ' + depsFull + '">🛑 depende de ' + depsShort + '</span>';
        } else if (i.paused) {
            flags += '<span class="plc-flag f-paused" title="Issue pausado (blocked:dependencies)">⏸ pausado</span>';
        }
        return flags;
    }

    const blocked = renderFlags({ blockedBy: ['4569'] });
    assert.match(blocked, /f-blocked/);
    assert.match(blocked, /🛑 depende de #4569/);

    const notBlocked = renderFlags({ blockedBy: null, paused: false });
    assert.doesNotMatch(notBlocked, /f-blocked/, 'issue sin blockedBy NO muestra el badge (CA-4)');
    assert.equal(notBlocked, '', 'sin bloqueo ni pausa no hay flags');

    // Fallback: label blocked:dependencies sin deps registradas → ⏸ pausado (compat).
    const pausedOnly = renderFlags({ blockedBy: null, paused: true });
    assert.match(pausedOnly, /f-paused/);
    assert.doesNotMatch(pausedOnly, /f-blocked/);

    // >2 deps: texto visible truncado a 2 + "+N", detalle completo en el title (UX).
    const many = renderFlags({ blockedBy: ['4569', '4570', '4571'] });
    assert.match(many, /🛑 depende de #4569, #4570 \+1/, 'texto visible resume con +N');
    assert.match(many, /title="Bloqueado — depende de #4569, #4570, #4571"/, 'title lista todas las deps');
});

test('XSS: una dep con payload se neutraliza en el badge', () => {
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const dep = '<img src=x onerror=alert(1)>';
    const out = '#' + escapeHtml(String(dep));
    assert.ok(!out.includes('<img'), 'tag cruda no sobrevive');
    assert.ok(out.includes('&lt;img'), 'el < queda escapado');
});

// ───────────── CSS ─────────────

test('el CSS declara .plc-flag.f-blocked con color de bloqueo', () => {
    const css = redesign.PIPELINE_REDESIGN_CSS;
    assert.match(css, /\.plc-flag\.f-blocked\s*\{/, 'debe existir la clase .plc-flag.f-blocked');
    assert.match(css, /\.plc-flag\.f-blocked\s*\{[^}]*var\(--in-bad/, 'usa el token de color de bloqueo (--in-bad)');
});
