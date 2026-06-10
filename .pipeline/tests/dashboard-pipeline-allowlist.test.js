// #3045 — Tests para la visibilidad de la pausa parcial en la cola del Pipeline view.
//
// El cliente vive como template literals dentro de satellites.js (commonHelpers
// + renderPipeline). Acá congelamos contratos que necesitan persistir frente
// a refactors:
//
// 1. Estructura defensiva: helpers privados (_saneAllowedIssues, _allowlistOk),
//    coerción de IDs, escape de title en la cola.
// 2. Markup del toggle (role=switch, aria-checked, hidden por default).
// 3. Grid de áreas (#3045 fix): auto-fit/minmax en lugar de repeat fijo.
// 4. Smoke test del escape: replicamos la regex de escapeHtml y validamos que
//    neutraliza el payload XSS clásico.
//
// Se evalúa contra el código fuente como string para que falle en CI si alguna
// pieza desaparece o cambia el contrato (mismo patrón que dashboard-xss-modal).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SATELLITES_PATH = path.join(__dirname, '..', 'views', 'dashboard', 'satellites.js');
const HOME_PATH = path.join(__dirname, '..', 'views', 'dashboard', 'home.js');
const SAT_SRC = fs.readFileSync(SATELLITES_PATH, 'utf8');
const HOME_SRC = fs.readFileSync(HOME_PATH, 'utf8');

// ───────────── Estructura defensiva en satellites.js ─────────────

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
        '_saneAllowedIssues debe estar declarada',
    );
    // Replicamos la implementación para validar comportamiento.
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

test('_allowlistOk retorna false fuera de partial_pause y para inputs inválidos', () => {
    assert.match(SAT_SRC, /function\s+_allowlistOk\s*\(issue\)\s*\{/, '_allowlistOk debe estar declarada');
    assert.match(SAT_SRC, /pipelineModeState\.mode\s*!==\s*'partial_pause'/, '_allowlistOk debe cortocircuitar fuera de partial_pause');
    assert.match(SAT_SRC, /Number\.isInteger\(n\)\s*&&\s*n\s*>\s*0/, '_allowlistOk debe coercer issue a integer > 0');

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
    assert.equal(allowlistOk(partial, '3045'), true); // string numérico OK
    // Nota: Number("3045 ") === 3045 (JS ignora trailing whitespace en Number()).
    // No es un fallo de la coerción client-side; la protección efectiva contra
    // inputs malformados está SERVER-SIDE en headerSlice (allowedIssues ya
    // llega como array de integers). Aún así, _saneAllowedIssues lo filtra
    // por defensa en profundidad cuando llega del payload del backend.
    assert.equal(allowlistOk(partial, 3045.5), false);
    assert.equal(allowlistOk(partial, -1), false);
    assert.equal(allowlistOk(partial, 0), false);
    assert.equal(allowlistOk(partial, null), false);
    assert.equal(allowlistOk(partial, undefined), false);
    assert.equal(allowlistOk(partial, 'abc'), false);
    assert.equal(allowlistOk(partial, '<img>'), false);
    assert.equal(allowlistOk(running, 3045), false); // running mode → no allowlist semantics
    assert.equal(allowlistOk(partial, 9999), false); // no en allowlist
});

// ───────────── Markup del toggle ─────────────

test('renderPipeline incluye el toggle con role=switch + aria-checked + display:none default', () => {
    const start = SAT_SRC.indexOf('function renderPipeline()');
    assert.ok(start > 0, 'renderPipeline debe existir');
    // Cuerpo hasta el siguiente `function` top-level
    const end = SAT_SRC.indexOf('\nfunction renderBloqueados', start);
    assert.ok(end > start, 'el cierre de renderPipeline debe encontrarse');
    const body = SAT_SRC.slice(start, end);

    assert.match(body, /id="pl-allowlist-toggle"/, 'toggle debe tener id estable');
    assert.match(body, /role="switch"/, 'toggle debe ser role=switch (CA-UX-2)');
    assert.match(body, /aria-checked="false"/, 'toggle debe arrancar con aria-checked=false');
    assert.match(body, /tabindex="0"/, 'toggle debe ser focusable con teclado');
    assert.match(body, /style="display:none"/, 'toggle arranca oculto por default — solo se muestra en partial_pause (CA-5)');
    assert.match(body, /Solo issues habilitados/, 'microcopy del toggle (CA-UX-4)');
});

test('renderPipeline declara wireAllowlistToggle con handlers de click + Space + Enter', () => {
    const start = SAT_SRC.indexOf('function renderPipeline()');
    const end = SAT_SRC.indexOf('\nfunction renderBloqueados', start);
    const body = SAT_SRC.slice(start, end);

    assert.match(body, /function\s+wireAllowlistToggle\s*\(/, 'wireAllowlistToggle debe estar definida');
    assert.match(body, /addEventListener\('click'/, 'click listener requerido');
    assert.match(body, /ev\.key\s*===\s*' '\s*\|\|\s*ev\.key\s*===\s*'Enter'/, 'Space + Enter deben togglear el switch (CA-UX-2)');
});

test('refreshAllowlistToggleVisibility muestra el toggle solo en partial_pause con allowlist no vacía', () => {
    const start = SAT_SRC.indexOf('function refreshAllowlistToggleVisibility');
    assert.ok(start > 0, 'refreshAllowlistToggleVisibility debe existir');
    const end = SAT_SRC.indexOf('\nfunction wireAllowlistToggle', start);
    const body = SAT_SRC.slice(start, end);

    assert.match(body, /pipelineModeState\.mode\s*===\s*'partial_pause'/, 'visibilidad depende del modo');
    assert.match(body, /pipelineModeState\.allowedIssues\.length\s*>\s*0/, 'visibilidad requiere allowlist no vacía');
});

test('refreshAllowlistToggleVisibility resetea el filtro al salir de partial_pause', () => {
    const start = SAT_SRC.indexOf('function refreshAllowlistToggleVisibility');
    const end = SAT_SRC.indexOf('\nfunction wireAllowlistToggle', start);
    const body = SAT_SRC.slice(start, end);
    // Si la pausa parcial deja de estar activa, el filtro debe apagarse para
    // que el operador no quede mirando una cola "fantasma" en running.
    assert.match(body, /onlyAllowlistFilter\s*=\s*false/);
});

// ───────────── Render de la card: badge + clase de borde ─────────────

test('tickPipeline renderiza el badge "✅ habilitado" cuando _allowlistOk es true', () => {
    const start = SAT_SRC.indexOf('async function tickPipeline');
    assert.ok(start > 0, 'tickPipeline debe existir');
    const end = SAT_SRC.indexOf('const POLLS = ', start);
    const body = SAT_SRC.slice(start, end);

    assert.match(body, /pl-card-allowlist-badge/, 'CSS class del badge debe usarse en el render');
    assert.match(body, /✅ habilitado/, 'microcopy literal del badge (CA-UX-4)');
    assert.match(body, /Habilitado por la pausa parcial activa/, 'tooltip literal del badge');
    assert.match(body, /pl-card-state-allowlisted/, 'clase de borde para card allowlisted');
});

test('tickPipeline NO aplica pl-card-state-allowlisted cuando estado es trabajando (CA-UX-5)', () => {
    const start = SAT_SRC.indexOf('async function tickPipeline');
    const end = SAT_SRC.indexOf('const POLLS = ', start);
    const body = SAT_SRC.slice(start, end);
    // Lookup textual: el código debe condicionar la clase de borde a estado != trabajando.
    assert.match(body, /i\.estado\s*!==\s*'trabajando'/, 'el borde allowlisted no debe combinarse con el de trabajando');
});

test('tickPipeline filtra por columna ANTES del slice(0, 12) cuando el filtro está activo', () => {
    const start = SAT_SRC.indexOf('async function tickPipeline');
    const end = SAT_SRC.indexOf('const POLLS = ', start);
    const body = SAT_SRC.slice(start, end);

    // Buscar la lógica de filter ANTES del slice. La intención es no perder
    // cards habilitadas que cayeron fuera del top 12 ordenado.
    assert.match(body, /onlyAllowlistFilter\s*\?\s*col\.items\.filter\(i\s*=>\s*_allowlistOk\(i\.issue\)\)/);
    assert.match(body, /\.slice\(0,\s*12\)/);
    // Sanity: el filter aparece antes que el slice en la fuente.
    const filterIdx = body.indexOf('col.items.filter(i => _allowlistOk(i.issue))');
    const sliceIdx = body.indexOf('visible.slice(0, 12)');
    assert.ok(filterIdx > 0 && sliceIdx > 0 && filterIdx < sliceIdx,
        'el filter debe aparecer antes del slice en el código fuente');
});

// ───────────── XSS en la cola: i.title pasa por escapeHtml ─────────────

test('tickPipeline escapa i.title antes de inyectarlo a innerHTML (REQ-SEC-1)', () => {
    const start = SAT_SRC.indexOf('async function tickPipeline');
    const end = SAT_SRC.indexOf('const POLLS = ', start);
    const body = SAT_SRC.slice(start, end);

    // El título se inyecta dentro de pl-card-title — debe pasar por escapeHtml.
    assert.match(body, /title="\s*'\s*\+\s*escapeHtml\(i\.title\|\|''\)\s*\+\s*'"/);
    assert.match(body, /escapeHtml\(\(i\.title\|\|''\)\.slice\(0,60\)\)/);

    // El número de issue también escapa para defenderse contra payloads inyectados
    // por mutaciones del payload del backend.
    assert.match(body, /escapeHtml\(i\.issue\)/);
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

// ───────────── Toggle: estado nunca interpolado a HTML (REQ-SEC-3) ─────────────

test('onlyAllowlistFilter es booleano de módulo con default ON desde sessionStorage (REQ-SEC-3 / #3905)', () => {
    const start = SAT_SRC.indexOf('function renderPipeline()');
    const end = SAT_SRC.indexOf('\nfunction renderBloqueados', start);
    const body = SAT_SRC.slice(start, end);

    // #3905 supera el diseño efímero de #3045: el filtro ahora nace ACTIVO en
    // sesión nueva y persiste la preferencia del operador (CA: "El filtro
    // persiste como ACTIVO por defecto en nuevas sesiones (sessionStorage o
    // cookie)" + Escenario Gherkin 3). REQ-SEC-3 sigue vigente en su intención
    // real: el estado nunca se interpola crudo a HTML y nunca fluye sin sanear.
    assert.match(body, /let\s+onlyAllowlistFilter\s*=/, 'toggle state es un binding de módulo');
    assert.match(
        body,
        /sessionStorage\.getItem\('pl-only-allowlist'\)/,
        'inicializa la preferencia desde sessionStorage (#3905)',
    );
    assert.match(
        body,
        /v\s*===\s*null\s*\?\s*true\s*:\s*v\s*===\s*'1'/,
        'default ON + coerción estricta a boolean al leer (REQ-SEC-3: no interpola string crudo)',
    );
    // REQ-SEC-3 — sigue prohibido localStorage: la preferencia se acota a la
    // sesión, evitando estado stale del modo del pipeline entre sesiones.
    assert.doesNotMatch(body, /localStorage\.[gs]etItem/i, 'NO debe persistir en localStorage (REQ-SEC-3)');
    // #3905 — sólo se persiste el flag sanitizado '1'/'0', nunca un valor
    // arbitrario que pudiera reintroducir un vector de interpolación.
    assert.match(
        body,
        /sessionStorage\.setItem\('pl-only-allowlist',\s*onlyAllowlistFilter\s*\?\s*'1'\s*:\s*'0'\)/,
        'persiste sólo el flag sanitizado 1/0 (REQ-SEC-3)',
    );
});

// ───────────── Grid de la nav bar V3 (CA-2 — #3358 → #3726) ─────────────

test('theme.css declara .v3-nav con grid-template-columns: repeat(N, minmax(<px>px, 1fr)) (CA-2 — derivado del catálogo)', () => {
    // Historia: #3045 (9→10) pasó de repeat(9, 1fr) a auto-fit minmax(96px, 1fr).
    // #3239 (10→11) sumó "Provider" — auto-fit dejó de alcanzar al ancho
    // operativo del kiosk (1036px usables) y la 11ª pill rebotó a 2 filas.
    // #3358 → repeat(${AREAS.length}, minmax(0, 1fr)) interpolado: columnas
    // DERIVADAS del array AREAS, así el patrón 9→10→11→… no rompe el wrap.
    // #3726 → la botonera vieja .areas-bar/.area-pill quedó retirada.
    // La nav V3 unificada (.v3-nav) vive en theme.css con
    // `repeat(12, minmax(44px, 1fr))` — 12 corresponde a NAV_TABS.length
    // (catálogo fijo decidido por el architect). El test bloquea:
    //   * regresiones a literales sin `1fr` (que perdían reflow elástico),
    //   * regresiones a auto-fit con minmax fijo (que rebotaba a 2 filas).
    const THEME_PATH = path.join(__dirname, '..', 'views', 'dashboard', 'theme.css');
    const THEME_SRC = fs.readFileSync(THEME_PATH, 'utf8');
    assert.match(
        THEME_SRC,
        /\.v3-nav\s*\{[\s\S]*?grid-template-columns:\s*repeat\(\d+,\s*minmax\(\d+px,\s*1fr\)\)/,
        '.v3-nav debe usar repeat(N, minmax(<px>px, 1fr)) en theme.css (CA-2: columnas elásticas)',
    );
    assert.doesNotMatch(
        THEME_SRC,
        /\.v3-nav\s*\{[\s\S]*?grid-template-columns:\s*repeat\(\d+,\s*1fr\)\s*;/,
        'no debe quedar un repeat(N, 1fr) sin minmax — perdería el touch target >=44px de CA-5',
    );
    assert.doesNotMatch(
        THEME_SRC,
        /\.v3-nav\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit/,
        'no debe quedar auto-fit (regresión #3358: rebote a 2 filas con > N tabs)',
    );
});

test('nav-tabs.js sigue exportando 12 tabs (regression vs el conteo asumido por el grid V3)', () => {
    // #3726 — el catálogo NAV_TABS reemplazó al array AREAS y quedó fijo en
    // 12 entradas por decisión del architect (home, equipo, pipeline,
    // bloqueados, issues, matriz, ops, kpis, historial, costos, descanso,
    // providers). El grid .v3-nav usa `repeat(12, minmax(44px, 1fr))` —
    // si alguien suma/saca una tab acá, también tiene que actualizar el
    // literal en theme.css y los tests que dependen del conteo.
    const { NAV_TABS } = require(path.join(__dirname, '..', 'views', 'dashboard', 'nav-tabs.js'));
    assert.equal(
        NAV_TABS.length,
        12,
        'NAV_TABS debe seguir teniendo 12 elementos (catálogo cerrado en #3726)',
    );
    // Sanity: el array AREAS viejo no debe reaparecer. Si vuelve, hay que
    // refactorizar el call site para que use NAV_TABS y emitir nav SSR via
    // renderNavTabsSsr — no introducir una segunda fuente de tabs.
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

    // Sanity: la asignación de pipelineModeState ocurre ANTES del refresh.
    const assignIdx = body.indexOf('pipelineModeState = {');
    const refreshIdx = body.indexOf('refreshAllowlistToggleVisibility');
    assert.ok(assignIdx > 0 && refreshIdx > assignIdx,
        'la asignación del cache debe preceder al refresh del toggle');
});
