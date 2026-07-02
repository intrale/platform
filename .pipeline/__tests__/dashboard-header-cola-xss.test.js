// =============================================================================
// Tests de la sub-seccion "Cola detallada" del header del large board (#3356).
//
// La sub-seccion vive en `generateHTML()` dentro de `.pipeline/dashboard.js` y
// renderiza hasta 10 issues pendientes con formato `#num · titulo · [fase] · skill`.
// Estos tests validan estructuralmente (source-grep) + simulando el render con
// `vm` que:
//   - CA-1: la cola muestra hasta 10 issues con formato `#<num> · <titulo>`.
//   - CA-2: usa los design tokens existentes (border, surface-1, radius-md).
//   - CA-3: ningun KPI/indicador previo desaparece (hdr-clock, pw-toggle,
//     kpis-row, sys-mini-card).
//   - CA-4: no se agregan endpoints HTTP nuevos.
//   - CA-5: los titulos de issues se escapan (XSS). Un titulo malicioso
//     `<script>alert(1)</script>` debe aparecer como `&lt;script&gt;...&lt;/script&gt;`.
//   - CA-6: bind loopback intacto (`127.0.0.1`).
//
// El archivo `dashboard.js` no se puede `require()` directamente porque monta
// el server al cargar. Por eso este test combina source-grep estructural con
// ejecucion controlada del bloque de render usando `vm.runInNewContext`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DASHBOARD_PATH = path.join(REPO_ROOT, '.pipeline', 'dashboard.js');
const DASHBOARD_SRC = fs.readFileSync(DASHBOARD_PATH, 'utf8');

// #3728 — la ventana Pipeline (incluido el bloque pipeline-ctrl-bar con los
// toggles de Priority Windows) fue extraída de `dashboard.js` a su propio módulo
// SSR `.pipeline/views/dashboard/pipeline.js`. dashboard.js sigue rindiendo esos
// toggles en el output via `pipelineView.renderPipelineHTML(...)`, pero la cadena
// HTML `class="pw-toggle "` ahora vive en el módulo extraído. La regresión CA-3
// busca el ancla en ambos fuentes para no romper con la extracción.
const PIPELINE_VIEW_PATH = path.join(REPO_ROOT, '.pipeline', 'views', 'dashboard', 'pipeline.js');
const PIPELINE_VIEW_SRC = fs.existsSync(PIPELINE_VIEW_PATH)
    ? fs.readFileSync(PIPELINE_VIEW_PATH, 'utf8')
    : '';

// ---------------------------------------------------------------------------
// CA-1, CA-2: estructura visible en el source
// ---------------------------------------------------------------------------

test('CA-1 · existe la sub-seccion `cola-detallada` con marcador estable', () => {
    assert.ok(DASHBOARD_SRC.includes('data-test-id="cola-detallada"'),
        'falta el data-test-id="cola-detallada" en el render del header');
    assert.ok(DASHBOARD_SRC.includes('class="cola-detallada"'),
        'falta la clase CSS .cola-detallada en el render');
    assert.ok(DASHBOARD_SRC.includes('aria-label="Cola del pipeline"'),
        'falta el aria-label semantico de la sub-seccion');
});

test('CA-1 · la cola lee de `pendientesList` con slice hasta 10', () => {
    assert.match(
        DASHBOARD_SRC,
        /COLA_MAX\s*=\s*10/,
        'falta el limite COLA_MAX = 10'
    );
    // #4360 — la cola ya no slicea `pendientesList` crudo: se nutre de la lista
    // de pendientes filtrada por la ola activa (`colaSource`), y ese origen
    // deriva de `pendientesList`. Verificamos que COLA_MAX se aplica sobre esa
    // fuente y que el filtro por ola quedó cableado.
    assert.match(
        DASHBOARD_SRC,
        /colaSource\.slice\(\s*0\s*,\s*COLA_MAX\s*\)/,
        'la cola debe sliceear colaSource (pendientes de la ola activa) hasta COLA_MAX'
    );
    assert.match(
        DASHBOARD_SRC,
        /filterPendientesByWave\(\s*pendientesList\s*,/,
        'la cola debe filtrar pendientesList por la ola activa via filterPendientesByWave (#4360)'
    );
});

test('CA-2 · la sub-seccion usa design tokens (surface-1, border, radius-md)', () => {
    // La regla CSS de .cola-detallada debe consumir tokens del design system.
    const colaCss = /\.cola-detallada\s*\{[^}]*\}/m.exec(DASHBOARD_SRC);
    assert.ok(colaCss, 'no se encuentra la regla CSS .cola-detallada');
    const css = colaCss[0];
    assert.match(css, /var\(--surface-1/, 'la cola debe usar var(--surface-1)');
    assert.match(css, /var\(--border/, 'la cola debe usar var(--border)');
    assert.match(css, /var\(--radius-md/, 'la cola debe usar var(--radius-md)');
});

test('CA-2 · existen las 4 clases de chip por lane (definicion/desarrollo/qa/entrega)', () => {
    assert.ok(DASHBOARD_SRC.includes('.cola-phase-definicion'),
        'falta .cola-phase-definicion (lane purpura)');
    assert.ok(DASHBOARD_SRC.includes('.cola-phase-desarrollo'),
        'falta .cola-phase-desarrollo (lane info)');
    assert.ok(DASHBOARD_SRC.includes('.cola-phase-qa'),
        'falta .cola-phase-qa (lane teal)');
    assert.ok(DASHBOARD_SRC.includes('.cola-phase-entrega'),
        'falta .cola-phase-entrega (lane success)');
});

// ---------------------------------------------------------------------------
// CA-3: regresion sobre los anclajes preexistentes
// ---------------------------------------------------------------------------

test('CA-3 · los anclajes previos del header (hdr-clock, pw-toggle, kpis-row, sys-mini-card) siguen vivos', () => {
    assert.ok(DASHBOARD_SRC.includes('id="hdr-clock"'),
        '#hdr-clock removido — perdimos el reloj del header');
    assert.ok(
        DASHBOARD_SRC.includes('class="pw-toggle ') || PIPELINE_VIEW_SRC.includes('class="pw-toggle '),
        '.pw-toggle removido — perdimos los toggles de Priority Windows (ni en dashboard.js ni en views/dashboard/pipeline.js #3728)');
    assert.ok(DASHBOARD_SRC.includes('class="kpis-row"'),
        '.kpis-row removido — perdimos el grid de KPIs');
    assert.ok(DASHBOARD_SRC.includes('class="sys-mini-card'),
        '.sys-mini-card removida — perdimos CPU/RAM mini');
});

// ---------------------------------------------------------------------------
// CA-4: sin endpoints nuevos
// ---------------------------------------------------------------------------

test('CA-4 · el render no introduce endpoints HTTP nuevos para la cola', () => {
    // Buscamos cualquier handler que cite explicitamente la cola detallada
    // como ruta. No tiene que existir ninguno.
    const rxNuevasRutas = /\b(app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]\/(api\/)?cola[-/]detallada/;
    assert.doesNotMatch(DASHBOARD_SRC, rxNuevasRutas,
        'aparecieron rutas HTTP /cola-detallada — CA-4 prohibe endpoints nuevos');
});

// ---------------------------------------------------------------------------
// CA-6: bind loopback intacto
// ---------------------------------------------------------------------------

test('CA-6 · bind loopback (127.0.0.1) intacto', () => {
    assert.match(DASHBOARD_SRC, /127\.0\.0\.1/,
        'se removio el bind a 127.0.0.1 — CA-6 lo exige');
    // No debe haber bind explicito a 0.0.0.0 (defense-in-depth)
    assert.doesNotMatch(DASHBOARD_SRC, /listen\([^)]*['"`]0\.0\.0\.0['"`]/,
        'aparecio listen() en 0.0.0.0 — el dashboard debe ser loopback-only');
});

// ---------------------------------------------------------------------------
// CA-5: XSS — el render escapa los titulos de issues en la cola
// ---------------------------------------------------------------------------
//
// El bloque IIFE de render esta inmediatamente despues del cierre del div
// .kpis-row. Lo extraemos del source y lo ejecutamos en un VM controlado
// con `pendientesList` simulado, para verificar que un titulo malicioso
// aparece escapado.
//
// Estrategia robusta: extraer todo el cuerpo entre el comentario "#3356 —"
// y el `})()}` que cierra el IIFE.

function extractColaIife(src) {
    const startMarker = '// #3356 — Sub-seccion "Cola detallada"';
    const start = src.indexOf(startMarker);
    if (start === -1) return null;
    // Buscar el `(() => {` que abre el IIFE — esta unas lineas antes del marker
    const iifeOpen = src.lastIndexOf('(() => {', start);
    if (iifeOpen === -1) return null;
    // Buscar el cierre del IIFE: `})()` despues del start
    // El bloque va desde `(() => {` (excluido) hasta el `})()` final
    let depth = 0;
    let i = iifeOpen + '(() => {'.length;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            if (depth === 0) break;
            depth--;
        } else if (ch === '`') {
            // Saltar template literal — buscar cierre balanceando `${...}`
            i++;
            while (i < src.length) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === '`') break;
                if (src[i] === '$' && src[i + 1] === '{') {
                    let d = 1;
                    i += 2;
                    while (i < src.length && d > 0) {
                        if (src[i] === '{') d++;
                        else if (src[i] === '}') d--;
                        if (d === 0) break;
                        i++;
                    }
                }
                i++;
            }
        }
        i++;
    }
    return src.slice(iifeOpen + '(() => {'.length, i);
}

test('CA-5 · titulo malicioso (XSS) se escapa al renderizar la cola', () => {
    const body = extractColaIife(DASHBOARD_SRC);
    assert.ok(body, 'no se pudo extraer el IIFE de la cola del source');

    // Sandbox de ejecucion — replicamos las dependencias minimas.
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const maliciousTitle = '<script>alert(1)</script>';
    const pendientesList = [
        ['9999', {
            title: maliciousTitle,
            faseActual: 'desarrollo/dev',
            fases: { 'desarrollo/dev': [{ estado: 'pendiente', skill: 'pipeline-dev' }] }
        }]
    ];

    const sandbox = { pendientesList, esc };
    vm.createContext(sandbox);
    // Envolvemos el IIFE en una expresion que devuelve el HTML.
    const wrapped = `(() => {${body}})()`;
    const html = vm.runInContext(wrapped, sandbox, { timeout: 1000 });

    assert.equal(typeof html, 'string',
        'el IIFE de la cola debe retornar un string HTML');

    // El titulo crudo NO debe aparecer.
    assert.ok(!html.includes('<script>alert(1)</script>'),
        'XSS: el titulo crudo `<script>alert(1)</script>` aparecio sin escapar');

    // La version escapada SI debe aparecer.
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),
        'el titulo malicioso no aparece escapado como `&lt;script&gt;...`');

    // El numero de issue debe estar visible.
    assert.match(html, /#9999/,
        'el numero del issue (#9999) no aparece en el render');
});

test('CA-5 · titulo con comillas y `&` tambien se escapan', () => {
    const body = extractColaIife(DASHBOARD_SRC);
    assert.ok(body, 'no se pudo extraer el IIFE de la cola del source');

    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    // Titulo con multiples caracteres riesgosos para HTML.
    const tricky = `Fix "race condition" & <img src=x onerror=alert(1)>`;
    const pendientesList = [
        ['8888', {
            title: tricky,
            faseActual: 'definicion/criterios',
            fases: { 'definicion/criterios': [{ estado: 'pendiente', skill: 'po' }] }
        }]
    ];
    const sandbox = { pendientesList, esc };
    vm.createContext(sandbox);
    const html = vm.runInContext(`(() => {${body}})()`, sandbox, { timeout: 1000 });

    assert.ok(!html.includes('<img src=x'),
        'XSS: el <img onerror> aparecio crudo en el render');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'),
        'el <img onerror> no aparece escapado');
    assert.ok(html.includes('&amp;'),
        'el `&` literal del titulo no se escapo como &amp;');
});

// ---------------------------------------------------------------------------
// CA-1 fino: limites del slice (10, 11, 0)
// ---------------------------------------------------------------------------

test('CA-1 · si la cola tiene mas de 10, solo se renderizan los primeros 10', () => {
    const body = extractColaIife(DASHBOARD_SRC);
    assert.ok(body, 'no se pudo extraer el IIFE de la cola');
    const esc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;');

    const pendientesList = [];
    for (let i = 1; i <= 15; i++) {
        pendientesList.push([String(i), {
            title: `Issue numero ${i}`,
            faseActual: 'desarrollo/dev',
            fases: { 'desarrollo/dev': [{ estado: 'pendiente', skill: 'pipeline-dev' }] }
        }]);
    }
    const sandbox = { pendientesList, esc };
    vm.createContext(sandbox);
    const html = vm.runInContext(`(() => {${body}})()`, sandbox, { timeout: 1000 });

    for (let i = 1; i <= 10; i++) {
        assert.ok(html.includes(`#${i}<`) || html.includes(`#${i} `) || html.includes(`>${i}<`),
            `el item ${i} (primeros 10) deberia aparecer en el render`);
    }
    // Issues 11..15 NO deben aparecer como items (el footer si menciona ocultos).
    for (let i = 11; i <= 15; i++) {
        // Aceptamos que aparezca el numero como parte del footer "5 ocultos",
        // pero no como un `#11` standalone en una fila.
        assert.ok(!html.includes(`#${i}<`) && !html.includes(`#${i} `),
            `el item ${i} no deberia renderizarse (CA-1 limita a 10)`);
    }
    // Verificar que el footer/nota menciona los ocultos.
    assert.match(html, /5 ocultos/,
        'la nota deberia indicar "5 ocultos" cuando hay 15 totales');
});

test('CA-1 · cola vacia renderiza un mensaje "Sin issues en cola"', () => {
    const body = extractColaIife(DASHBOARD_SRC);
    assert.ok(body, 'no se pudo extraer el IIFE');
    const esc = (s) => String(s == null ? '' : s);
    const sandbox = { pendientesList: [], esc };
    vm.createContext(sandbox);
    const html = vm.runInContext(`(() => {${body}})()`, sandbox, { timeout: 1000 });

    assert.match(html, /Sin issues en cola/,
        'la cola vacia deberia mostrar el mensaje "Sin issues en cola"');
});

test('CA-1 · cola con 3 items rellena con 7 placeholders para altura estable', () => {
    const body = extractColaIife(DASHBOARD_SRC);
    assert.ok(body, 'no se pudo extraer el IIFE');
    const esc = (s) => String(s == null ? '' : s);

    const pendientesList = [];
    for (let i = 1; i <= 3; i++) {
        pendientesList.push([String(i), {
            title: `Issue ${i}`,
            faseActual: 'desarrollo/dev',
            fases: { 'desarrollo/dev': [{ estado: 'pendiente', skill: 'pipeline-dev' }] }
        }]);
    }
    const sandbox = { pendientesList, esc };
    vm.createContext(sandbox);
    const html = vm.runInContext(`(() => {${body}})()`, sandbox, { timeout: 1000 });

    // 7 placeholders esperados — contamos las ocurrencias de "is-placeholder".
    const matches = html.match(/is-placeholder/g) || [];
    assert.equal(matches.length, 7,
        `esperaba 7 placeholders cuando la cola tiene 3 items, obtuve ${matches.length}`);
});
