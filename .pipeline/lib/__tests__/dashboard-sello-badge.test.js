// =============================================================================
// Tests del render del badge del sello de evidencia — #6498
//
// Molde: `dashboard-architect-badge.test.js` (#3642). Tests aislados sin
// dashboard.js (que levanta un servidor HTTP al requerirse).
//
// Cubre:
//   - CA-5/UX-2 : cada badge tiene texto no vacio FUERA del <svg> + aria-label
//                 no vacio. Sin eso, quien no percibe el matiz ambar/rojo
//                 (1.44:1 en deuteranopia) no tiene ninguna senal.
//   - CA-9/SEC-2: allowlist cerrada de iconos por `switch`. Un estado con
//                 payload de script no emite markup ejecutable ni un
//                 <use href="#ic-..."> fuera de las 4 constantes.
//   - CA-7      : el HTML nuevo no contiene #RRGGBB / rgb( / rgba(.
//   - CA-10/SEC-3: el tooltip no lleva rutas absolutas ni URLs firmadas.
//   - CA-8      : el badge de inactividad y el uptime del header siguen
//                 emitiendo la misma clase y el mismo glifo que antes.
//   - CA-2/UX-G3: el copy completo del PO viaja en aria-label/title; el pill
//                 pinta el registro corto.
//   - UX-G1/G2  : borde de `escalado` con var(--danger); ninguna clase pulsa.
// =============================================================================

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { selloEvidenciaBadgeHTML } = require('../dashboard-slices');
const {
    resolveSelloEvidenciaState,
    SELLO_ESTADOS,
    SELLO_COPY,
} = require('../sello-evidencia-state');

const DASHBOARD_JS = path.join(__dirname, '..', '..', 'dashboard.js');

// Fake esc() compatible con el real de dashboard.js (5 chars XSS-relevantes).
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Spy sobre ic(): captura el nombre pedido e interpola CRUDO, igual que el real
// (`href="#ic-${name}"` sin escapar). Si el renderer derivara el nombre por
// concatenacion, el payload aparecerria aca sin escapar.
function makeIcSpy() {
    const calls = [];
    const ic = (name, ariaLabel, extraClass) => {
        calls.push({ name, ariaLabel, extraClass });
        const aria = ariaLabel
            ? ` role="img" aria-label="${String(ariaLabel).replace(/"/g, '&quot;')}"`
            : ' aria-hidden="true"';
        return `<svg class="pl-ic${extraClass ? ' ' + extraClass : ''}"${aria}><use href="#ic-${name}"/></svg>`;
    };
    return { ic, calls };
}

/** Texto visible del badge: lo que queda fuera de cualquier <svg>. */
function textoFueraDelSvg(html) {
    return html
        .replace(/<svg\b[\s\S]*?<\/svg>/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function infoDe(estado, extra) {
    return resolveSelloEvidenciaState(null, Object.assign({ estado, maxIntentos: 2 }, extra || {}));
}

function render(estado, extra) {
    const { ic, calls } = makeIcSpy();
    const html = selloEvidenciaBadgeHTML(infoDe(estado, extra), { esc, ic });
    return { html, calls };
}

// -----------------------------------------------------------------------------
// Defensa de entrada
// -----------------------------------------------------------------------------

test('sin info o sin deps el renderer devuelve string vacio (no rompe la tarjeta)', () => {
    const { ic } = makeIcSpy();
    assert.equal(selloEvidenciaBadgeHTML(null, { esc, ic }), '');
    assert.equal(selloEvidenciaBadgeHTML(undefined, { esc, ic }), '');
    assert.equal(selloEvidenciaBadgeHTML({}, { esc, ic }), '');
    assert.equal(selloEvidenciaBadgeHTML({ estado: 'sellado', copy: 'x' }, null), '');
    assert.equal(selloEvidenciaBadgeHTML({ estado: 'sellado', copy: 'x' }, { esc }), '');
    assert.equal(selloEvidenciaBadgeHTML({ estado: 'sellado', copy: 'x' }, { ic }), '');
});

test('CA-5: un info sin copy no se renderiza (un pill solo-glifo no es distinguible)', () => {
    const { ic } = makeIcSpy();
    assert.equal(selloEvidenciaBadgeHTML({ estado: 'sellado', copy: '', copyCorto: '' }, { esc, ic }), '');
});

// -----------------------------------------------------------------------------
// CA-5 / UX-2 — icono + etiqueta + aria-label en los 4 estados
// -----------------------------------------------------------------------------

test('CA-5/UX-2: los 4 estados emiten texto visible fuera del <svg> y aria-label no vacio', () => {
    for (const estado of SELLO_ESTADOS) {
        const { html } = render(estado);
        assert.ok(html, `${estado} no renderizo`);
        const visible = textoFueraDelSvg(html);
        assert.ok(visible.length > 0, `${estado}: sin texto visible fuera del svg`);
        const aria = /aria-label="([^"]*)"/.exec(html.replace(/<svg\b[\s\S]*?<\/svg>/g, ''));
        assert.ok(aria && aria[1].trim().length > 0, `${estado}: aria-label vacio`);
        assert.ok(html.includes('<svg'), `${estado}: sin glifo`);
        assert.ok(html.includes('lc-state-badge'), `${estado}: sin la clase base de la fila`);
    }
});

test('CA-5/UX-2: los textos visibles de los 4 estados son distintos entre si', () => {
    const visibles = SELLO_ESTADOS.map(e => textoFueraDelSvg(render(e).html));
    assert.equal(new Set(visibles).size, 4, `colision de etiquetas: ${visibles.join(' | ')}`);
});

test('CA-2/UX-G3: el pill pinta el registro corto y el copy completo va a aria-label y title', () => {
    const { html } = render('caduco');
    assert.equal(textoFueraDelSvg(html), 'se repite');
    const completo = esc(SELLO_COPY.caduco);
    assert.ok(html.includes(`aria-label="${completo}"`), `aria-label sin el copy del PO: ${html}`);
    assert.ok(html.includes('title="' + completo), `title sin el copy del PO: ${html}`);
});

test('CA-3: solo `escalado` usa el glifo de needs-human y la clase de danger', () => {
    const conNeedsHuman = [];
    for (const estado of SELLO_ESTADOS) {
        const { html, calls } = render(estado);
        if (calls.some(c => c.name === 'estado-needs-human')) conNeedsHuman.push(estado);
        if (estado !== 'escalado') {
            assert.equal(html.includes('lc-state-sello-escalado'), false, `${estado} usa la clase del escalado`);
        }
    }
    assert.deepEqual(conNeedsHuman, ['escalado']);
});

test('CA-2/UX-1: caduco usa ic-estado-stale y la clase propia, NO .lc-state-stale', () => {
    const { html, calls } = render('caduco');
    assert.deepEqual(calls.map(c => c.name), ['estado-stale']);
    assert.ok(html.includes('lc-state-sello-caduco'));
    assert.equal(/class="[^"]*\blc-state-stale\b/.test(html), false, 'repinta el badge de inactividad (R-1)');
});

test('re-sellando: el numero de intento sale del contador real, no de un literal', () => {
    const { html } = render('re-sellando', { intento: 2, maxIntentos: 2 });
    assert.equal(textoFueraDelSvg(html), 'resellando 2/2');
    assert.ok(html.includes(esc('Reintentando el sellado (2 de 2)')));
});

test('SEC-1: la variante de descarte se expone en el DOM con data-variant', () => {
    const fases = { 'desarrollo/verificacion': [{ sello: { presente: true, descartes: 1 } }] };
    const { ic } = makeIcSpy();
    const info = resolveSelloEvidenciaState(fases, {});
    const html = selloEvidenciaBadgeHTML(info, { esc, ic });
    assert.ok(html.includes('data-variant="descarte"'), html);
    const rutina = selloEvidenciaBadgeHTML(
        resolveSelloEvidenciaState({ a: [{ sello: { presente: true, descartes: 0 } }] }, {}),
        { esc, ic: makeIcSpy().ic },
    );
    assert.equal(rutina.includes('data-variant'), false, 'la rutina no lleva marca de descarte');
});

// -----------------------------------------------------------------------------
// CA-9 / SEC-2 — allowlist cerrada de iconos + escapado
// -----------------------------------------------------------------------------

test('CA-9/SEC-2: los nombres de icono salen de la allowlist de 4 constantes', () => {
    const vistos = new Set();
    for (const estado of SELLO_ESTADOS) {
        for (const c of render(estado).calls) vistos.add(c.name);
    }
    assert.deepEqual([...vistos].sort(), ['estado-needs-human', 'estado-retrying', 'estado-stale', 'info']);
});

test('CA-9/R-3: un estado con payload de script no renderiza NADA (el resolver corta)', () => {
    const payload = '"><script>alert(1)</script>';
    const { ic } = makeIcSpy();
    assert.equal(selloEvidenciaBadgeHTML(resolveSelloEvidenciaState(null, { estado: payload }), { esc, ic }), '');
});

test('CA-9/R-3: aunque el resolver se saltee, el renderer no deriva el icono por concatenacion', () => {
    // `info` fabricado a mano (simula un resolver comprometido o un futuro
    // caller descuidado): el switch tiene que cortar igual.
    const { ic, calls } = makeIcSpy();
    const html = selloEvidenciaBadgeHTML({
        estado: '"><script>alert(1)</script>',
        cssKey: '"><script>alert(1)</script>',
        icono: '"><script>alert(1)</script>',
        copy: 'inocente',
        copyCorto: 'inocente',
    }, { esc, ic });
    assert.equal(html, '');
    assert.equal(calls.length, 0, 'no se debe invocar ic() con un estado desconocido');
});

test('CA-9/SEC-2: un copy hostil se escapa; no queda markup ejecutable ni se rompe el atributo', () => {
    const { ic } = makeIcSpy();
    const html = selloEvidenciaBadgeHTML({
        estado: 'sellado',
        copy: '"><script>alert(1)</script>',
        copyCorto: '"><img src=x onerror=alert(1)>',
        detalle: '"><svg onload=alert(1)>',
        variante: null,
    }, { esc, ic });
    // No se abre ningun tag nuevo: el payload quedo como TEXTO escapado.
    assert.equal(/<script/i.test(html), false, html);
    assert.equal(/<img/i.test(html), false, html);
    assert.equal(/<svg\s+onload/i.test(html), false, html);
    assert.equal(html.includes('&lt;script&gt;'), true, 'el payload tiene que quedar escapado, no eliminado');
    // Ningun atributo se rompe: no queda '<' ni '>' crudo dentro de un valor.
    // Es lo que cubre el sink que `ic()` deja abierto (solo escapa comillas):
    // por eso el glifo va decorativo y el copy nunca entra por ese camino.
    for (const m of html.matchAll(/[\w-]+="([^"]*)"/g)) {
        assert.equal(/[<>]/.test(m[1]), false, `atributo con markup crudo: ${m[0]}`);
    }
    // Los unicos tags del badge son los tres esperados.
    const tags = [...html.matchAll(/<\s*\/?\s*([a-z][\w-]*)/gi)].map(m => m[1].toLowerCase());
    assert.deepEqual([...new Set(tags)].sort(), ['span', 'svg', 'use']);
    // El unico <use> del HTML sigue siendo el de la allowlist.
    const usos = [...html.matchAll(/href="#ic-([^"]*)"/g)].map(m => m[1]);
    assert.deepEqual(usos, ['info']);
});

// -----------------------------------------------------------------------------
// CA-7 / CA-10 — sin hexes, sin emojis, sin rutas
// -----------------------------------------------------------------------------

test('CA-7: el HTML de los 4 estados no contiene colores literales ni emojis del SO', () => {
    for (const estado of SELLO_ESTADOS) {
        const { html } = render(estado);
        assert.equal(/#[0-9a-f]{3,8}\b/i.test(html.replace(/href="#ic-[^"]*"/g, '')), false, `hex en ${estado}: ${html}`);
        assert.equal(/\brgba?\(/i.test(html), false, `rgb() en ${estado}: ${html}`);
        assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html), false, `emoji en ${estado}: ${html}`);
    }
});

test('CA-10/SEC-3: el tooltip no filtra rutas absolutas ni URLs', () => {
    for (const estado of SELLO_ESTADOS) {
        const { html } = render(estado);
        const title = /title="([^"]*)"/.exec(html);
        assert.ok(title, `${estado}: sin title`);
        assert.equal(/https?:/i.test(title[1]), false, `URL en el tooltip de ${estado}`);
        assert.equal(/[A-Za-z]:(&#39;|\\|\/)/.test(title[1]), false, `ruta absoluta en el tooltip de ${estado}`);
        assert.equal(/\b[0-9a-f]{16,}\b/i.test(title[1]), false, `hash en el tooltip de ${estado}`);
    }
});

// -----------------------------------------------------------------------------
// CA-7 / CA-8 / UX-G1 / UX-G2 — CSS: clases nuevas, estados existentes intactos
// -----------------------------------------------------------------------------

test('CA-7/UX-G1: las 4 clases nuevas usan tokens pelados y el borde de escalado es var(--danger)', () => {
    const src = fs.readFileSync(DASHBOARD_JS, 'utf8');
    const esperadas = {
        'lc-state-sello-sellado': 'background:var(--info-bg);color:var(--info);border-color:var(--info-dim)',
        'lc-state-sello-caduco': 'background:var(--retry-bg);color:var(--retry);border-color:var(--retry-dim)',
        'lc-state-sello-resellando': 'background:var(--retry-bg);color:var(--retry);border-color:var(--retry-dim)',
        // UX-G1: --danger-dim (#8B1A14) da 1.86:1 contra la tarjeta y no llega
        // al 3:1 de WCAG 1.4.11 para no-texto. Se usa el token base.
        'lc-state-sello-escalado': 'background:var(--danger-bg);color:var(--danger);border-color:var(--danger)',
    };
    for (const [clase, decl] of Object.entries(esperadas)) {
        assert.ok(src.includes(`.${clase}{${decl}}`), `falta o difiere la regla de .${clase}`);
    }
});

test('UX-G2: ninguna de las 4 clases nuevas lleva animation (no compite con needs-human)', () => {
    const src = fs.readFileSync(DASHBOARD_JS, 'utf8');
    for (const m of src.matchAll(/\.lc-state-sello-[a-z]+\{([^}]*)\}/g)) {
        assert.equal(/animation/.test(m[1]), false, `regla con animation: ${m[0]}`);
    }
});

test('CA-8: el badge de inactividad y el uptime del header quedan intactos', () => {
    const src = fs.readFileSync(DASHBOARD_JS, 'utf8');
    // La clase gris del badge de inactividad no se repinta.
    assert.ok(
        src.includes('.lc-state-stale{background:rgba(139,148,158,0.12);color:var(--text-dim,var(--dim));'),
        'la regla de .lc-state-stale cambio',
    );
    // Sigue habiendo exactamente 2 consumidores del glifo `estado-stale`
    // preexistentes (badge de inactividad + uptime del pulpo) en dashboard.js:
    // el badge del sello lo pide desde `dashboard-slices.js`, no desde aca.
    const usos = [...src.matchAll(/ic\('estado-stale'/g)].length;
    assert.equal(usos, 2, `cambio la cantidad de consumidores de ic('estado-stale') en dashboard.js: ${usos}`);
    // El badge de inactividad conserva su clase y su texto.
    assert.ok(src.includes('lc-state-badge lc-state-stale'), 'cambio el badge de inactividad');
    // needs-human conserva su pulso y su clase.
    assert.ok(src.includes('.lc-state-needshuman{'), 'cambio la clase de needs-human');
});

test('CA-8/R-2: el badge del sello no se cuelga de data.retrying ni de .lc-retrying', () => {
    const slices = fs.readFileSync(path.join(__dirname, '..', 'dashboard-slices.js'), 'utf8');
    const fn = /function selloEvidenciaBadgeHTML[\s\S]*?\n}/.exec(slices);
    assert.ok(fn, 'no se encontro el renderer');
    assert.equal(/retryingUntil|lc-retrying|data\.retrying/.test(fn[0]), false, fn[0]);
});

// -----------------------------------------------------------------------------
// Camino de LECTURA — el modo de falla silenciosa que advirtio la validacion
// tecnica: unit tests verdes, resolver devolviendo null y el badge que nunca se
// pinta. Paso de verdad durante el desarrollo (las regexes del scanner
// quedaron sin sus backslashes y los 3 estados transitorios no aparecian),
// asi que queda cubierto.
// -----------------------------------------------------------------------------

test('#6498 — el scanner reconoce los nombres REALES que escribe el emisor de #6496', () => {
    const src = fs.readFileSync(DASHBOARD_JS, 'utf8');
    const bloque = /state\.selloEvidencia = \(\(\) => \{[\s\S]*?\n  \}\)\(\);/.exec(src);
    assert.ok(bloque, 'no se encontro el scan del estado transitorio en dashboard.js');

    // Las dos regexes del scanner se extraen del fuente y se ejercitan contra
    // los nombres que produce `qa-evidence-seal.js`, no contra una copia.
    const literales = [...bloque[0].matchAll(/\/\^[^\n]*?\/\.exec\(nombre\)/g)].map(m => m[0]);
    assert.equal(literales.length, 2, `se esperaban 2 matchers, hay ${literales.length}`);

    const seal = require('../qa-evidence-seal');
    const nombreContador = path.basename(seal.sealRetriesPath(path.join('X', '.pipeline'), 6498));
    assert.equal(nombreContador, '.6498.seal-retries');

    const reContador = new RegExp(/^\.(\d+)\.seal-retries$/);
    const reOrden = new RegExp(/^(\d+)-.*\.json$/);
    // Las regexes vivas del archivo tienen que ser exactamente estas.
    assert.ok(bloque[0].includes(reContador.source), `el matcher del contador cambio: ${literales.join(' ')}`);
    assert.ok(bloque[0].includes(reOrden.source), `el matcher de la orden cambio: ${literales.join(' ')}`);

    // Y tienen que matchear los nombres reales.
    assert.equal(reContador.test(nombreContador), true, 'el contador real no matchea');
    assert.equal(reContador.test('.gitkeep'), false);
    assert.equal(reContador.test('6498.qa'), false);
    assert.equal(reOrden.test('6498-seal-caduco-20260831T140000.json'), true, 'la orden real no matchea');
    assert.equal(reOrden.test('.gitkeep'), false);
});

test('#6498 — el scan usa el tope de reintentos del emisor, no un literal propio', () => {
    const src = fs.readFileSync(DASHBOARD_JS, 'utf8');
    const bloque = /state\.selloEvidencia = \(\(\) => \{[\s\S]*?\n  \}\)\(\);/.exec(src);
    assert.ok(bloque);
    assert.ok(bloque[0].includes('MAX_SEAL_REQUEUES'), 'el tope tiene que salir de qa-evidence-seal');
    assert.equal(require('../qa-evidence-seal').MAX_SEAL_REQUEUES, 2);
});
