// =============================================================================
// quota-exhausted-bare-error-5978.test.js — Shape DESNUDO `{error:{code}}` de
// los providers OpenAI-compat (#5978).
//
// INCIDENTE QUE FIJA ESTA SUITE
// -----------------------------
// El 2026-08-22 la fase `aprobacion` quedó trabada: cada agente LLM moría al
// spawn en <1s y el Pulpo rebotaba issues sanos con "Huérfano tras 3 reintentos"
// (#5978 entre ellos). El log del agente contenía UNA sola línea:
//
//   {"error":{"status":402,"message":"Payment required to access this resource.
//    Visit your billing tab.","code":"insufficient_quota"}}
//
// Cerebras se había quedado sin crédito. Pero `_detectOpenAI` sólo entendía los
// shapes CON sobre SSE (`{event:'error',data:{error:{type}}}`) o
// `{type:'response.error',error:{type}}`, y buscaba el discriminador en `type`,
// nunca en `code`. Resultado: `matched:false` ⇒ nunca se seteaba el flag de
// cuota ⇒ el resolver seguía eligiendo Cerebras ⇒ el agente volvía a morir ⇒
// cada relanzamiento quemaba un reintento DEL ISSUE hasta el rebote.
//
// La causa era doble y esta suite cubre las dos patas:
//   A. de SHAPE  — el objeto `{error:{...}}` desnudo era invisible al detector
//                  (afectaba a TODOS los OpenAI-compat, incluido nvidia-nim,
//                  que ya declaraba `insufficient_quota` y aun así no matcheaba).
//   B. de ALLOWLIST — `cerebras` no declaraba `insufficient_quota`.
//
// INVARIANTES QUE NO SE RELAJAN
// -----------------------------
// El match sigue siendo fail-closed y estructural: se leen SÓLO los campos de
// control `type`/`code` del `error` de nivel raíz, y sólo cuentan si el provider
// DECLARÓ ese error_type. Nada de substring sobre texto libre, nada de canal de
// contenido del modelo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const quota = require('../quota-exhausted.js');
const models = require('../../agent-models.json');

// Línea EXACTA observada en `.pipeline/logs/5459-ux.log` y hermanos (2026-08-22).
const CEREBRAS_402_LINE =
    '{"error":{"status":402,"message":"Payment required to access this resource. Visit your billing tab.","code":"insufficient_quota"}}';

test('#5978 el 402 desnudo de Cerebras se detecta como cuota agotada', () => {
    const evt = JSON.parse(CEREBRAS_402_LINE);
    const det = quota.detectQuotaError(evt, models.providers.cerebras);
    assert.equal(det.matched, true, 'el 402 de billing debe matchear');
    assert.equal(det.errorType, 'insufficient_quota');
});

test('#5978 causa A (shape): el shape desnudo matchea en todo OpenAI-compat que lo declare', () => {
    const evt = JSON.parse(CEREBRAS_402_LINE);
    // nvidia-nim ya declaraba `insufficient_quota` y aun así no matcheaba antes
    // del fix: prueba de que la falla era de SHAPE, no sólo de allowlist.
    for (const p of ['nvidia-nim', 'kimi-moonshot', 'openai-codex']) {
        const def = models.providers[p];
        if (!def || def.output_parser !== 'openai-sse') continue;
        assert.equal(
            quota.detectQuotaError(evt, def).matched, true,
            `${p} declara insufficient_quota y debe matchear el shape desnudo`,
        );
    }
});

test('#5978 causa B (allowlist): cerebras declara insufficient_quota en agent-models.json', () => {
    assert.ok(
        models.providers.cerebras.quota_error_types.includes('insufficient_quota'),
        'sin el tipo declarado, el 402 vuelve a ser invisible',
    );
});

test('#5978 el JSON y la meta-allowlist de quota-exhausted quedan en sync', () => {
    // agent-models-validate hace fail-fast al boot si el JSON declara un tipo
    // fuera de la meta-allowlist. Este test lo detecta antes del restart.
    const meta = quota.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER;
    if (!meta) return; // no exportada: la cubre agent-models-validate.test.js
    for (const [prov, def] of Object.entries(models.providers)) {
        const declared = def.quota_error_types || [];
        if (!declared.length || !meta[prov]) continue;
        for (const t of declared) {
            assert.ok(
                meta[prov].includes(t),
                `${prov} declara "${t}" fuera de la meta-allowlist de quota-exhausted.js`,
            );
        }
    }
});

// -----------------------------------------------------------------------------
// FAIL-CLOSED — lo que NO debe matchear nunca.
// -----------------------------------------------------------------------------

test('#5978 fail-closed: un provider que NO declara el tipo no matchea', () => {
    const evt = JSON.parse(CEREBRAS_402_LINE);
    // gemini-google declara sólo quota_exceeded/resource_exhausted.
    assert.equal(quota.detectQuotaError(evt, models.providers['gemini-google']).matched, false);
});

test('#5978 fail-closed: un error que no es de cuota no matchea', () => {
    for (const code of ['invalid_request', 'context_length_exceeded', 'server_error']) {
        const det = quota.detectQuotaError({ error: { status: 400, code } }, models.providers.cerebras);
        assert.equal(det.matched, false, `"${code}" no es cuota y no debe matchear`);
    }
});

test('#5978 fail-closed: nunca se matchea por texto libre del mensaje', () => {
    // El mensaje menciona billing/payment pero el `code` no es de cuota.
    const evt = { error: { status: 400, message: 'Payment required insufficient_quota quota_exceeded', code: 'invalid_request' } };
    assert.equal(quota.detectQuotaError(evt, models.providers.cerebras).matched, false);
});

test('#5978 fail-closed: el canal de contenido del modelo no puede inducir el match', () => {
    // El modelo devolviendo texto con el tipo adentro NO es un evento de error.
    const evt = { type: 'assistant', message: { content: [{ type: 'text', text: 'insufficient_quota' }] } };
    assert.equal(quota.detectQuotaError(evt, models.providers.cerebras).matched, false);
});

test('#5978 fail-closed: error no-objeto o array no rompe ni matchea', () => {
    for (const bad of [{ error: 'insufficient_quota' }, { error: ['insufficient_quota'] }, { error: null }, {}, null]) {
        const det = quota.detectQuotaError(bad, models.providers.cerebras);
        assert.equal(det.matched, false);
    }
});

test('#5978 el shape desnudo no pisa los shapes con sobre SSE', () => {
    // Shape canónico SSE sigue funcionando.
    const sse = { event: 'error', data: { error: { type: 'rate_limit_exceeded' } } };
    const det = quota.detectQuotaError(sse, models.providers.cerebras);
    assert.equal(det.matched, true);
    assert.equal(det.errorType, 'rate_limit_exceeded');
});
