// =============================================================================
// Tests architect badge render — #3642 (widget architect 4 estados)
//
// Cubre el render del badge a traves de `dashboard-slices.architectBadgeHTML`
// y los helpers puros de `architect-badge-renderer.js`. Tests aislados sin
// dashboard.js (que tiene side effects HTTP).
//
// Cubre:
//   - Formato HH:MM con padStart cuando hay startedAt valido.
//   - Fallback '—' cuando startedAt es null / NaN / undefined / invalido.
//   - Defensa XSS (CA-IMPL-B6-XSS-DEFENSIVE): payload '<script>' no se inyecta
//     literal en title/aria-label.
//   - CA-2: las 4 referencias literales `ic('architect-<state>')` viven en
//     dashboard-slices.js (verificado por test de output que invoca cada
//     estado y verifica el name pasado a ic()).
//   - CA-6 + R7: con sprite vacio (sin `<symbol>` registrados) el output
//     incluye igual la clase base `lc-state-badge` + texto y NO contiene
//     emojis del SO.
//   - CA-4 / R3: posicion en `stateBadges` simulado entre needshuman y stale.
// =============================================================================

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    formatArchitectStartedAt,
    architectAriaLabel,
    architectBadgeText,
} = require('../architect-badge-renderer');

const { architectBadgeHTML } = require('../dashboard-slices');

// Fake esc() compatible con el real de dashboard.js (5 chars XSS-relevantes).
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Spy sobre ic() que captura cada llamada para verificar nombres.
function makeIcSpy() {
    const calls = [];
    const ic = (name, ariaLabel, extraClass) => {
        calls.push({ name, ariaLabel, extraClass });
        return `<svg class="pl-ic"${ariaLabel ? ` role="img" aria-label="${String(ariaLabel).replace(/"/g, '&quot;')}"` : ''}><use href="#ic-${name}"/></svg>`;
    };
    return { ic, calls };
}

// -----------------------------------------------------------------------------
// formatArchitectStartedAt
// -----------------------------------------------------------------------------

test('formatArchitectStartedAt: HH:MM con padStart cuando ambas componentes son < 10', () => {
    // 2026-05-30 07:05 local time.
    const ms = new Date(2026, 4, 30, 7, 5).getTime();
    assert.equal(formatArchitectStartedAt(ms), '07:05');
});

test('formatArchitectStartedAt: HH:MM sin padding cuando componentes son >= 10', () => {
    const ms = new Date(2026, 4, 30, 14, 32).getTime();
    assert.equal(formatArchitectStartedAt(ms), '14:32');
});

test('formatArchitectStartedAt: fallback "—" para null/undefined/NaN', () => {
    assert.equal(formatArchitectStartedAt(null), '—');
    assert.equal(formatArchitectStartedAt(undefined), '—');
    assert.equal(formatArchitectStartedAt(NaN), '—');
});

test('formatArchitectStartedAt: fallback "—" para string (no number)', () => {
    // R6 — no expone error de parseo; cae al fallback.
    assert.equal(formatArchitectStartedAt('<script>alert(1)</script>'), '—');
});

// -----------------------------------------------------------------------------
// architectBadgeHTML — render completo
// -----------------------------------------------------------------------------

test('architectBadgeHTML: state=null/info=null produce string vacio', () => {
    const { ic } = makeIcSpy();
    assert.equal(architectBadgeHTML(null, { esc, ic }), '');
    assert.equal(architectBadgeHTML({ state: null, startedAt: null }, { esc, ic }), '');
});

test('architectBadgeHTML: state=pending incluye clase + texto + aria-label en español', () => {
    const { ic, calls } = makeIcSpy();
    const html = architectBadgeHTML({ state: 'pending', startedAt: null }, { esc, ic });
    assert.match(html, /class="lc-state-badge lc-state-architect-pending"/);
    assert.match(html, /aria-label="architect pendiente"/);
    assert.match(html, /title="architect pendiente"/);
    assert.match(html, /architect: pendiente/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'architect-pending');
});

test('architectBadgeHTML: state=running incluye HH:MM con padStart', () => {
    const { ic, calls } = makeIcSpy();
    const ms = new Date(2026, 4, 30, 7, 5).getTime();
    const html = architectBadgeHTML({ state: 'running', startedAt: ms }, { esc, ic });
    assert.match(html, /07:05/);
    assert.doesNotMatch(html, /\b7:5\b/); // sin padStart fallaria
    assert.match(html, /class="lc-state-badge lc-state-architect-running"/);
    assert.equal(calls[0].name, 'architect-running');
});

test('architectBadgeHTML: state=running con startedAt invalido renderiza "—" escapado', () => {
    const { ic } = makeIcSpy();
    const html = architectBadgeHTML({ state: 'running', startedAt: NaN }, { esc, ic });
    // El "—" debe pasar por esc(). esc("—") = "—" (caracter unicode, no XSS).
    assert.match(html, /—/);
    assert.match(html, /architect trabajando desde —/);
});

test('architectBadgeHTML: state=approved/rejected con icono correcto', () => {
    const spy1 = makeIcSpy();
    const html1 = architectBadgeHTML({ state: 'approved', startedAt: null }, { esc, ic: spy1.ic });
    assert.match(html1, /class="lc-state-badge lc-state-architect-approved"/);
    assert.equal(spy1.calls[0].name, 'architect-approved');
    assert.match(html1, /architect: aprobado/);

    const spy2 = makeIcSpy();
    const html2 = architectBadgeHTML({ state: 'rejected', startedAt: null }, { esc, ic: spy2.ic });
    assert.match(html2, /class="lc-state-badge lc-state-architect-rejected"/);
    assert.equal(spy2.calls[0].name, 'architect-rejected');
    assert.match(html2, /architect: requiere ajustes/);
});

// -----------------------------------------------------------------------------
// CA-IMPL-B6-XSS-DEFENSIVE — payload XSS via startedAt
// -----------------------------------------------------------------------------

test('CA-IMPL-B6-XSS-DEFENSIVE: startedAt string con <script> cae a "—" sin inyectar HTML literal', () => {
    const { ic } = makeIcSpy();
    // startedAt no es number → cae a '—'. No hay forma de que llegue
    // un payload XSS al DOM por esta via porque formatArchitectStartedAt
    // valida `typeof === number` antes de procesar.
    const html = architectBadgeHTML({
        state: 'running',
        startedAt: '<script>alert(1)</script>',
    }, { esc, ic });
    // Garantizar AMBAS condiciones (refuerzo security):
    //   1) NO contiene `<script>` literal sin escapar.
    //   2) NO contiene `&lt;script&gt;` tampoco (porque cae a '—' antes).
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /alert\(1\)/);
});

test('CA-IMPL-B6-XSS-DEFENSIVE: esc() se aplica a aria-label y title (verificacion sintactica)', () => {
    // Inyectamos un esc() falso que marca su input para verificar que el
    // renderer pasa los valores dinamicos por esc() antes de interpolar.
    let escCalls = 0;
    const escSpy = (s) => { escCalls++; return esc(s); };
    const { ic } = makeIcSpy();
    architectBadgeHTML({ state: 'approved', startedAt: null }, { esc: escSpy, ic });
    // Esperamos al menos 3 llamadas: a11y (title), a11y (aria-label), text (body).
    assert.ok(escCalls >= 3, `esc() debe llamarse ≥3 veces, fue ${escCalls}`);
});

// -----------------------------------------------------------------------------
// CA-6 + R7 — degradacion gracil (sprite vacio)
// -----------------------------------------------------------------------------

test('CA-6: con sprite vacio (ic devuelve "" porque _iconSpriteCache=""), el badge mantiene clase base y texto', () => {
    // Simulamos ic() del dashboard cuando _iconSpriteCache es vacio:
    // la helper igual emite `<svg><use href="#ic-..."/></svg>` (el browser
    // ignora el use sin symbol). Esto preserva altura no nula via la clase
    // base `lc-state-badge`.
    const icDegraded = (name, ariaLabel) => `<svg class="pl-ic" role="img" aria-label="${ariaLabel}"><use href="#ic-${name}"/></svg>`;
    const html = architectBadgeHTML({ state: 'approved', startedAt: null }, { esc, ic: icDegraded });
    assert.match(html, /class="lc-state-badge lc-state-architect-approved"/);
    assert.match(html, /architect: aprobado/);
    // R7: la clase base garantiza display:inline-flex + padding → altura > 0.
    // Verificamos que el HTML SI contiene la clase base (la altura se
    // valida visualmente en smoke test; el CSS de la clase es responsabilidad
    // del bloque `.lc-state-badge` en dashboard.js:3056).
    assert.match(html, /lc-state-badge/);
});

test('CA-2/CA-6: degradacion gracil NO inyecta emojis del SO', () => {
    const icDegraded = (name) => `<svg><use href="#ic-${name}"/></svg>`;
    for (const state of ['pending', 'running', 'approved', 'rejected']) {
        const html = architectBadgeHTML({ state, startedAt: state === 'running' ? Date.now() : null }, { esc, ic: icDegraded });
        assert.doesNotMatch(html, /⏳/, `state=${state} no debe contener ⏳`);
        assert.doesNotMatch(html, /🔄/, `state=${state} no debe contener 🔄`);
        assert.doesNotMatch(html, /✅/, `state=${state} no debe contener ✅`);
        assert.doesNotMatch(html, /❌/, `state=${state} no debe contener ❌`);
    }
});

// -----------------------------------------------------------------------------
// CA-2 — referencias a 4 simbolos del sprite
// -----------------------------------------------------------------------------

test('CA-2: cada estado invoca ic() con el name `architect-<state>` correspondiente', () => {
    const states = ['pending', 'running', 'approved', 'rejected'];
    for (const state of states) {
        const { ic, calls } = makeIcSpy();
        architectBadgeHTML({ state, startedAt: state === 'running' ? Date.now() : null }, { esc, ic });
        assert.equal(calls.length, 1, `state=${state} debe invocar ic() exactamente una vez`);
        assert.equal(calls[0].name, `architect-${state}`, `state=${state} debe pasar name=architect-${state} a ic()`);
    }
});

// -----------------------------------------------------------------------------
// CA-4 — orden en stateBadges (simulado)
// -----------------------------------------------------------------------------

test('CA-4: orden simulado de stateBadges con crossphase + rebote + needshuman + architect + stale', () => {
    // Simulamos el array stateBadges del dashboard y verificamos el orden
    // de insercion. El badge architect va inmediatamente despues de
    // needshuman y antes de stale.
    const stateBadges = [];
    stateBadges.push('CROSS-PHASE');
    stateBadges.push('REBOTE');
    stateBadges.push('NEEDS-HUMAN');
    // -- aqui se inserta el badge architect --
    const { ic } = makeIcSpy();
    const arch = architectBadgeHTML({ state: 'rejected', startedAt: null }, { esc, ic });
    stateBadges.push(arch);
    stateBadges.push('STALE');

    assert.equal(stateBadges.length, 5);
    assert.equal(stateBadges[0], 'CROSS-PHASE');
    assert.equal(stateBadges[1], 'REBOTE');
    assert.equal(stateBadges[2], 'NEEDS-HUMAN');
    assert.match(stateBadges[3], /lc-state-architect-rejected/);
    assert.equal(stateBadges[4], 'STALE');
});

// -----------------------------------------------------------------------------
// Defensa: invocacion sin deps o con deps incompletas
// -----------------------------------------------------------------------------

test('architectBadgeHTML: deps incompletas devuelve string vacio (no rompe la tarjeta)', () => {
    assert.equal(architectBadgeHTML({ state: 'pending', startedAt: null }, null), '');
    assert.equal(architectBadgeHTML({ state: 'pending', startedAt: null }, {}), '');
    assert.equal(architectBadgeHTML({ state: 'pending', startedAt: null }, { esc }), '');
});

// -----------------------------------------------------------------------------
// architectAriaLabel / architectBadgeText (helpers)
// -----------------------------------------------------------------------------

test('architectAriaLabel: textos en español para los 4 estados', () => {
    assert.equal(architectAriaLabel({ state: 'pending' }), 'architect pendiente');
    assert.equal(architectAriaLabel({ state: 'approved' }), 'architect aprobado');
    assert.equal(architectAriaLabel({ state: 'rejected' }), 'architect requiere ajustes');
    const ms = new Date(2026, 4, 30, 9, 7).getTime();
    assert.equal(architectAriaLabel({ state: 'running', startedAt: ms }), 'architect trabajando desde 09:07');
});

test('architectBadgeText: textos visibles del badge', () => {
    assert.equal(architectBadgeText({ state: 'pending' }), 'architect: pendiente');
    assert.equal(architectBadgeText({ state: 'approved' }), 'architect: aprobado');
    assert.equal(architectBadgeText({ state: 'rejected' }), 'architect: requiere ajustes');
    const ms = new Date(2026, 4, 30, 14, 32).getTime();
    assert.equal(architectBadgeText({ state: 'running', startedAt: ms }), 'architect: trabajando · 14:32');
});
