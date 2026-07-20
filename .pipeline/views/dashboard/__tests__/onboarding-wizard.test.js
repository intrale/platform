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
const { slug, renderOnboardingWizardSsr, renderOnboardingWizardClientScript, STEPS, KERNEL_SKILLS,
    PROVIDER_ORDER_OPTIONS, KERNEL_DEFAULT_PROVIDER_ORDER } = view;

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
// #4807 — Control de orden de providers.
// -----------------------------------------------------------------------------

test('#4807: la allowlist del control es la canónica del kernel (con nvidia-nim, sin Groq ni deterministic)', () => {
    const keys = PROVIDER_ORDER_OPTIONS.map((p) => p.key);
    assert.deepEqual(keys, ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim']);
    assert.deepEqual(KERNEL_DEFAULT_PROVIDER_ORDER, keys, 'el default persiste el orden de la allowlist');
    assert.ok(keys.includes('nvidia-nim'), 'debe ofrecer NVIDIA NIM');
    assert.ok(!keys.includes('groq'), 'NO debe ofrecer Groq (descontinuado #3353)');
    assert.ok(!keys.includes('deterministic'), 'NO debe ofrecer deterministic (interno de test)');
});

test('#4807: el mapeo humano↔interno es único y persiste claves internas', () => {
    const byLabel = Object.fromEntries(PROVIDER_ORDER_OPTIONS.map((p) => [p.label, p.key]));
    assert.equal(byLabel['Claude'], 'anthropic');
    assert.equal(byLabel['Codex'], 'openai-codex');
    assert.equal(byLabel['Gemini'], 'gemini-google');
    assert.equal(byLabel['Cerebras'], 'cerebras');
    assert.equal(byLabel['NVIDIA NIM'], 'nvidia-nim');
    // Claude/Codex pagos; el resto free (informativo).
    const byKey = Object.fromEntries(PROVIDER_ORDER_OPTIONS.map((p) => [p.key, p.tier]));
    assert.equal(byKey['anthropic'], 'pago');
    assert.equal(byKey['openai-codex'], 'pago');
    assert.equal(byKey['gemini-google'], 'free');
    assert.equal(byKey['cerebras'], 'free');
    assert.equal(byKey['nvidia-nim'], 'free');
});

test('#4807: el control es reorden accesible (no texto libre) con contenedores + aria-labels', () => {
    const html = renderOnboardingWizardSsr();
    assert.ok(html.includes('id="ow-prov-active"'), 'falta la lista de activos');
    assert.ok(html.includes('id="ow-prov-available"'), 'falta la lista de disponibles');
    // NO hay input de texto libre para providers.
    assert.ok(!html.includes('id="ow-providers-input"'));
    // El control está dentro del step Capacidades (data-step="3").
    const script = renderOnboardingWizardClientScript();
    assert.ok(/aria-label="Subir/.test(script), 'los botones ↑ deben tener aria-label de posición');
    assert.ok(/aria-label="Bajar/.test(script));
    assert.ok(script.includes('function owProvMove('));
    assert.ok(script.includes('function owProvAdd('), 'patrón activos + disponibles');
    assert.ok(script.includes('function owProvRemove('));
});

test('#4807: owBuildDescriptor serializa thresholds.providerOrder con claves internas', () => {
    const script = renderOnboardingWizardClientScript();
    assert.ok(script.includes('d.thresholds = { providerOrder: order }'));
    // La metadata inyectada usa las claves internas canónicas.
    assert.ok(script.includes('"anthropic"') && script.includes('"nvidia-nim"'));
    // Sin tocar el control, se persiste el default explícito (OW_PROVIDERS arranca en el default).
    assert.ok(script.includes('var OW_PROVIDERS = OW_PROVIDER_KEYS.slice();'));
    assert.ok(script.includes('OW_PROVIDER_KEYS.slice()'), 'fallback al default si la lista queda vacía');
});

test('#4807: owProvAdd respeta la allowlist y uniqueItems (fail-closed en la UI)', () => {
    const script = renderOnboardingWizardClientScript();
    // Sólo agrega claves con metadata (allowlist) y evita duplicados.
    assert.ok(script.includes('if(!owProvMeta(key)) return;'));
    assert.ok(script.includes('if(OW_PROVIDERS.indexOf(key) !== -1) return;'));
});
