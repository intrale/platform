// =============================================================================
// dashboard-desync-client-5724.test.js — Issue #5724 CA-4
//
// El pill de desync se pinta DOS veces con código distinto: el SSR del view
// (`views/dashboard/pipeline.js`) y el refresh client-side embebido en
// `dashboard.js` (que corre en el browser cada 30 s). Si sólo se arregla uno,
// el operador ve el copy nuevo al cargar y el viejo 30 segundos después.
//
// Este test ejecuta el renderer CLIENTE de verdad (vm + DOM mínimo) — no valida
// sintaxis, valida el HTML que termina en la página — y compara el resultado
// con el SSR para que no se separen.
//
// Ejecutar:
//   node --test .pipeline/tests/dashboard-desync-client-5724.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RAIZ = path.resolve(__dirname, '..');
const ssr = require(path.join(RAIZ, 'views', 'dashboard', 'pipeline.js'));

// Extrae el bloque cliente del pill (vive dentro del template servido al browser).
function bloqueCliente() {
    const src = fs.readFileSync(path.join(RAIZ, 'dashboard.js'), 'utf8');
    const ini = src.indexOf('var _DSS_META = {');
    const fin = src.indexOf('async function refreshDesyncStatus()');
    assert.ok(ini > 0 && fin > ini, 'no encontré el bloque cliente del pill de desync');
    return src.slice(ini, fin);
}

// Sandbox con el mínimo de DOM y los helpers que el dashboard ya define.
function montarCliente() {
    const el = { className: '', attrs: {}, innerHTML: '', setAttribute(k, v) { this.attrs[k] = v; } };
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const sandbox = {
        document: { getElementById: () => el },
        _ppaClientEsc: esc,
        _ppaIcUse: (n) => `<svg class="pl-ic"><use href="#ic-${n}"/></svg>`,
        Date, Number, Math, Array, Object, String, Boolean, console,
    };
    vm.createContext(sandbox);
    vm.runInContext(bloqueCliente(), sandbox);
    return {
        el,
        render(data) {
            sandbox.__data = data;
            vm.runInContext('renderDesyncStatus(__data)', sandbox);
            return el;
        },
    };
}

function hace(horas) {
    return new Date(Date.now() - horas * 3600 * 1000).toISOString();
}

test('el renderer cliente parsea y pinta el estado bloqueante completo', () => {
    const { render } = montarCliente();
    const el = render({
        estado: 'divergencia_bloqueada', bloqueado: true,
        added: [], removed: [5689, 5690, 5691], count: 91, detected_at: hace(10),
    });

    assert.equal(el.attrs.role, 'alert', 'UX-2: aria-live assertive cuando el dispatch está frenado');
    assert.equal(el.className, 'dss-pill dss-danger');
    assert.match(el.innerHTML, /Dispatch suspendido/);
    assert.match(el.innerHTML, /ic-pause-lock/);
    assert.match(el.innerHTML, /3 issues de la ola fuera de la allowlist/);
    assert.match(el.innerHTML, /no se lanza ningún agente/);
    assert.match(el.innerHTML, /hace 10 h/);
    assert.match(el.attrs['aria-label'], /dispatch suspendido/i);
});

test('el renderer cliente marca el overflow de la divergencia', () => {
    const { render } = montarCliente();
    const el = render({
        estado: 'divergencia_bloqueada', bloqueado: true,
        added: [], removed: [1, 2, 3, 4, 5, 6, 7, 8, 9], count: 20, detected_at: hace(1),
    });
    assert.match(el.innerHTML, /\+3 más/);
});

test('el renderer cliente vuelve a role=status cuando no hay bloqueo', () => {
    const { render } = montarCliente();
    const el = render({ estado: 'sincronizado', bloqueado: false, added: [], removed: [], count: 88 });
    assert.equal(el.attrs.role, 'status');
    assert.match(el.innerHTML, /Sincronizado/);
    assert.match(el.innerHTML, /88 issues alineados/);
});

test('paridad SSR ↔ cliente: label y detalle dicen exactamente lo mismo', () => {
    const { render } = montarCliente();
    const casos = [
        { estado: 'divergencia_bloqueada', bloqueado: true, added: [], removed: [5689, 5690], count: 91, detected_at: hace(3) },
        { estado: 'divergencia_bloqueada', bloqueado: true, added: [4444], removed: [1, 2, 3, 4, 5, 6, 7], count: 30, detected_at: hace(26) },
        { estado: 'divergencia_bloqueada', bloqueado: false, added: [7777], removed: [], count: 10, detected_at: null },
        { estado: 'sincronizado', bloqueado: false, added: [], removed: [], count: 88, detected_at: null },
        { estado: 'realineado_reductivo', bloqueado: false, added: [], removed: [9], count: 5, detected_at: null },
        { estado: 'desconocido', bloqueado: false, added: [], removed: [], count: 0, detected_at: null },
    ];
    const extraer = (html, clase) => {
        const m = html.match(new RegExp(`<span class="${clase}">([\\s\\S]*?)</span>`));
        return m ? m[1] : null;
    };
    for (const caso of casos) {
        const cliente = render(caso).innerHTML;
        const servidor = ssr.renderDesyncPill({ ic: (n) => `<svg class="pl-ic"><use href="#ic-${n}"/></svg>`, desync: caso });
        assert.equal(extraer(cliente, 'dss-label'), extraer(servidor, 'dss-label'),
            `label distinto para estado=${caso.estado} bloqueado=${caso.bloqueado}`);
        assert.equal(extraer(cliente, 'dss-detail'), extraer(servidor, 'dss-detail'),
            `detalle distinto para estado=${caso.estado} bloqueado=${caso.bloqueado}`);
        const roleSsr = /role="alert"/.test(servidor) ? 'alert' : 'status';
        assert.equal(render(caso).attrs.role, roleSsr,
            `role distinto para estado=${caso.estado} bloqueado=${caso.bloqueado}`);
    }
});

test('la clase .dss-chip-more existe en el CSS del dashboard (sin hex hardcodeado)', () => {
    const src = fs.readFileSync(path.join(RAIZ, 'dashboard.js'), 'utf8');
    const regla = src.match(/\.dss-chip-more\{[^}]*\}/);
    assert.ok(regla, 'el chip de overflow necesita su regla CSS');
    assert.doesNotMatch(regla[0], /#[0-9a-fA-F]{6}\b/, 'UX-7: colores por token, no hex');
});
