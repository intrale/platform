// =============================================================================
// multi-provider-secrets-rw.test.js — Tests del módulo secrets-rw (#3177 / #3313).
//
// Cubre tanto el formato canónico (credentials.json nested, #3311) como el
// fallback de lectura del legacy (telegram-config.json flat).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const secrets = require('../multi-provider/secrets-rw');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-secrets-test-'));
}

function writeCanonical(file, overrides = {}) {
    const data = {
        telegram: { bot_token: 'x', chat_id: 'y' },
        providers: {},
        multimedia: {},
        ...overrides,
    };
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
}

function writeLegacy(file, data) {
    fs.writeFileSync(file, JSON.stringify(data));
    return file;
}

test('maskValue oculta el medio de una key, dejando 6+****+4', () => {
    const m = secrets.maskValue('sk-ant-1234567890abcdefg');
    assert.equal(m.startsWith('sk-ant'), true);
    assert.ok(m.includes('****'));
    assert.equal(m.endsWith('defg'), true);
});

test('maskValue devuelve **** para strings cortos', () => {
    assert.equal(secrets.maskValue('short'), '****');
    assert.equal(secrets.maskValue(''), '****');
});

test('fingerprint es determinístico y truncado a 16 chars', () => {
    const a = secrets.fingerprint('hello-world-1234567890');
    const b = secrets.fingerprint('hello-world-1234567890');
    assert.equal(a, b);
    assert.equal(a.length, 16);
});

test('isPlaceholder detecta marcadores comunes', () => {
    assert.equal(secrets.isPlaceholder('REVOKED-do-not-use'), true);
    assert.equal(secrets.isPlaceholder('PLACEHOLDER'), true);
    assert.equal(secrets.isPlaceholder('CHANGE_ME-soon'), true);
    assert.equal(secrets.isPlaceholder('sk-ant-xxxxxxxxxxxx'), false);
    assert.equal(secrets.isPlaceholder(''), true);
    assert.equal(secrets.isPlaceholder(null), true);
});

test('detectFormat distingue canonical de legacy', () => {
    assert.equal(secrets.detectFormat({ providers: {} }), 'canonical');
    assert.equal(secrets.detectFormat({ multimedia: {} }), 'canonical');
    assert.equal(secrets.detectFormat({ telegram: {} }), 'canonical');
    assert.equal(secrets.detectFormat({ openai_api_key: 'sk-xxx' }), 'legacy');
    assert.equal(secrets.detectFormat({ groq_api_key: 'gsk_xxx' }), 'legacy');
    assert.equal(secrets.detectFormat({}), 'canonical');
});

test('setNested crea estructura intermedia y asigna el valor', () => {
    const obj = {};
    secrets.setNested(obj, 'providers.groq.api_key', 'gsk_real');
    assert.deepEqual(obj, { providers: { groq: { api_key: 'gsk_real' } } });

    secrets.setNested(obj, 'providers.openai.api_key', 'sk-real');
    assert.equal(obj.providers.openai.api_key, 'sk-real');
    assert.equal(obj.providers.groq.api_key, 'gsk_real', 'no debe pisar siblings');
});

test('listKeys lee del formato CANONICAL nested', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify({
        providers: {
            openai:   { api_key: 'sk-actual-key-1234567890abcdef' },
            anthropic: { api_key: 'PLACEHOLDER' },
            groq:     { api_key: 'gsk_real_key_1234567890abcdef' },
            google:   { api_key: 'AIza_real_key_1234567890abc' },
            cerebras: { api_key: 'csk_real_key_1234567890abcdef' },
        },
        multimedia: { elevenlabs_api_key: '' },
    }));
    const out = secrets.listKeys({ secretsPath: file });
    const byProvider = Object.fromEntries(out.map(k => [k.provider, k]));

    assert.equal(byProvider.openai.status, 'present');
    assert.ok(byProvider.openai.masked.startsWith('sk-act'));
    assert.equal(byProvider.openai.masked.endsWith('cdef'), true);
    assert.equal(byProvider.openai.editable, true);

    assert.equal(byProvider.anthropic.status, 'placeholder');
    assert.equal(byProvider.anthropic.editable, false);

    assert.equal(byProvider.elevenlabs.status, 'absent');
    assert.equal(byProvider.elevenlabs.masked, null);

    // Los 3 free providers DEBEN aparecer como present con la estructura nested
    // — éste es exactamente el caso que rompía el dashboard antes de #3313.
    assert.equal(byProvider.groq.status, 'present');
    assert.equal(byProvider['gemini-google'].status, 'present');
    assert.equal(byProvider.cerebras.status, 'present');
});

test('listKeys lee del formato LEGACY flat (fallback)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'telegram-config.json');
    fs.writeFileSync(file, JSON.stringify({
        openai_api_key: 'sk-legacy-1234567890abcdef',
        anthropic_api_key: 'PLACEHOLDER',
        elevenlabs_api_key: '',
        groq_api_key: 'gsk_legacy_1234567890abcdef',
    }));
    const out = secrets.listKeys({ secretsPath: file });
    const byProvider = Object.fromEntries(out.map(k => [k.provider, k]));

    assert.equal(byProvider.openai.status, 'present');
    assert.equal(byProvider.anthropic.status, 'placeholder');
    assert.equal(byProvider.elevenlabs.status, 'absent');
    assert.equal(byProvider.groq.status, 'present');
    // El legacy no incluye cerebras ni gemini-google → absent.
    assert.equal(byProvider.cerebras.status, 'absent');
    assert.equal(byProvider['gemini-google'].status, 'absent');
});

test('rotateKey rechaza provider no gestionado', () => {
    const dir = tmpDir();
    const file = writeCanonical(path.join(dir, 'credentials.json'));
    assert.throws(
        () => secrets.rotateKey({ provider: 'unknown-provider', newValue: 'x'.repeat(40), secretsPath: file, backupDir: path.join(dir, 'bak') }),
        /no está gestionado/
    );
});

test('rotateKey rechaza Anthropic (no editable)', () => {
    const dir = tmpDir();
    const file = writeCanonical(path.join(dir, 'credentials.json'), {
        providers: { anthropic: { api_key: 'sk-ant-xxxxxxxxxxxx' } },
    });
    assert.throws(
        () => secrets.rotateKey({ provider: 'anthropic', newValue: 'sk-ant-new'.padEnd(40, 'x'), secretsPath: file, backupDir: path.join(dir, 'bak') }),
        /no es editable/
    );
});

test('rotateKey rechaza newValue vacío, corto, placeholder o con control chars', () => {
    const dir = tmpDir();
    const file = writeCanonical(path.join(dir, 'credentials.json'));
    const common = { provider: 'openai', secretsPath: file, backupDir: path.join(dir, 'bak') };
    assert.throws(() => secrets.rotateKey({ ...common, newValue: '' }), /newValue.*requerido/);
    assert.throws(() => secrets.rotateKey({ ...common, newValue: 'short' }), /demasiado corto/);
    assert.throws(() => secrets.rotateKey({ ...common, newValue: 'EXAMPLE-this-is-fake-key-12345' }), /placeholder/);
    assert.throws(() => secrets.rotateKey({ ...common, newValue: 'sk-with-newline\nbad-aaaaaaaaaa' }), /control/);
});

test('rotateKey escribe atómicamente sobre formato CANONICAL preservando estructura nested', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'bak');
    fs.writeFileSync(file, JSON.stringify({
        telegram: { bot_token: 'preserved' },
        providers: { openai: { api_key: 'sk-old-12345678901234567890' } },
        multimedia: { elevenlabs_voice_id: 'preserved-voice' },
    }));
    const result = secrets.rotateKey({
        provider: 'openai',
        newValue: 'sk-new-aaaaaaaaaaaaaaaaaaaa',
        secretsPath: file,
        backupDir: bakDir,
        now: 1000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openai');
    assert.equal(result.format, 'canonical');
    assert.equal(result.canonicalPath, 'providers.openai.api_key');
    assert.ok(result.fingerprint);
    assert.ok(result.backupPath);
    assert.ok(fs.existsSync(result.backupPath));

    const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(updated.providers.openai.api_key, 'sk-new-aaaaaaaaaaaaaaaaaaaa');
    assert.equal(updated.telegram.bot_token, 'preserved', 'top-level no tocado debe preservarse');
    assert.equal(updated.multimedia.elevenlabs_voice_id, 'preserved-voice', 'siblings preservados');
});

test('rotateKey crea archivo CANONICAL si no existe (estructura nested)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'bak');
    const result = secrets.rotateKey({
        provider: 'groq',
        newValue: 'gsk_fresh_aaaaaaaaaaaaaaaaaaaa',
        secretsPath: file,
        backupDir: bakDir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.format, 'canonical');
    assert.equal(result.canonicalPath, 'providers.groq.api_key');
    const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(updated.providers.groq.api_key, 'gsk_fresh_aaaaaaaaaaaaaaaaaaaa');
});

test('rotateKey sobre archivo LEGACY preserva formato flat (compat hacia atrás)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'telegram-config.json');
    const bakDir = path.join(dir, 'bak');
    fs.writeFileSync(file, JSON.stringify({
        openai_api_key: 'sk-old-12345678901234567890',
        groq_api_key: 'gsk_old_aaaaaaaaaaaaaaaaaaaaa',
    }));
    const result = secrets.rotateKey({
        provider: 'groq',
        newValue: 'gsk_new_bbbbbbbbbbbbbbbbbbbbb',
        secretsPath: file,
        backupDir: bakDir,
    });
    assert.equal(result.format, 'legacy');
    const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(updated.groq_api_key, 'gsk_new_bbbbbbbbbbbbbbbbbbbbb');
    assert.equal(updated.openai_api_key, 'sk-old-12345678901234567890', 'flat siblings preservados');
});

test('rotateKey respeta la retention policy en backups (canonical)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'bak');
    fs.writeFileSync(file, JSON.stringify({
        providers: { openai: { api_key: 'sk-init-1234567890abcdef0000' } },
    }));
    for (let i = 0; i < 5; i++) {
        secrets.rotateKey({
            provider: 'openai',
            newValue: 'sk-rot-' + String(i).padEnd(30, 'x'),
            secretsPath: file,
            backupDir: bakDir,
            retention: 2,
            now: 1000 + i,
        });
    }
    const backups = fs.readdirSync(bakDir).filter(f => f.startsWith('credentials.'));
    assert.equal(backups.length, 2, 'retention=2 mantiene solo 2 backups del archivo canonical');
});

test('getRawKey lee la key real del CANONICAL nested', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify({
        providers: {
            openai:   { api_key: 'sk-real-1234567890abcdef0000' },
            google:   { api_key: 'AIza-real-1234567890abcdef' },
            cerebras: { api_key: 'csk-real-1234567890abcdef' },
        },
        multimedia: { elevenlabs_api_key: 'PLACEHOLDER' },
    }));
    assert.equal(secrets.getRawKey({ provider: 'openai', secretsPath: file }), 'sk-real-1234567890abcdef0000');
    // 'gemini-google' (UI) mapea a 'providers.google.api_key' en canonical.
    assert.equal(secrets.getRawKey({ provider: 'gemini-google', secretsPath: file }), 'AIza-real-1234567890abcdef');
    assert.equal(secrets.getRawKey({ provider: 'cerebras', secretsPath: file }), 'csk-real-1234567890abcdef');
    assert.equal(secrets.getRawKey({ provider: 'elevenlabs', secretsPath: file }), null, 'PLACEHOLDER → null');
    assert.equal(secrets.getRawKey({ provider: 'anthropic', secretsPath: file }), null, 'absent → null');
});

test('getRawKey lee del LEGACY flat cuando el canonical no existe', () => {
    const dir = tmpDir();
    const legacyFile = path.join(dir, 'telegram-config.json');
    fs.writeFileSync(legacyFile, JSON.stringify({
        openai_api_key: 'sk-legacy-1234567890abcdef',
        groq_api_key: 'gsk_legacy_1234567890abcdef',
    }));
    assert.equal(secrets.getRawKey({ provider: 'openai', secretsPath: legacyFile }), 'sk-legacy-1234567890abcdef');
    assert.equal(secrets.getRawKey({ provider: 'groq', secretsPath: legacyFile }), 'gsk_legacy_1234567890abcdef');
});

// ─── Free providers (#3260 + #3313) ─────────────────────────────────────────

test('MANAGED_KEYS incluye los 3 free providers de #3260 con canonicalPath', () => {
    const providers = secrets.MANAGED_KEYS.map(k => k.provider);
    assert.ok(providers.includes('groq'), 'groq presente');
    assert.ok(providers.includes('gemini-google'), 'gemini-google presente');
    assert.ok(providers.includes('cerebras'), 'cerebras presente');

    const byP = Object.fromEntries(secrets.MANAGED_KEYS.map(k => [k.provider, k]));
    assert.equal(byP.groq.canonicalPath, 'providers.groq.api_key');
    assert.equal(byP['gemini-google'].canonicalPath, 'providers.google.api_key');
    assert.equal(byP.cerebras.canonicalPath, 'providers.cerebras.api_key');
});

test('free providers son editable=true (rotables vía UI)', () => {
    for (const p of ['groq', 'gemini-google', 'cerebras']) {
        const spec = secrets.MANAGED_KEYS.find(k => k.provider === p);
        assert.equal(spec.editable, true, `${p} debe ser editable`);
        assert.ok(spec.free_tier_notes, `${p} debe tener free_tier_notes`);
    }
});

test('rotateKey de free provider sobre CANONICAL crea backup + write atómico 0600 (SR-1)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'bak');
    fs.writeFileSync(file, JSON.stringify({
        providers: { groq: { api_key: 'gsk_old_aaaaaaaaaaaaaaaaaaaaa' } },
    }));
    const result = secrets.rotateKey({
        provider: 'groq',
        newValue: 'gsk_new_bbbbbbbbbbbbbbbbbbbbb',
        secretsPath: file,
        backupDir: bakDir,
        retention: 5,
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'groq');
    assert.equal(result.format, 'canonical');
    assert.ok(result.fingerprint, 'fingerprint generado');
    assert.equal(result.fingerprint.length, 16);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.providers.groq.api_key, 'gsk_new_bbbbbbbbbbbbbbbbbbbbb');
    const backups = fs.readdirSync(bakDir).filter(f => f.startsWith('credentials.'));
    assert.equal(backups.length, 1);
});

test('listKeys de free provider incluye free_tier_notes en metadata', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify({
        providers: { groq: { api_key: 'gsk_aaaaaaaaaaaaaaaaaaaaaa' } },
    }));
    const out = secrets.listKeys({ secretsPath: file });
    const groq = out.find(k => k.provider === 'groq');
    assert.equal(groq.status, 'present');
    assert.ok(groq.free_tier_notes, 'free_tier_notes debe estar en la metadata listKeys');
});
