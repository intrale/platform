// =============================================================================
// Tests hidratacion de credenciales de Google Drive — Issue #5172
//
// Antes de #5172 el ENV_MAPPING no tenia entradas `google_drive.*`: las
// credenciales de Drive vivian SOLO en `.claude/hooks/telegram-config.json`,
// archivo tracked por git cuya copia commiteada no las contiene. Cada respawn
// con `reset --hard` las borraba y `qa-video-share` fallaba con
// "Google Drive no configurado", perdiendo la evidencia de QA.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const credentials = require('../credentials');

const FAKE_CLIENT_ID = '111111111111-fake.apps.googleusercontent.com';
const FAKE_SECRET = 'GOCSPX-fakeSecretForUnitTests0123';
const FAKE_REFRESH = '1//0eFakeRefreshTokenForUnitTests-ABCDEFGHIJ';
const FAKE_FOLDER = '1FakeFolderIdForUnitTests000000000';

let tmpDir = '';
let canonicalPath = '';
let legacyPath = '';

test.before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-5172-'));
    canonicalPath = path.join(tmpDir, 'credentials.json');
    legacyPath = path.join(tmpDir, 'no-existe-legacy.json');
    fs.writeFileSync(canonicalPath, JSON.stringify({
        google_drive: {
            oauth_client_id: FAKE_CLIENT_ID,
            oauth_client_secret: FAKE_SECRET,
            oauth_refresh_token: FAKE_REFRESH,
            drive_folder_id: FAKE_FOLDER,
        },
    }), 'utf8');
});

test.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

function hydrate(env = {}) {
    const result = credentials.loadIntoEnv({
        env, canonicalPath, legacyPath, logger: () => {},
    });
    return { env, result };
}

test('las cuatro claves de google_drive se hidratan desde el store canonico', () => {
    const { env, result } = hydrate();
    assert.equal(result.source, 'canonical');
    assert.equal(env.GOOGLE_OAUTH_CLIENT_ID, FAKE_CLIENT_ID);
    assert.equal(env.GOOGLE_OAUTH_CLIENT_SECRET, FAKE_SECRET);
    assert.equal(env.GOOGLE_OAUTH_REFRESH_TOKEN, FAKE_REFRESH);
    assert.equal(env.GOOGLE_DRIVE_FOLDER_ID, FAKE_FOLDER);
});

test('las cuatro vars quedan registradas como hidratadas', () => {
    const { result } = hydrate();
    for (const v of [
        'GOOGLE_OAUTH_CLIENT_ID',
        'GOOGLE_OAUTH_CLIENT_SECRET',
        'GOOGLE_OAUTH_REFRESH_TOKEN',
        'GOOGLE_DRIVE_FOLDER_ID',
    ]) {
        assert.ok(result.hydrated.includes(v), v + ' deberia estar en hydrated');
    }
});

test('un valor ya presente en env no se sobrescribe', () => {
    const { env, result } = hydrate({ GOOGLE_OAUTH_REFRESH_TOKEN: 'override-operativo' });
    assert.equal(env.GOOGLE_OAUTH_REFRESH_TOKEN, 'override-operativo');
    assert.ok(result.skipped_existing.includes('GOOGLE_OAUTH_REFRESH_TOKEN'));
});

test('el reporte de hidratacion lista NOMBRES de var, nunca valores', () => {
    const { result } = hydrate();
    const serializado = JSON.stringify(result);
    for (const secreto of [FAKE_SECRET, FAKE_REFRESH, FAKE_CLIENT_ID]) {
        assert.equal(serializado.includes(secreto), false,
            'el resultado de loadIntoEnv no debe contener ' + secreto);
    }
});

test('un store sin seccion google_drive no rompe ni inventa valores', () => {
    const sinDrive = path.join(tmpDir, 'sin-drive.json');
    fs.writeFileSync(sinDrive, JSON.stringify({ telegram: { bot_token: 'x' } }), 'utf8');
    const env = {};
    const result = credentials.loadIntoEnv({
        env, canonicalPath: sinDrive, legacyPath, logger: () => {},
    });
    assert.equal(env.GOOGLE_OAUTH_REFRESH_TOKEN, undefined);
    assert.ok(result.skipped_empty.includes('GOOGLE_OAUTH_REFRESH_TOKEN'));
});
