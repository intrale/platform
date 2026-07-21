'use strict';

// =============================================================================
// onboarding-wizard.test.js — Wizard de onboarding del descriptor (#4778).
//
// Cobertura → criterios:
//   - CA-1.1 / CA-5.2 : el alta se hace desde la UI (form + POST), sin editar archivos.
//   - SEC-4  : secretos SÓLO por referencia — no hay input de valor crudo.
//   - SEC-7a : POST + X-CSRF-Token same-origin; sin disparador GET con efecto de estado.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const view = require('..' + path.sep + 'onboarding-wizard.js');
const { slug, renderOnboardingWizardSsr, renderOnboardingWizardClientScript, STEPS, KERNEL_SKILLS } = view;

test('exporta el contrato canónico', () => {
    assert.equal(slug, 'onboarding');
    assert.equal(typeof renderOnboardingWizardSsr, 'function');
    assert.equal(typeof renderOnboardingWizardClientScript, 'function');
    assert.equal(STEPS.length, 5);
});

test('CA-1.1/CA-5.2: renderiza el form con los 5 pasos y los campos del descriptor', () => {
    const html = renderOnboardingWizardSsr();
    assert.ok(html.includes('data-slug="onboarding"'));
    assert.ok(html.includes('id="ow-form"'));
    // Un fieldset por paso.
    for (let i = 0; i < 5; i++) assert.ok(html.includes(`data-step="${i}"`), `falta el paso ${i}`);
    // Campos clave del descriptor.
    for (const id of ['ow-projectId', 'ow-name', 'ow-repo-url', 'ow-board-ref', 'ow-cap-skills', 'ow-auth-signers', 'ow-auth-gate2']) {
        assert.ok(html.includes(`id="${id}"`), `falta el campo ${id}`);
    }
    // Submit presente (alta desde la UI, sin editar archivos a mano).
    assert.ok(html.includes('owSubmit()'));
});

test('SEC-4: pide credenciales SÓLO por referencia — no hay input de valor crudo', () => {
    const html = renderOnboardingWizardSsr();
    // Campo de referencia presente con patrón ruta#scope.
    assert.ok(html.includes('id="ow-cred-ref"'));
    assert.ok(html.includes('#acme') || html.includes('ruta#scope') || html.includes('#namespace'));
    // Nota de seguridad visible.
    assert.ok(/Nunca pegues un secreto/i.test(html));
    // NO existe un campo para el valor del secreto ni inputs password.
    assert.ok(!html.includes('ow-cred-value'), 'no debe haber input de valor de secreto');
    assert.ok(!html.includes('type="password"'), 'no debe haber input password de secreto');
});

test('SEC-4: el descriptor que arma el cliente sólo transporta ref+scopes de credenciales', () => {
    const script = renderOnboardingWizardClientScript();
    // Construye credentials con ref y scopes; nunca un valor de secreto.
    assert.ok(script.includes('ref: credRef'));
    assert.ok(script.includes('scopes: owList'));
    assert.ok(!/secretValue|credValue|password/i.test(script));
});

test('SEC-7a: el alta es POST + X-CSRF-Token same-origin, sin GET mutante', () => {
    const script = renderOnboardingWizardClientScript();
    assert.ok(script.includes("method: 'POST'"));
    assert.ok(script.includes('X-CSRF-Token'));
    assert.ok(script.includes('/api/product/csrf-token'));
    assert.ok(script.includes('/api/product/onboard'));
    // El token se pide por GET (cache:no-store) y el efecto va por POST.
    assert.ok(script.includes("fetch('/api/product/csrf-token', { cache: 'no-store' })"));
});

test('el resultado reflejado del backend se escapa (defensa XSS)', () => {
    const script = renderOnboardingWizardClientScript();
    assert.ok(script.includes('function owEsc('));
    // Se usa owEsc al pintar detalles de error del backend.
    assert.ok(script.includes('owEsc(det)'));
});

test('las opciones de skills reflejan la allowlist del kernel', () => {
    const html = renderOnboardingWizardSsr();
    for (const s of KERNEL_SKILLS) assert.ok(html.includes(s), `falta mención del skill ${s}`);
});

// -----------------------------------------------------------------------------
// #4800 — segmented control "Usar existente / Crear nuevo" + campos de creación
// -----------------------------------------------------------------------------

test('CA-UX-1: el paso 2 muestra el segmented control con "Usar existente" activo por default', () => {
    const html = renderOnboardingWizardSsr();
    assert.ok(html.includes('id="ow-repo-mode-existing"'));
    assert.ok(html.includes('id="ow-repo-mode-create"'));
    // Segmented (radiogroup), no dropdown; existente activo.
    assert.ok(/ow-repo-mode-existing[^>]*ow-seg-active/.test(html) || /ow-seg-active[^>]*ow-repo-mode-existing/.test(html)
        || html.includes('class="ow-seg-btn ow-seg-active" id="ow-repo-mode-existing"'));
    assert.ok(html.includes('role="radiogroup"'));
});

test('CA-UX-2: modo crear expone nombre/org(select)/visibilidad + chip de URL automática', () => {
    const html = renderOnboardingWizardSsr();
    assert.ok(html.includes('id="ow-repo-name"'));
    assert.ok(html.includes('id="ow-repo-org"'));
    assert.ok(html.includes('name="ow-repo-visibility"'));
    // org es <select> contra allowlist (A01), no texto libre.
    assert.ok(/<select[^>]*id="ow-repo-org"/.test(html));
    // Chip informativo de URL automática.
    assert.ok(/se completa autom/i.test(html));
});

test('CA-UX-3: visibilidad arranca en private; existe warning para public', () => {
    const html = renderOnboardingWizardSsr();
    assert.ok(/value="private"[^>]*checked|checked[^>]*value="private"/.test(html));
    assert.ok(html.includes('id="ow-repo-public-warn"'));
    assert.ok(/PÚBLICO/.test(html));
});

test('#4800: owBuildDescriptor arma provenance según el modo (create sin url, existing con url)', () => {
    const script = renderOnboardingWizardClientScript();
    assert.ok(script.includes("provenance = 'create'"));
    assert.ok(script.includes('repo.create = {'));
    assert.ok(script.includes("provenance = 'existing'"));
    // toggle de modo y warning de visibilidad presentes.
    assert.ok(script.includes('function owRepoMode('));
    assert.ok(script.includes('function owVisibilityChange('));
});

// =============================================================================
// #4801 · CA-4 + G-1..G-4 — endurecimiento de feedback del wizard.
// =============================================================================

test('G-3: muestra estado intermedio "Validando…" durante el POST', () => {
    const script = renderOnboardingWizardClientScript();
    assert.ok(script.includes('function owRenderPending('));
    assert.ok(script.includes('owRenderPending('), 'owSubmit debe pintar el estado intermedio');
    assert.ok(/Validando/.test(script));
});

test('G-1/G-2: copy de éxito dice "encolado≠activo" y apunta a la pestaña Productos', () => {
    const script = renderOnboardingWizardClientScript();
    assert.ok(script.includes('function owRenderSuccess('));
    assert.ok(/Onboarding/.test(script) && /inactivo/i.test(script), 'aclara que queda inactivo');
    assert.ok(script.includes('?view=estado-productos'), 'apunta a la pestaña Productos');
});

test('G-4/CA-4: mapea el rechazo a copy humano sin jerga ni internals', () => {
    const script = renderOnboardingWizardClientScript();
    assert.ok(script.includes('function owHumanError('));
    // El éxito sólo se marca si el backend confirmó (fail-closed).
    assert.ok(script.includes('if(j && j.ok){ owRenderSuccess('));
    // No se vuelca `j.errors` crudo del backend a la UI (evita filtrar host/paths).
    assert.ok(!script.includes('owHumanError(j)') ? false : true);
    assert.ok(!/owRenderResult\(false, \(j && j\.msg\)/.test(script), 'no propaga msg crudo del backend');
    // Sin jerga técnica en el copy de error del operador.
    for (const jargon of ['fail-closed', 'dry-run', 'TOCTOU', 'SSRF']) {
        assert.ok(!new RegExp(jargon, 'i').test(script.split('function owHumanError(')[1].split('}')[0] || ''), `owHumanError no debe usar "${jargon}"`);
    }
});
