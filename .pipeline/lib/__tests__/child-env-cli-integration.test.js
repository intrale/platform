// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// #7634 · C6 — integración REAL: con el env de un rol SIN scopes (camino ON),
// `aws sts get-caller-identity`, `gh auth status` y `gh api user` fallan.
//
// Seguridad (S8 / riesgo de la receta): corre contra la cuenta real del
// operador. El test afirma SÓLO `status !== 0` y NUNCA imprime stdout/stderr
// del CLI (si el neutralizador fallara, esa salida sería la identidad). Se usa
// `spawnSync` sin shell y sin valores en argv. Si falta un CLI, el skip se
// imprime en una línea visible, no es un `return` mudo.

const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

const lib = require('../build-child-env');
const cs = require('../credential-sentinel');

const ES_WIN = process.platform === 'win32';

/** Busca un ejecutable en PATH (y en ubicaciones conocidas del host). Sin shell. */
function encontrarBinario(nombre, extrasConocidos = []) {
    const exts = ES_WIN ? ['.exe'] : [''];
    const pathVar = (lib.lookupEnvCI(process.env, 'PATH') || {}).value || '';
    const dirs = pathVar.split(path.delimiter).filter(Boolean);
    for (const d of dirs) {
        for (const ext of exts) {
            const p = path.join(d, nombre + ext);
            try { if (fs.statSync(p).isFile()) return p; } catch { /* sigue */ }
        }
    }
    for (const p of extrasConocidos) {
        try { if (fs.statSync(p).isFile()) return p; } catch { /* sigue */ }
    }
    return null;
}

function envDeRolSinScopes() {
    // Rol determinístico sin scopes en una fase sin techo de credenciales.
    return lib.buildChildEnv({
        skill: 'linter',
        fase: 'linteo',
        warn: () => {},
        processEnv: { ...process.env },
        skillConfigOverride: { skill: { provider: 'deterministic', requires_credentials: [] }, providers: {} },
    });
}

/** Corre el CLI y devuelve SÓLO el status. La salida se descarta sin leerse. */
function correr(bin, args, env) {
    const r = spawnSync(bin, args, { env, shell: false, timeout: 20000, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    return { status: r.status, error: r.error ? r.error.code || 'error' : null };
}

function skip(t, cli) {
    const linea = `SKIP integración ${cli}: CLI no encontrado en PATH`;
    console.log(linea);
    t.skip(linea);
}

test('C6 · el env de un rol sin scopes está neutralizado (precondición de la integración)', () => {
    const env = envDeRolSinScopes();
    assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, cs.SENTINEL_AWS);
    assert.equal(env.AWS_CONFIG_FILE, cs.SENTINEL_AWS);
    assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true');
    assert.equal(env.GH_CONFIG_DIR, cs.SENTINEL_GH_CONFIG);
    for (const k of Object.keys(env)) {
        assert.ok(!['GH_TOKEN', 'GITHUB_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_PROFILE'].includes(k.toUpperCase()), k);
    }
});

test('C6 · aws sts get-caller-identity falla con el env de un rol sin scope aws', (t) => {
    const aws = encontrarBinario('aws', ES_WIN ? ['C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe'] : []);
    if (!aws) return skip(t, 'aws');
    const r = correr(aws, ['sts', 'get-caller-identity', '--region', 'us-east-1'], envDeRolSinScopes());
    assert.equal(r.error, null, `el CLI no pudo ejecutarse (${r.error})`);
    assert.notEqual(r.status, 0, `aws resolvió una identidad con el env neutralizado (status=${r.status})`);
});

test('C6 · gh auth status falla con el env de un rol sin scope github', (t) => {
    const gh = encontrarBinario('gh', ES_WIN ? ['C:\\Workspaces\\gh-cli\\bin\\gh.exe'] : []);
    if (!gh) return skip(t, 'gh');
    const r = correr(gh, ['auth', 'status'], envDeRolSinScopes());
    assert.equal(r.error, null, `el CLI no pudo ejecutarse (${r.error})`);
    assert.notEqual(r.status, 0, `gh quedó autenticado con el env neutralizado (status=${r.status})`);
});

test('C6 · gh api user falla con el env de un rol sin scope github (camino del keyring)', (t) => {
    const gh = encontrarBinario('gh', ES_WIN ? ['C:\\Workspaces\\gh-cli\\bin\\gh.exe'] : []);
    if (!gh) return skip(t, 'gh');
    const r = correr(gh, ['api', 'user'], envDeRolSinScopes());
    assert.equal(r.error, null, `el CLI no pudo ejecutarse (${r.error})`);
    assert.notEqual(r.status, 0, `gh api user resolvió un token con el env neutralizado (status=${r.status})`);
});
