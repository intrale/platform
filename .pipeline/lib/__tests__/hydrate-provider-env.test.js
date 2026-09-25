// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { hydrateProviderEnv, ENV_MAPPING } = require('../hydrate-provider-env');

// #7113 — los tests corren bajo NODE_TEST_CONTEXT (⇒ `pruebas`), donde la
// hidratación se OMITE por diseño. Estos casos ejercitan el camino productivo
// con un loader fake, así que le pasan el perfil productivo explícito.
const AMBIENTE_PRODUCTIVO = Object.freeze({ modo: 'productivo' });

// Loader factory: replica el contrato de loadApiKeys (precedencia env > JSON,
// ignora placeholders). En los tests reemplaza loadApiKeys real para que NO
// dependan del ~/.claude/secrets/telegram-config.json del usuario corriendo CI.
function fakeLoaderFor(jsonBody) {
    return () => ({
        openai_api_key: pick(process.env.OPENAI_API_KEY) || pick(jsonBody.openai_api_key),
        anthropic_api_key: pick(process.env.ANTHROPIC_API_KEY) || pick(jsonBody.anthropic_api_key),
    });
}

function pick(v) {
    if (typeof v !== 'string' || !v.trim()) return '';
    if (/(REVOKED|PLACEHOLDER|MOVED|EXAMPLE|REPLACE|CHANGE_ME)/i.test(v)) return '';
    return v;
}

const ALL_VARS = Object.values(ENV_MAPPING);

function withCleanEnv(fn) {
    const snapshot = {};
    for (const v of ALL_VARS) {
        snapshot[v] = process.env[v];
        delete process.env[v];
    }
    try { return fn(); }
    finally {
        for (const v of ALL_VARS) {
            if (snapshot[v] === undefined) delete process.env[v];
            else process.env[v] = snapshot[v];
        }
    }
}

test('hidrata OPENAI_API_KEY desde el JSON cuando no estaba en env', () => {
    withCleanEnv(() => {
        const result = hydrateProviderEnv({ ambiente: AMBIENTE_PRODUCTIVO,
            loadKeysFn: fakeLoaderFor({ openai_api_key: 'sk-proj-test-123' }),
        });
        assert.equal(process.env.OPENAI_API_KEY, 'sk-proj-test-123');
        assert.deepEqual(result.hydrated, ['OPENAI_API_KEY']);
    });
});

test('no sobreescribe si la env var ya estaba seteada', () => {
    withCleanEnv(() => {
        process.env.OPENAI_API_KEY = 'sk-existing';
        const result = hydrateProviderEnv({ ambiente: AMBIENTE_PRODUCTIVO,
            loadKeysFn: fakeLoaderFor({ openai_api_key: 'sk-proj-test-overwrite' }),
        });
        assert.equal(process.env.OPENAI_API_KEY, 'sk-existing');
        assert.deepEqual(result.alreadySet, ['OPENAI_API_KEY']);
        assert.equal(result.hydrated.length, 0);
    });
});

test('reporta como missing cuando ni env ni JSON traen la key', () => {
    withCleanEnv(() => {
        const result = hydrateProviderEnv({ ambiente: AMBIENTE_PRODUCTIVO, loadKeysFn: fakeLoaderFor({}) });
        assert.ok(result.missing.includes('OPENAI_API_KEY'));
        assert.equal(process.env.OPENAI_API_KEY, undefined);
    });
});

test('es idempotente — segunda llamada no rehidrata ni rompe', () => {
    withCleanEnv(() => {
        const loader = fakeLoaderFor({ openai_api_key: 'sk-idempotent' });
        const r1 = hydrateProviderEnv({ ambiente: AMBIENTE_PRODUCTIVO, loadKeysFn: loader });
        const r2 = hydrateProviderEnv({ ambiente: AMBIENTE_PRODUCTIVO, loadKeysFn: loader });
        assert.deepEqual(r1.hydrated, ['OPENAI_API_KEY']);
        assert.deepEqual(r2.hydrated, []);
        assert.deepEqual(r2.alreadySet, ['OPENAI_API_KEY']);
        assert.equal(process.env.OPENAI_API_KEY, 'sk-idempotent');
    });
});

test('placeholders del JSON se ignoran (no se hidrata con valor sucio)', () => {
    withCleanEnv(() => {
        const result = hydrateProviderEnv({ ambiente: AMBIENTE_PRODUCTIVO,
            loadKeysFn: fakeLoaderFor({ openai_api_key: 'REVOKED_PLACEHOLDER' }),
        });
        assert.ok(result.missing.includes('OPENAI_API_KEY'));
        assert.equal(process.env.OPENAI_API_KEY, undefined);
    });
});

test('logger recibe líneas legibles para auditoría', () => {
    withCleanEnv(() => {
        const lines = [];
        hydrateProviderEnv({ ambiente: AMBIENTE_PRODUCTIVO,
            loadKeysFn: fakeLoaderFor({ openai_api_key: 'sk-log-check' }),
            log: (m) => lines.push(m),
        });
        assert.ok(lines.some((l) => /hidratadas desde JSON.*OPENAI_API_KEY/.test(l)));
    });
});

test('no loguea el valor crudo de la key (sólo el nombre del env var)', () => {
    withCleanEnv(() => {
        const lines = [];
        const secret = 'sk-proj-SHOULDNOTLEAK-abcdef123';
        hydrateProviderEnv({ ambiente: AMBIENTE_PRODUCTIVO,
            loadKeysFn: fakeLoaderFor({ openai_api_key: secret }),
            log: (m) => lines.push(m),
        });
        for (const line of lines) {
            assert.equal(line.includes(secret), false, `Línea filtra el secret: ${line}`);
        }
    });
});

test('#7113 · en modo distinto de productivo NO se llama al loader y process.env queda intacto (omitido: pruebas)', () => {
    withCleanEnv(() => {
        let llamadas = 0;
        const lines = [];
        const result = hydrateProviderEnv({
            ambiente: { modo: 'pruebas' },
            loadKeysFn: () => { llamadas += 1; return { openai_api_key: 'sk-proj-no-debe-usarse' }; },
            log: (m) => lines.push(m),
        });
        assert.equal(llamadas, 0, 'el loader productivo no se invoca en pruebas');
        assert.equal(process.env.OPENAI_API_KEY, undefined);
        assert.deepEqual(result, { hydrated: [], alreadySet: [], missing: [], omitido: 'pruebas' });
        assert.ok(lines.some((l) => /omitida.*modo=pruebas/.test(l)), 'el boot narra la omisión');
    });
});

test('#7113 · sin ambiente explícito resuelve por pipeline-env sobre el env recibido (corrida de test ⇒ pruebas)', () => {
    withCleanEnv(() => {
        let llamadas = 0;
        const result = hydrateProviderEnv({
            env: { NODE_TEST_CONTEXT: '1' },
            loadKeysFn: () => { llamadas += 1; return {}; },
        });
        assert.equal(llamadas, 0);
        assert.equal(result.omitido, 'pruebas');
    });
});
