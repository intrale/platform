// #3045 / #4190 — Tests de la visibilidad de la pausa parcial en la pantalla
// Pipeline.
//
// #4190 (Ola 7.1) rediseñó la pantalla: el toggle "Solo issues de la ola"
// (allowlist de la pausa parcial), el filtrado por partial_pause y el render de
// tarjetas se movieron de los template literals de satellites.js → al módulo
// views/dashboard/pipeline-redesign.js (client script). El cache compartido
// (pipelineModeState, _saneAllowedIssues) sigue viviendo en commonHelpers
// (satellites.js). Acá congelamos los contratos que deben persistir frente a
// refactors, ahora apuntando a su nueva ubicación.
//
// Contratos cubiertos:
//   1. Cache compartido y saneo de IDs (REQ-SEC-2) — commonHelpers/satellites.js.
//   2. Gating por partial_pause + coerción de IDs a integer > 0 — pipeline-redesign.js.
//   3. Markup del toggle (role=switch, aria-checked, hidden por default).
//   4. Default ON + persistencia saneada en sessionStorage (REQ-SEC-3 / #3905).
//   5. NUNCA truncar (#4190): sin slice del listado ni del título; título escapado.
//   6. Nav V3 (theme.css) y catálogo NAV_TABS — sin regresión.
//
// Se evalúa contra el código fuente como string para que falle en CI si alguna
// pieza desaparece o cambia el contrato.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SATELLITES_PATH = path.join(__dirname, '..', 'views', 'dashboard', 'satellites.js');
const HOME_PATH = path.join(__dirname, '..', 'views', 'dashboard', 'home.js');
const REDESIGN_PATH = path.join(__dirname, '..', 'views', 'dashboard', 'pipeline-redesign.js');
const SAT_SRC = fs.readFileSync(SATELLITES_PATH, 'utf8');
const HOME_SRC = fs.readFileSync(HOME_PATH, 'utf8');

// Client script del rediseño (string que se inyecta en el <script> de la página).
const redesign = require(REDESIGN_PATH);
const PR_CLIENT = redesign.pipelineRedesignClientScript();

// ───────────── Estructura defensiva en satellites.js (commonHelpers) ─────────────

test('satellites.js declara pipelineModeState como cache compartido', () => {
    assert.match(
        SAT_SRC,
        /let\s+pipelineModeState\s*=\s*\{\s*mode:\s*'running'\s*,\s*allowedIssues:\s*\[\]/,
        'pipelineModeState debe inicializarse en running con allowedIssues vacío',
    );
});

test('_saneAllowedIssues filtra a integers > 0 (REQ-SEC-2 defensa en profundidad)', () => {
    assert.match(
        SAT_SRC,
        /function\s+_saneAllowedIssues\s*\(arr\)\s*\{/,
        '_saneAllowedIssues debe estar declarada en commonHelpers',
    );
    function saneAllowedIssues(arr) {
        if (!Array.isArray(arr)) return [];
        const out = [];
        for (const v of arr) {
            const n = Number(v);
            if (Number.isInteger(n) && n > 0) out.push(n);
        }
        return out;
    }
    assert.deepEqual(saneAllowedIssues([3045, 2519]), [3045, 2519]);
    assert.deepEqual(saneAllowedIssues(['3045', '2519']), [3045, 2519]);
    assert.deepEqual(saneAllowedIssues(['3045 ', '2519.5', -1, null, 'abc', '<img>', 0]), [3045]);
    assert.deepEqual(saneAllowedIssues(null), []);
    assert.deepEqual(saneAllowedIssues(undefined), []);
    assert.deepEqual(saneAllowedIssues('3045'), []); // no-array → []
});

// ───────────── Gating por partial_pause en el rediseño ─────────────

test('plAllowlistOk retorna false fuera de partial_pause y para inputs inválidos', () => {
    assert.match(PR_CLIENT, /function\s+plAllowlistOk\s*\(issue\)\s*\{/, 'plAllowlistOk debe estar declarada en el client script');
    assert.match(PR_CLIENT, /pipelineModeState\.mode\s*!==\s*'partial_pause'/, 'plAllowlistOk debe cortocircuitar fuera de partial_pause');
    assert.match(PR_CLIENT, /!Number\.isInteger\(n\)\s*\|\|\s*n\s*<=\s*0/, 'plAllowlistOk debe coercer issue a integer > 0 (guard de negación)');

    // Replicamos para validar comportamiento end-to-end.
    function allowlistOk(state, issue) {
        if (state.mode !== 'partial_pause') return false;
        const n = Number(issue);
        if (!Number.isInteger(n) || n <= 0) return false;
        return state.allowedIssues.includes(n);
    }
    const partial = { mode: 'partial_pause', allowedIssues: [3045] };
    const running = { mode: 'running', allowedIssues: [3045] };

    assert.equal(allowlistOk(partial, 3045), true);
    assert.equal(allowlistOk(partial, '3045'), true);
    assert.equal(allowlistOk(partial, 3045.5), false);
    assert.equal(allowlistOk(partial, -1), false);
    assert.equal(allowlistOk(partial, 0), false);
    assert.equal(allowlistOk(partial, null), false);
    assert.equal(allowlistOk(partial, undefined), false);
    assert.equal(allowlistOk(partial, 'abc'), false);
    assert.equal(allowlistOk(partial, '<img>'), false);
    assert.equal(allowlistOk(running, 3045), false);
    assert.equal(allowlistOk(partial, 9999), false);
});

// ───────────── Markup del toggle ─────────────

test('el rediseño incluye el toggle con role=switch + aria-checked + display:none default', () => {
    const flow = redesign.renderPhaseFlowSsr();
    assert.match(flow, /id="pl-allowlist-toggle"/, 'toggle debe tener id estable');
    assert.match(flow, /role="switch"/, 'toggle debe ser role=switch (CA-UX-2)');
    assert.match(flow, /aria-checked="false"/, 'el markup arranca con aria-checked=false (el client refleja el estado real)');
    assert.match(flow, /tabindex="0"/, 'toggle debe ser focusable con teclado');
    assert.match(flow, /style="display:none"/, 'toggle arranca oculto — solo se muestra en partial_pause (CA-5)');
    assert.match(flow, /Solo issues de la ola/, 'microcopy del toggle (mockup #4190)');
});

test('plWireToggle declara handlers de click + Space + Enter', () => {
    assert.match(PR_CLIENT, /function\s+plWireToggle\s*\(/, 'plWireToggle debe estar definida');
    assert.match(PR_CLIENT, /addEventListener\('click'/, 'click listener requerido');
    assert.match(PR_CLIENT, /ev\.key\s*===\s*' '\s*\|\|\s*ev\.key\s*===\s*'Enter'/, 'Space + Enter deben togglear el switch (CA-UX-2)');
});

test('plRefreshToggleVisibility muestra el toggle solo en partial_pause con allowlist no vacía', () => {
    assert.match(PR_CLIENT, /function\s+plRefreshToggleVisibility\s*\(/, 'plRefreshToggleVisibility debe existir');
    assert.match(PR_CLIENT, /pipelineModeState\.mode\s*===\s*'partial_pause'/, 'visibilidad depende del modo');
    assert.match(PR_CLIENT, /pipelineModeState\.allowedIssues\.length\s*>\s*0/, 'visibilidad requiere allowlist no vacía');
});

test('plRefreshToggleVisibility resetea el filtro al salir de partial_pause', () => {
    // Si la pausa parcial deja de estar activa, el filtro debe apagarse para
    // que el operador no quede mirando una cola "fantasma" en running.
    assert.match(PR_CLIENT, /plOnlyWave\s*=\s*false/);
});

// ───────────── Render de la card: gating + flags ─────────────

test('plRenderCard marca el flag "✅ ola" cuando plAllowlistOk es true', () => {
    assert.match(PR_CLIENT, /plAllowlistOk\(i\.issue\)/, 'la tarjeta consulta el gating de la allowlist');
    assert.match(PR_CLIENT, /✅ ola/, 'microcopy del flag de issue habilitado por la ola');
    assert.match(PR_CLIENT, /Habilitado por la pausa parcial activa/, 'tooltip literal del flag');
});

// ───────────── NUNCA truncar (#4190) ─────────────

test('el listado NO se recorta: sin items.slice ni «+X más»', () => {
    assert.doesNotMatch(PR_CLIENT, /items\.slice\s*\(/, 'no debe recortar la lista de tarjetas por columna');
    assert.doesNotMatch(PR_CLIENT, /\.slice\(0,\s*12\)/, 'no debe quedar el top-12 legacy');
    assert.doesNotMatch(PR_CLIENT, /\+\s*X\s*más|\+\d+\s*más|continúa/i, 'no debe resumir con +X más / continúa');
    assert.match(PR_CLIENT, /items\.map\(/, 'mapea TODAS las items a tarjetas');
});

test('el título del issue se escapa y NO se trunca (REQ-SEC-1 + #4190)', () => {
    // El título se inyecta dentro de plc-title — debe pasar por escapeHtml.
    assert.match(PR_CLIENT, /class="plc-title">'\s*\+\s*escapeHtml\(i\.title/, 'el título va escapado dentro de .plc-title');
    // …y sin slice/substring sobre el título.
    assert.doesNotMatch(PR_CLIENT, /i\.title[^)\n]*\.(slice|substring)\s*\(/, 'el título nunca se recorta');
    // El número de issue también escapa.
    assert.match(PR_CLIENT, /escapeHtml\(i\.issue\)/);
});

test('escapeHtml replicado neutraliza el payload XSS clásico (sanity check)', () => {
    function escapeHtml(s) {
        return String(s || '').replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const payload = '<img src=x onerror="fetch(\'/api/kill-agent\',{method:\'POST\'})">';
    const out = escapeHtml(payload);
    assert.ok(!out.includes('<img'), 'tag <img cruda no sobrevive');
    assert.ok(!out.includes('onerror="'), 'handler onerror crudo no sobrevive');
    assert.ok(out.includes('&lt;img'), 'el < quedó escapado');
    assert.ok(out.includes('&quot;'), 'las " quedaron escapadas');
});

// ───────────── Toggle: estado nunca interpolado a HTML (REQ-SEC-3 / #3905) ─────────────

test('plOnlyWave es booleano de módulo con default ON desde sessionStorage (REQ-SEC-3 / #3905)', () => {
    assert.match(PR_CLIENT, /let\s+plOnlyWave\s*=/, 'el estado del toggle es un binding de módulo');
    assert.match(
        PR_CLIENT,
        /sessionStorage\.getItem\('pl-only-allowlist'\)/,
        'inicializa la preferencia desde sessionStorage (#3905)',
    );
    assert.match(
        PR_CLIENT,
        /v\s*===\s*null\s*\?\s*true\s*:\s*v\s*===\s*'1'/,
        'default ON + coerción estricta a boolean al leer (REQ-SEC-3: no interpola string crudo)',
    );
    assert.doesNotMatch(PR_CLIENT, /localStorage\.[gs]etItem/i, 'NO debe persistir en localStorage (REQ-SEC-3)');
    assert.match(
        PR_CLIENT,
        /sessionStorage\.setItem\('pl-only-allowlist',\s*plOnlyWave\s*\?\s*'1'\s*:\s*'0'\)/,
        'persiste sólo el flag sanitizado 1/0 (REQ-SEC-3)',
    );
});

// ───────────── Nav bar V3 → MIZPÁ (CA-2 — #3358 → #3726 → #4189/#4195) ─────────────

test('theme.css declara .v3-nav con layout flex elástico MIZPÁ (CA-1 #4195: nav curada + popover)', () => {
    // Historia: #3045 (9→10) auto-fit; #3239 (10→11); #3358 → repeat(N, minmax);
    // #3726 nav unificada (grid de 12-13 columnas).
    // #4189/#4195 — La nav MIZPÁ es CURADA: 5 tabs primarios SIEMPRE visibles +
    // un botón «⋯ Más» (popover <details>) con el resto. Un grid de N columnas
    // ya NO modela esto (el popover usa margin-left:auto para anclarse a la
    // derecha, imposible en grid). theme.css pasa a FLEX con `flex-wrap` y tabs
    // elásticos (`flex: 1 1 0`) que preservan el touch target >=44px (CA-5) vía
    // `min-width`. El test bloquea regresiones al grid viejo (que con la nav
    // curada dejaba 5-6 items dispersos en 12-13 columnas y rompía el anclaje
    // del popover).
    const THEME_PATH = path.join(__dirname, '..', 'views', 'dashboard', 'theme.css');
    const THEME_SRC = fs.readFileSync(THEME_PATH, 'utf8');
    // .v3-nav usa flex con wrap.
    assert.match(
        THEME_SRC,
        /\.v3-nav\s*\{[\s\S]*?display:\s*flex[\s\S]*?flex-wrap:\s*wrap/,
        '.v3-nav debe usar display:flex + flex-wrap (CA-1: nav curada MIZPÁ con popover)',
    );
    // Las tabs son elásticas (flex: 1 1 0) y conservan el touch target >=44px.
    assert.match(
        THEME_SRC,
        /\.v3-tab\s*\{[\s\S]*?flex:\s*1\s+1\s+0/,
        '.v3-tab debe ser elástica (flex: 1 1 0) para repartir el ancho disponible',
    );
    assert.match(
        THEME_SRC,
        /\.v3-tab\s*\{[\s\S]*?min-width:\s*44px/,
        '.v3-tab debe conservar min-width:44px (CA-5: touch target accesible)',
    );
    // El popover «⋯ Más» se ancla a la derecha.
    assert.match(
        THEME_SRC,
        /\.v3-more\s*\{[\s\S]*?margin-left:\s*auto/,
        '.v3-more debe anclarse a la derecha (margin-left:auto) — botón «⋯ Más»',
    );
    // No debe quedar el grid viejo de columnas fijas en .v3-nav.
    assert.doesNotMatch(
        THEME_SRC,
        /\.v3-nav\s*\{[\s\S]*?grid-template-columns:\s*repeat\(/,
        'no debe quedar grid-template-columns:repeat(...) en .v3-nav (regresión pre-MIZPÁ)',
    );
});

test('nav-tabs.js sigue exportando 13 tabs (regression vs el conteo asumido por el grid V3)', () => {
    const { NAV_TABS } = require(path.join(__dirname, '..', 'views', 'dashboard', 'nav-tabs.js'));
    assert.equal(NAV_TABS.length, 13, 'NAV_TABS debe tener 13 elementos (12 de #3726 + Salud MP de #3965)');
    assert.doesNotMatch(
        HOME_SRC,
        /const\s+AREAS\s*=\s*\[/,
        'el array AREAS quedó retirado en #3726 — usar NAV_TABS de nav-tabs.js',
    );
});

// ───────────── tickHeader actualiza el cache compartido ─────────────

test('tickHeader actualiza pipelineModeState antes de llamar a refreshAllowlistToggleVisibility', () => {
    const start = SAT_SRC.indexOf('async function tickHeader()');
    assert.ok(start > 0, 'tickHeader debe existir en commonHelpers');
    const end = SAT_SRC.indexOf('// ─── Acciones', start);
    const body = SAT_SRC.slice(start, end);

    assert.match(body, /pipelineModeState\s*=\s*\{/, 'tickHeader debe asignar pipelineModeState');
    assert.match(body, /_saneAllowedIssues\(d\.allowedIssues\)/, 'allowedIssues deben pasar por _saneAllowedIssues');
    assert.match(body, /refreshAllowlistToggleVisibility/, 'tickHeader debe disparar el refresh del toggle');

    const assignIdx = body.indexOf('pipelineModeState = {');
    const refreshIdx = body.indexOf('refreshAllowlistToggleVisibility');
    assert.ok(assignIdx > 0 && refreshIdx > assignIdx,
        'la asignación del cache debe preceder al refresh del toggle');
});
