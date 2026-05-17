// =============================================================================
// multi-provider-secrets-rw.test.js — Tests del módulo secrets-rw (#3177).
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

test('listKeys devuelve metadata correcta sin la key cruda', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({
        openai_api_key: 'sk-actual-key-1234567890abcdef',
        anthropic_api_key: 'PLACEHOLDER',
        elevenlabs_api_key: '',
    }));
    const out = secrets.listKeys({ secretsPath: file });
    const byProvider = Object.fromEntries(out.map(k => [k.provider, k]));

    assert.equal(byProvider.openai.status, 'present');
    assert.ok(byProvider.openai.masked.startsWith('sk-act'));
    assert.equal(byProvider.openai.masked.endsWith('cdef'), true);
    assert.ok(!String(byProvider.openai.masked).includes('actual-key-1234567890'));
    assert.equal(byProvider.openai.editable, true);

    assert.equal(byProvider.anthropic.status, 'placeholder');
    assert.equal(byProvider.anthropic.editable, false);
    assert.ok(byProvider.anthropic.reason);

    assert.equal(byProvider.elevenlabs.status, 'absent');
    assert.equal(byProvider.elevenlabs.masked, null);
});

test('rotateKey rechaza provider no gestionado', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({}));
    assert.throws(
        () => secrets.rotateKey({ provider: 'unknown-provider', newValue: 'x'.repeat(40), secretsPath: file, backupDir: path.join(dir, 'bak') }),
        /no está gestionado/
    );
});

test('rotateKey rechaza Anthropic (no editable)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ anthropic_api_key: 'sk-ant-xxxxxxxxxxxx' }));
    assert.throws(
        () => secrets.rotateKey({ provider: 'anthropic', newValue: 'sk-ant-new'.padEnd(40, 'x'), secretsPath: file, backupDir: path.join(dir, 'bak') }),
        /no es editable/
    );
});

test('rotateKey rechaza newValue vacío, corto, placeholder o con control chars', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({}));
    const common = { provider: 'openai', secretsPath: file, backupDir: path.join(dir, 'bak') };
    assert.throws(() => secrets.rotateKey({ ...common, newValue: '' }), /newValue.*requerido/);
    assert.throws(() => secrets.rotateKey({ ...common, newValue: 'short' }), /demasiado corto/);
    assert.throws(() => secrets.rotateKey({ ...common, newValue: 'EXAMPLE-this-is-fake-key-12345' }), /placeholder/);
    assert.throws(() => secrets.rotateKey({ ...common, newValue: 'sk-with-newline\nbad-aaaaaaaaaa' }), /control/);
});

test('rotateKey escribe atómicamente y crea backup pre-save', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'config.json');
    const bakDir = path.join(dir, 'bak');
    fs.writeFileSync(file, JSON.stringify({ openai_api_key: 'sk-old-12345678901234567890', other: 'preserved' }));
    const result = secrets.rotateKey({
        provider: 'openai',
        newValue: 'sk-new-aaaaaaaaaaaaaaaaaaaa',
        secretsPath: file,
        backupDir: bakDir,
        now: 1000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openai');
    assert.ok(result.fingerprint);
    assert.ok(result.backupPath);
    assert.ok(fs.existsSync(result.backupPath));

    const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(updated.openai_api_key, 'sk-new-aaaaaaaaaaaaaaaaaaaa');
    assert.equal(updated.other, 'preserved', 'campos no tocados deben preservarse');
});

test('rotateKey respeta la retention policy en backups', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'config.json');
    const bakDir = path.join(dir, 'bak');
    fs.writeFileSync(file, JSON.stringify({ openai_api_key: 'sk-init-1234567890abcdef0000' }));
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
    const files = fs.readdirSync(bakDir);
    assert.equal(files.length, 2, 'retention=2 mantiene solo 2 backups');
});

test('getRawKey devuelve la key real o null si ausente/placeholder', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({
        openai_api_key: 'sk-real-1234567890abcdef0000',
        elevenlabs_api_key: 'PLACEHOLDER',
    }));
    assert.equal(secrets.getRawKey({ provider: 'openai', secretsPath: file }), 'sk-real-1234567890abcdef0000');
    assert.equal(secrets.getRawKey({ provider: 'elevenlabs', secretsPath: file }), null);
    assert.equal(secrets.getRawKey({ provider: 'anthropic', secretsPath: file }), null);
});

// ─── Free providers (#3260) ─────────────────────────────────────────────────

test('MANAGED_KEYS incluye los 3 free providers de #3260', () => {
    const providers = secrets.MANAGED_KEYS.map(k => k.provider);
    assert.ok(providers.includes('groq'), 'groq presente');
    assert.ok(providers.includes('gemini-google'), 'gemini-google presente');
    assert.ok(providers.includes('cerebras'), 'cerebras presente');
});

test('free providers son editable=true (rotables vía UI)', () => {
    for (const p of ['groq', 'gemini-google', 'cerebras']) {
        const spec = secrets.MANAGED_KEYS.find(k => k.provider === p);
        assert.equal(spec.editable, true, `${p} debe ser editable`);
        assert.ok(spec.free_tier_notes, `${p} debe tener free_tier_notes`);
    }
});

test('rotateKey de free provider crea backup + write atómico 0600 (SR-1)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'config.json');
    const bakDir = path.join(dir, 'bak');
    fs.writeFileSync(file, JSON.stringify({ groq_api_key: 'gsk_old_aaaaaaaaaaaaaaaaaaaaa' }));
    const result = secrets.rotateKey({
        provider: 'groq',
        newValue: 'gsk_new_bbbbbbbbbbbbbbbbbbbbb',
        secretsPath: file,
        backupDir: bakDir,
        retention: 5,
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'groq');
    assert.ok(result.fingerprint, 'fingerprint generado');
    assert.equal(result.fingerprint.length, 16);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.groq_api_key, 'gsk_new_bbbbbbbbbbbbbbbbbbbbb');
    // Backup existe
    const backups = fs.readdirSync(bakDir);
    assert.equal(backups.length, 1);
});

test('listKeys de free provider incluye free_tier_notes en metadata', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ groq_api_key: 'gsk_aaaaaaaaaaaaaaaaaaaaaa' }));
    const out = secrets.listKeys({ secretsPath: file });
    const groq = out.find(k => k.provider === 'groq');
    assert.equal(groq.status, 'present');
    assert.ok(groq.free_tier_notes, 'free_tier_notes debe estar en la metadata listKeys');
});
