// =============================================================================
// provider-error-parser-cli-http-frame-6190.test.js
//
// Regresión de #6190 — "Huérfano tras 3 reintentos" por cuota misatribuida.
//
// INCIDENTE
// ---------
// Los agentes de `aprobacion` de #6190 (architect, ux) murieron con un frame
// HTTP crudo del provider:
//
//   {"error":{"status":402,"message":"Payment required ...","code":"insufficient_quota"}}
//
// `detectFromCliStderr` no lo reconocía: no tiene el shape propietario de
// `_detectAnthropic` (paso 1) ni de `_detectOpenAI` (paso 2), y queda excluido
// del scan de texto libre (paso 3) porque `plainTextLines` filtra a propósito
// todo frame que parsee como JSON/SSE (defensa #4541/#4865). El parser devolvía
// `null` y `classifyByContext` lo degradaba a `transient_5xx` por
// `exitCode!=0 + stderr_present`.
//
// Consecuencia en cadena: `transient_5xx` NO setea el flag de cuota ni apaga el
// provider ⇒ el pipeline seguía martillando un provider exhausto ⇒ los agentes
// morían una y otra vez ⇒ `brazoHuerfanos` consumía los 3 reintentos del ISSUE
// ⇒ `resultado: rechazado` con motivo "proceso muere repetidamente", rebotando
// #6190 a dev como si el CÓDIGO estuviera roto.
//
// El path de API directa ya tenía la red de salvataje (#3486). Estos tests
// cubren la red equivalente para el path CLI.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const parser = require('../provider-error-parser');

// Frame textual EXACTO observado en `.pipeline/logs/6190-architect.log`.
const FRAME_402_REAL = '{"error":{"status":402,"message":"Payment required to access this resource. Visit your billing tab.","code":"insufficient_quota"}}';

// Contexto de spawn tal como lo ve el pulpo cuando un agente CLI muere rápido.
const CTX_CLI_MUERTE = { provider: 'anthropic', transport: 'cli', exitCode: 1, durationMs: 3000 };

// ---------------------------------------------------------------------------
// El caso testigo
// ---------------------------------------------------------------------------

test('#6190 un 402 insufficient_quota por CLI se clasifica como cuota, no como transitorio', () => {
    const r = parser.parseProviderError(FRAME_402_REAL, CTX_CLI_MUERTE);

    assert.strictEqual(r.errorClass, 'quota_exhausted',
        'un 402 es evidencia DURA de cuota agotada; degradarlo a transient_5xx impide setear el flag');
    assert.strictEqual(r.retriable, false,
        'reintentar contra un provider sin crédito sólo quema reintentos del issue');
    assert.strictEqual(r.shouldFallback, true,
        'debe rotar de provider en vez de martillar el exhausto');
});

test('#6190 el log real del agente (con header del pipeline) también clasifica como cuota', () => {
    // El log arranca con el header que escribe el pulpo; el frame viene después.
    const logReal = [
        '--- architect:#6190 fase:aprobacion pipeline:desarrollo intento:1 2026-08-22T14:18:03.242Z ---',
        FRAME_402_REAL,
        '',
    ].join('\n');

    const r = parser.parseProviderError(logReal, CTX_CLI_MUERTE);
    assert.strictEqual(r.errorClass, 'quota_exhausted');
});

test('#6190 la clasificación no depende del provider en uso (402 es universal)', () => {
    // `status: 402` no es un marcador propietario: cualquier provider que lo
    // emita está diciendo lo mismo. No debe requerir allowlist por provider.
    for (const provider of ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim']) {
        const r = parser.parseProviderError(FRAME_402_REAL, { ...CTX_CLI_MUERTE, provider });
        assert.strictEqual(r.errorClass, 'quota_exhausted',
            `provider ${provider}: un 402 debe leerse como cuota agotada`);
    }
});

// ---------------------------------------------------------------------------
// Cobertura del resto de la matriz HTTP por frame estructurado en CLI
// ---------------------------------------------------------------------------

test('#6190 un frame estructurado 5xx sigue siendo transitorio', () => {
    const frame = '{"error":{"status":503,"message":"upstream unavailable"}}';
    const r = parser.parseProviderError(frame, CTX_CLI_MUERTE);

    assert.strictEqual(r.errorClass, 'transient_5xx',
        'un 5xx es infra transitoria: NO debe enmascararse como cuota (SR-4 #3077)');
});

test('#6190 un frame estructurado 401/403 se clasifica como auth, no como cuota', () => {
    for (const status of [401, 403]) {
        const frame = `{"error":{"status":${status},"message":"nope"}}`;
        const r = parser.parseProviderError(frame, CTX_CLI_MUERTE);
        assert.strictEqual(r.errorClass, 'auth',
            `status ${status}: credencial/permisos, no cuota — apagar el provider por cuota sería una misatribución`);
    }
});

test('#6190 un 429 con marcador de cuota en el body se lee como cuota agotada', () => {
    const frame = '{"error":{"status":429,"message":"insufficient_quota: monthly_limit reached"}}';
    const r = parser.parseProviderError(frame, CTX_CLI_MUERTE);
    assert.strictEqual(r.errorClass, 'quota_exhausted');
});

test('#6190 un 429 sin marcador de cuota sigue siendo rate limit', () => {
    const frame = '{"error":{"status":429,"message":"too many requests, slow down"}}';
    const r = parser.parseProviderError(frame, CTX_CLI_MUERTE);
    assert.strictEqual(r.errorClass, 'rate_limit',
        'rate limit es recuperable esperando; marcarlo como cuota apagaría el provider de más');
});

test('#6190 el marcador estructurado del propio provider gana sin necesidad de status', () => {
    // `insufficient_quota` está en el allowlist de openai-codex.
    const frame = '{"error":{"code":"insufficient_quota","message":"sin credito"}}';
    const r = parser.parseProviderError(frame, { ...CTX_CLI_MUERTE, provider: 'openai-codex' });
    assert.strictEqual(r.errorClass, 'quota_exhausted');
});

test('#6190 el allowlist NO cruza providers (CA-5 #3077)', () => {
    // `usage_limit_error` es marcador de anthropic. Con provider gemini-google y
    // SIN status numérico, no debe clasificarse como cuota por el marcador ajeno.
    const frame = '{"error":{"code":"usage_limit_error","message":"algo"}}';
    const r = parser.parseProviderError(frame, { ...CTX_CLI_MUERTE, provider: 'gemini-google' });
    assert.notStrictEqual(r.errorClass, 'quota_exhausted',
        'matchear un marcador de otro provider viola el scope por provider');
});

// ---------------------------------------------------------------------------
// Guardas de no-regresión: la red NUEVA no debe reabrir los falsos positivos
// que cerraron #4541 y #4865.
// ---------------------------------------------------------------------------

test('#6190 no reabre #4541: contenido del modelo que menciona cuota NO dispara cuota', () => {
    // Frame legítimo de stream-json cuyo CONTENIDO habla de cuota (p.ej. el
    // agente leyendo el propio issue del detector de cuota). No es un error.
    const frame = JSON.stringify({
        type: 'user',
        message: {
            role: 'user',
            content: [{
                type: 'tool_result',
                content: 'El detector debe reconocer insufficient_quota y usage limit reached en el body.',
            }],
        },
    });

    const r = parser.parseProviderError(frame, { ...CTX_CLI_MUERTE, exitCode: 0 });
    assert.notStrictEqual(r.errorClass, 'quota_exhausted',
        'substring sobre el content del modelo está PROHIBIDO (SR-1 / #4541)');
});

test('#6190 no reabre #4541: sólo se lee el objeto error top-level', () => {
    // El texto de cuota vive fuera de `error` → no debe influir.
    const frame = JSON.stringify({
        type: 'assistant',
        result: 'insufficient_quota insufficient_quota insufficient_quota',
    });

    const r = parser.parseProviderError(frame, { ...CTX_CLI_MUERTE, exitCode: 0 });
    assert.notStrictEqual(r.errorClass, 'quota_exhausted');
});

test('#6190 no reabre #4865: una línea truncada no parsea como JSON y no entra a la red', () => {
    // Frame gigante que el cap de línea corta: deja de ser JSON válido. La red
    // nueva sólo mira frames que parsean, así que no puede clasificarlo.
    const contenido = 'insufficient_quota '.repeat(3000);
    const frameGigante = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: contenido }] },
    });

    const r = parser.parseProviderError(frameGigante, { ...CTX_CLI_MUERTE, exitCode: 0 });
    assert.notStrictEqual(r.errorClass, 'quota_exhausted',
        'un tool_result truncado no es stderr del provider (#4865)');
});

// ---------------------------------------------------------------------------
// Robustez: la red nueva no puede tirar el parser (regla "el pipeline no muere")
// ---------------------------------------------------------------------------

test('#6190 inputs adversariales no rompen el parser', () => {
    const casos = [
        '{"error":null}',
        '{"error":"texto plano"}',
        '{"error":{}}',
        '{"error":{"status":"abc"}}',
        '{"error":{"status":99999}}',
        '{"error":{"status":-1}}',
        '{"error":{"status":402}}',
        '[]',
        'null',
        '{}',
        '',
        '{"data":{"error":{"status":402,"code":"insufficient_quota"}}}',
    ];

    for (const raw of casos) {
        assert.doesNotThrow(() => {
            const r = parser.parseProviderError(raw, CTX_CLI_MUERTE);
            assert.ok(typeof r.errorClass === 'string', `errorClass debe ser string para: ${raw}`);
        }, `no debe tirar con input: ${raw}`);
    }
});

test('#6190 el frame anidado en data.error también se rescata', () => {
    const frame = '{"data":{"error":{"status":402,"message":"no credit"}}}';
    const r = parser.parseProviderError(frame, CTX_CLI_MUERTE);
    assert.strictEqual(r.errorClass, 'quota_exhausted');
});

test('#6190 la evidencia no filtra el body completo ni secretos', () => {
    const frame = JSON.stringify({
        error: {
            status: 402,
            code: 'insufficient_quota',
            message: 'Payment required',
            api_key: 'sk-ant-api03-SECRETO-NO-DEBE-APARECER',
        },
    });

    const r = parser.parseProviderError(frame, CTX_CLI_MUERTE);
    assert.strictEqual(r.errorClass, 'quota_exhausted');
    assert.ok(!r.raw.includes('sk-ant-api03-SECRETO-NO-DEBE-APARECER'),
        'el campo raw pasa por saneo y no debe exponer la key');
});
