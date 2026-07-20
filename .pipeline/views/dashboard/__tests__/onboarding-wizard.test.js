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
