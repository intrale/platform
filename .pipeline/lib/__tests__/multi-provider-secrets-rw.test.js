// =============================================================================
// multi-provider-secrets-rw.test.js — Tests del módulo secrets-rw.
//
// Cobertura post-#3313:
//   - Lectura canonical (credentials.json, dot-path) + fallback legacy con WARN
//   - rotateKey SIEMPRE escribe al canonical (jamás al legacy)
//   - Backup naming alineado al canonical (credentials.<ts>.json)
//   - applyBackupRetention filtra por el nuevo prefijo
//   - Defensas vigentes sin regresión (placeholder, len ≥ 20, control chars,
//     masking 6+****+4, fingerprint truncado, atomic write 0600)
//   - Retro-compat del shape de respuesta API (jsonField presente)
//   - Paridad MANAGED_KEYS.dotPath ⊆ credentials.js:ENV_MAPPING
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const secrets = require('../multi-provider/secrets-rw');
const credentials = require('../credentials');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-secrets-test-'));
}

function writeCanonical(file, tree) {
    fs.writeFileSync(file, JSON.stringify(tree, null, 2));
}

// Captura WARN del logger inyectado para verificar fallback messages.
function collectWarnings() {
    const msgs = [];
    return { logger: (m) => msgs.push(String(m)), msgs };
}

// ─── Defensas básicas (sin regresión) ──────────────────────────────────────

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

// ─── CA-1: lectura canonical con fallback legacy + WARN ────────────────────

test('listKeys lee del canonical (credentials.json) cuando existe', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    const legacy = path.join(dir, 'telegram-config.json');
    writeCanonical(canonical, {
        providers: {
            openai: { api_key: 'sk-canonical-12345678901234567890' },
            groq: { api_key: 'gsk_canonical-12345678901234567890' },
            google: { api_key: 'AIza-canonical-1234567890abcdef0000' },
            cerebras: { api_key: 'csk-canonical-12345678901234567890' },
            nvidia: { api_key: 'nvapi-canonical-1234567890abcdef000' },
        },
        multimedia: {
            elevenlabs_api_key: '11labs-canonical-12345678901234567890',
        },
    });
    // legacy con valores distintos — NO deben ganarle al canonical.
    fs.writeFileSync(legacy, JSON.stringify({
        openai_api_key: 'sk-LEGACY-DRIFT-1234567890aaaa',
        groq_api_key: 'gsk_LEGACY-DRIFT-1234567890aaaa',
    }));

    const out = secrets.listKeys({ canonicalPath: canonical, legacyPath: legacy });
    const byProvider = Object.fromEntries(out.map(k => [k.provider, k]));

    assert.equal(byProvider.openai.status, 'present');
    assert.equal(byProvider.openai.source, 'canonical');
    assert.ok(byProvider.openai.masked.startsWith('sk-can'));
    assert.equal(byProvider.openai.masked.endsWith('7890'), true);

    assert.equal(byProvider.groq.status, 'present');
    assert.equal(byProvider.groq.source, 'canonical');
    // groq fingerprint NO debe ser el del legacy
    assert.notEqual(byProvider.groq.fingerprint, secrets.fingerprint('gsk_LEGACY-DRIFT-1234567890aaaa'));

    // gemini-google resuelve contra providers.google.api_key (asimetría)
    assert.equal(byProvider['gemini-google'].status, 'present');
    assert.ok(byProvider['gemini-google'].masked.startsWith('AIza-c'));

    // nvidia presente (CA-3)
    assert.equal(byProvider.nvidia.status, 'present');
    assert.equal(byProvider.nvidia.source, 'canonical');
    assert.ok(byProvider.nvidia.masked.startsWith('nvapi-'));
});

test('listKeys cae al legacy (telegram-config.json) cuando canonical no existe + emite WARN', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json'); // NO existe
    const legacy = path.join(dir, 'telegram-config.json');
    fs.writeFileSync(legacy, JSON.stringify({
        openai_api_key: 'sk-LEGACY-1234567890abcdef0000',
        groq_api_key: 'gsk_legacy_1234567890abcdef0000',
        anthropic_api_key: 'PLACEHOLDER',
    }));

    const warn = collectWarnings();
    const out = secrets.listKeys({ canonicalPath: canonical, legacyPath: legacy, logger: warn.logger });
    const byProvider = Object.fromEntries(out.map(k => [k.provider, k]));

    assert.equal(byProvider.openai.status, 'present');
    assert.equal(byProvider.openai.source, 'legacy');
    assert.equal(byProvider.openai.masked.startsWith('sk-LEG'), true);

    assert.equal(byProvider.groq.status, 'present');
    assert.equal(byProvider.groq.source, 'legacy');

    assert.equal(byProvider.anthropic.status, 'placeholder');
    // nvidia NO está en legacy → absent
    assert.equal(byProvider.nvidia.status, 'absent');
    assert.equal(byProvider.nvidia.masked, null);

    // WARN obligatorio (guard-rail #4)
    const warning = warn.msgs.find(m => /falling back to legacy/i.test(m));
    assert.ok(warning, 'debe loguear WARN al caer al legacy');
});

test('listKeys con ambos archivos: canonical gana (sin drift)', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    const legacy = path.join(dir, 'telegram-config.json');
    writeCanonical(canonical, {
        providers: { groq: { api_key: 'gsk_CANONICAL_aaaaaaaaaaaaaaaaaaaaa' } },
    });
    fs.writeFileSync(legacy, JSON.stringify({
        groq_api_key: 'gsk_LEGACY_bbbbbbbbbbbbbbbbbbbbbbb',
    }));
    const out = secrets.listKeys({ canonicalPath: canonical, legacyPath: legacy });
    const groq = out.find(k => k.provider === 'groq');
    assert.equal(groq.source, 'canonical');
    assert.equal(groq.fingerprint, secrets.fingerprint('gsk_CANONICAL_aaaaaaaaaaaaaaaaaaaaa'));
});

test('listKeys ningún archivo existe: todos absent', () => {
    const dir = tmpDir();
    const out = secrets.listKeys({
        canonicalPath: path.join(dir, 'no-canonical.json'),
        legacyPath: path.join(dir, 'no-legacy.json'),
    });
    for (const k of out) {
        assert.equal(k.status, 'absent', `${k.provider} debe ser absent sin archivos`);
        assert.equal(k.masked, null);
        assert.equal(k.fingerprint, null);
    }
});

// ─── CA-2: shape de respuesta retro-compat (jsonField) ─────────────────────

test('listKeys preserva jsonField en la respuesta (retro-compat shape API)', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    writeCanonical(canonical, {
        providers: { openai: { api_key: 'sk-present-1234567890abcdef0000' } },
    });
    const out = secrets.listKeys({ canonicalPath: canonical, legacyPath: '/nope.json' });
    const openai = out.find(k => k.provider === 'openai');
    assert.equal(openai.jsonField, 'openai_api_key', 'jsonField debe seguir presente para audit-log / scripts viejos');
    assert.equal(openai.dotPath, 'providers.openai.api_key');
    assert.equal(openai.legacyField, 'openai_api_key');
});

test('nvidia tiene jsonField derivado del leaf del dot-path (no tenía legacyField)', () => {
    const dir = tmpDir();
    const out = secrets.listKeys({
        canonicalPath: path.join(dir, 'no-canonical.json'),
        legacyPath: path.join(dir, 'no-legacy.json'),
    });
    const nvidia = out.find(k => k.provider === 'nvidia');
    assert.equal(nvidia.jsonField, 'api_key', 'nvidia jsonField cae al leaf cuando legacyField=null');
    assert.equal(nvidia.dotPath, 'providers.nvidia.api_key');
    assert.equal(nvidia.legacyField, null);
});

// ─── CA-3: NVIDIA NIM gestionable ──────────────────────────────────────────

test('MANAGED_KEYS incluye nvidia editable=true', () => {
    const nvidia = secrets.MANAGED_KEYS.find(k => k.provider === 'nvidia');
    assert.ok(nvidia, 'nvidia debe estar en MANAGED_KEYS');
    assert.equal(nvidia.editable, true);
    assert.equal(nvidia.dotPath, 'providers.nvidia.api_key');
    assert.ok(nvidia.free_tier_notes, 'nvidia debe tener free_tier_notes');
});

test('listKeys de nvidia muestra status=present cuando credentials.json tiene la key', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    writeCanonical(canonical, {
        providers: { nvidia: { api_key: 'nvapi-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } },
    });
    const out = secrets.listKeys({ canonicalPath: canonical, legacyPath: '/nope.json' });
    const nvidia = out.find(k => k.provider === 'nvidia');
    assert.equal(nvidia.status, 'present');
    assert.ok(nvidia.fingerprint);
});

// ─── CA-4 + guard-rails: rotateKey ─────────────────────────────────────────

test('rotateKey rechaza provider no gestionado', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    writeCanonical(canonical, {});
    assert.throws(
        () => secrets.rotateKey({ provider: 'unknown-provider', newValue: 'x'.repeat(40), canonicalPath: canonical, backupDir: path.join(dir, 'bak') }),
        /no está gestionado/
    );
});

test('rotateKey rechaza Anthropic (no editable)', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    writeCanonical(canonical, { providers: { anthropic: { api_key: 'sk-ant-xxxxxxxxxxxx' } } });
    assert.throws(
        () => secrets.rotateKey({ provider: 'anthropic', newValue: 'sk-ant-new'.padEnd(40, 'x'), canonicalPath: canonical, backupDir: path.join(dir, 'bak') }),
        /no es editable/
    );
});

test('rotateKey defensas vigentes (vacío / corto / placeholder / control chars)', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    writeCanonical(canonical, {});
    const common = { provider: 'openai', canonicalPath: canonical, backupDir: path.join(dir, 'bak') };
    assert.throws(() => secrets.rotateKey({ ...common, newValue: '' }), /newValue.*requerido/);
    assert.throws(() => secrets.rotateKey({ ...common, newValue: 'short' }), /demasiado corto/);
    assert.throws(() => secrets.rotateKey({ ...common, newValue: 'EXAMPLE-this-is-fake-key-12345' }), /placeholder/);
    assert.throws(() => secrets.rotateKey({ ...common, newValue: 'sk-with-newline\nbad-aaaaaaaaaa' }), /control/);
});

test('rotateKey escribe al canonical (dot-path) preservando otros campos', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'bak');
    writeCanonical(canonical, {
        telegram: { bot_token: 'KEEP_ME', chat_id: '12345' },
        providers: {
            openai: { api_key: 'sk-old-12345678901234567890' },
            groq: { api_key: 'gsk_keep_me_12345678901234567890' },
        },
    });

    const result = secrets.rotateKey({
        provider: 'openai',
        newValue: 'sk-new-aaaaaaaaaaaaaaaaaaaa',
        canonicalPath: canonical,
        backupDir: bakDir,
        now: 1000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openai');
    assert.equal(result.jsonField, 'openai_api_key', 'retro-compat: jsonField en respuesta API');
    assert.equal(result.dotPath, 'providers.openai.api_key');
    assert.equal(result.canonicalPath, canonical);
    assert.ok(result.fingerprint);
    assert.ok(result.backupPath);
    assert.ok(fs.existsSync(result.backupPath));

    const updated = JSON.parse(fs.readFileSync(canonical, 'utf8'));
    assert.equal(updated.providers.openai.api_key, 'sk-new-aaaaaaaaaaaaaaaaaaaa');
    assert.equal(updated.providers.groq.api_key, 'gsk_keep_me_12345678901234567890', 'otros providers se preservan');
    assert.equal(updated.telegram.bot_token, 'KEEP_ME', 'rama telegram se preserva');
});

test('rotateKey escribe a gemini-google contra providers.google.api_key (asimetría)', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'bak');
    writeCanonical(canonical, {
        providers: { google: { api_key: 'AIza-old-12345678901234567890' } },
    });

    const result = secrets.rotateKey({
        provider: 'gemini-google',
        newValue: 'AIza-new-aaaaaaaaaaaaaaaaaaaa',
        canonicalPath: canonical,
        backupDir: bakDir,
        now: 1000,
    });

    assert.equal(result.dotPath, 'providers.google.api_key', 'dot-path resuelve a google, no a gemini-google');
    const updated = JSON.parse(fs.readFileSync(canonical, 'utf8'));
    assert.equal(updated.providers.google.api_key, 'AIza-new-aaaaaaaaaaaaaaaaaaaa');
    // NO debe haberse creado providers.gemini-google.api_key
    assert.ok(!updated.providers['gemini-google'], 'no debe crear rama gemini-google');
});

test('rotateKey crea el canonical (mkdir -p + write inicial) si no existía', () => {
    const dir = tmpDir();
    const nestedDir = path.join(dir, 'nested', 'secrets');
    const canonical = path.join(nestedDir, 'credentials.json');
    const bakDir = path.join(dir, 'bak');

    assert.ok(!fs.existsSync(canonical), 'pre: canonical no existe');
    assert.ok(!fs.existsSync(nestedDir), 'pre: directorio padre no existe');

    const result = secrets.rotateKey({
        provider: 'groq',
        newValue: 'gsk_new_xxxxxxxxxxxxxxxxxxxxx',
        canonicalPath: canonical,
        backupDir: bakDir,
        now: 1000,
    });

    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(canonical), 'canonical fue creado');
    const persisted = JSON.parse(fs.readFileSync(canonical, 'utf8'));
    assert.equal(persisted.providers.groq.api_key, 'gsk_new_xxxxxxxxxxxxxxxxxxxxx');
    // Sin backup pre-save: el archivo no existía
    assert.equal(result.backupPath, null);
});

test('rotateKey NUNCA escribe al legacy (guard-rail #1)', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    const legacy = path.join(dir, 'telegram-config.json');
    const bakDir = path.join(dir, 'bak');

    // Estado pre: canonical y legacy con valores distintos (drift)
    writeCanonical(canonical, {
        providers: { groq: { api_key: 'gsk_canonical_xxxxxxxxxxxxxxxxx' } },
    });
    fs.writeFileSync(legacy, JSON.stringify({ groq_api_key: 'gsk_legacy_DO_NOT_MODIFY_xxxx' }));

    const legacyContentBefore = fs.readFileSync(legacy, 'utf8');

    secrets.rotateKey({
        provider: 'groq',
        newValue: 'gsk_NEW_AFTER_ROTATE_xxxxxxxxxx',
        canonicalPath: canonical,
        legacyPath: legacy,
        backupDir: bakDir,
        now: 1000,
    });

    // El canonical cambió...
    const canonicalAfter = JSON.parse(fs.readFileSync(canonical, 'utf8'));
    assert.equal(canonicalAfter.providers.groq.api_key, 'gsk_NEW_AFTER_ROTATE_xxxxxxxxxx');

    // ...pero el legacy debe quedar IGUAL byte por byte.
    const legacyContentAfter = fs.readFileSync(legacy, 'utf8');
    assert.equal(legacyContentAfter, legacyContentBefore, 'legacy debe permanecer intocable post-rotateKey');
});

// ─── Backup naming + retention (guard-rail #2) ─────────────────────────────

test('rotateKey nombra backups como credentials.<ts>.json', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'bak');
    writeCanonical(canonical, { providers: { groq: { api_key: 'gsk_old_aaaaaaaaaaaaaaaaaaaaa' } } });

    const result = secrets.rotateKey({
        provider: 'groq',
        newValue: 'gsk_new_bbbbbbbbbbbbbbbbbbbbb',
        canonicalPath: canonical,
        backupDir: bakDir,
        retention: 5,
        now: 1000,
    });

    const backups = fs.readdirSync(bakDir);
    assert.equal(backups.length, 1);
    assert.ok(backups[0].startsWith('credentials.'), `backup debe empezar con credentials., fue: ${backups[0]}`);
    assert.ok(backups[0].endsWith('.json'));
    assert.ok(!backups[0].startsWith('telegram-config.'), 'NO debe usar prefijo legacy');
    assert.equal(result.backupPath, path.join(bakDir, backups[0]));
});

test('applyBackupRetention filtra por prefijo credentials.* y respeta retention', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'bak');
    writeCanonical(canonical, { providers: { openai: { api_key: 'sk-init-1234567890abcdef0000' } } });

    for (let i = 0; i < 5; i++) {
        secrets.rotateKey({
            provider: 'openai',
            newValue: 'sk-rot-' + String(i).padEnd(30, 'x'),
            canonicalPath: canonical,
            backupDir: bakDir,
            retention: 2,
            now: 1000 + i,
        });
    }
    const files = fs.readdirSync(bakDir);
    assert.equal(files.length, 2, 'retention=2 mantiene solo 2 backups');
    for (const f of files) {
        assert.ok(f.startsWith('credentials.'), `${f} debe usar prefijo canonical`);
    }
});

test('applyBackupRetention NO toca backups con prefijo legacy (no los elimina ni los cuenta)', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'bak');
    fs.mkdirSync(bakDir);
    // Backup pre-#3313 orphan: queda histórico, no se debe borrar ni contar
    fs.writeFileSync(path.join(bakDir, 'telegram-config.2025-old.json'), '{}');

    writeCanonical(canonical, { providers: { openai: { api_key: 'sk-init-1234567890abcdef0000' } } });
    for (let i = 0; i < 5; i++) {
        secrets.rotateKey({
            provider: 'openai',
            newValue: 'sk-rot-' + String(i).padEnd(30, 'x'),
            canonicalPath: canonical,
            backupDir: bakDir,
            retention: 2,
            now: 2000 + i,
        });
    }
    const files = fs.readdirSync(bakDir);
    const canonicalBaks = files.filter(f => f.startsWith('credentials.'));
    const legacyBaks = files.filter(f => f.startsWith('telegram-config.'));
    assert.equal(canonicalBaks.length, 2, 'retention=2 sobre canonical');
    assert.equal(legacyBaks.length, 1, 'orphan legacy backup queda intacto');
});

// ─── getRawKey: canonical → fallback legacy ────────────────────────────────

test('getRawKey lee del canonical cuando existe', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    writeCanonical(canonical, {
        providers: { openai: { api_key: 'sk-real-1234567890abcdef0000' } },
    });
    assert.equal(
        secrets.getRawKey({ provider: 'openai', canonicalPath: canonical, legacyPath: '/nope.json' }),
        'sk-real-1234567890abcdef0000'
    );
});

test('getRawKey cae al legacy cuando canonical no existe', () => {
    const dir = tmpDir();
    const legacy = path.join(dir, 'telegram-config.json');
    fs.writeFileSync(legacy, JSON.stringify({ openai_api_key: 'sk-legacy-1234567890abcdef000' }));
    const warn = collectWarnings();
    const result = secrets.getRawKey({
        provider: 'openai',
        canonicalPath: path.join(dir, 'no-canonical.json'),
        legacyPath: legacy,
        logger: warn.logger,
    });
    assert.equal(result, 'sk-legacy-1234567890abcdef000');
    assert.ok(warn.msgs.some(m => /falling back to legacy/i.test(m)));
});

test('getRawKey retorna null para placeholder, absent o provider no gestionado', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    writeCanonical(canonical, {
        providers: {
            openai: { api_key: 'sk-real-1234567890abcdef0000' },
        },
        multimedia: { elevenlabs_api_key: 'PLACEHOLDER' },
    });
    assert.equal(secrets.getRawKey({ provider: 'elevenlabs', canonicalPath: canonical, legacyPath: '/nope.json' }), null);
    assert.equal(secrets.getRawKey({ provider: 'anthropic', canonicalPath: canonical, legacyPath: '/nope.json' }), null);
    assert.equal(secrets.getRawKey({ provider: 'unknown', canonicalPath: canonical, legacyPath: '/nope.json' }), null);
});

test('getRawKey de nvidia funciona solo desde canonical (sin legacyField)', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    const legacy = path.join(dir, 'telegram-config.json');
    writeCanonical(canonical, {
        providers: { nvidia: { api_key: 'nvapi-realkey-xxxxxxxxxxxxxxxxxxxx' } },
    });
    fs.writeFileSync(legacy, JSON.stringify({}));
    assert.equal(
        secrets.getRawKey({ provider: 'nvidia', canonicalPath: canonical, legacyPath: legacy }),
        'nvapi-realkey-xxxxxxxxxxxxxxxxxxxx'
    );
});

// ─── Free providers (#3260) ────────────────────────────────────────────────

test('MANAGED_KEYS incluye los free providers (groq, gemini-google, cerebras, nvidia)', () => {
    const providers = secrets.MANAGED_KEYS.map(k => k.provider);
    for (const p of ['groq', 'gemini-google', 'cerebras', 'nvidia']) {
        assert.ok(providers.includes(p), `${p} debe estar en MANAGED_KEYS`);
    }
});

test('free providers son editable=true y traen free_tier_notes', () => {
    for (const p of ['groq', 'gemini-google', 'cerebras', 'nvidia']) {
        const spec = secrets.MANAGED_KEYS.find(k => k.provider === p);
        assert.equal(spec.editable, true, `${p} debe ser editable`);
        assert.ok(spec.free_tier_notes, `${p} debe tener free_tier_notes`);
    }
});

test('rotateKey de free provider crea backup + write atómico (SR-1)', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'bak');
    writeCanonical(canonical, { providers: { groq: { api_key: 'gsk_old_aaaaaaaaaaaaaaaaaaaaa' } } });
    const result = secrets.rotateKey({
        provider: 'groq',
        newValue: 'gsk_new_bbbbbbbbbbbbbbbbbbbbb',
        canonicalPath: canonical,
        backupDir: bakDir,
        retention: 5,
    });
    assert.equal(result.ok, true);
    assert.ok(result.fingerprint);
    assert.equal(result.fingerprint.length, 16);
    const persisted = JSON.parse(fs.readFileSync(canonical, 'utf8'));
    assert.equal(persisted.providers.groq.api_key, 'gsk_new_bbbbbbbbbbbbbbbbbbbbb');
});

test('listKeys de free provider incluye free_tier_notes en metadata', () => {
    const dir = tmpDir();
    const canonical = path.join(dir, 'credentials.json');
    writeCanonical(canonical, { providers: { groq: { api_key: 'gsk_aaaaaaaaaaaaaaaaaaaaaa' } } });
    const out = secrets.listKeys({ canonicalPath: canonical, legacyPath: '/nope.json' });
    const groq = out.find(k => k.provider === 'groq');
    assert.equal(groq.status, 'present');
    assert.ok(groq.free_tier_notes, 'free_tier_notes debe estar en la metadata listKeys');
});

// ─── Guard-rail #5: paridad MANAGED_KEYS.dotPath ⊆ credentials.js:ENV_MAPPING

test('paridad: cada dotPath de MANAGED_KEYS está declarado en credentials.js:ENV_MAPPING', () => {
    const envPaths = new Set(Object.keys(credentials.ENV_MAPPING));
    for (const spec of secrets.MANAGED_KEYS) {
        assert.ok(
            envPaths.has(spec.dotPath),
            `secrets-rw MANAGED_KEYS[${spec.provider}].dotPath = '${spec.dotPath}' debe estar en credentials.js:ENV_MAPPING — sino se reabre el drift que cerró #3313`
        );
    }
});

// ─── Endpoint shape (CA-5) — verificación funcional ────────────────────────

test('listKeys mantiene los 7 providers gestionables del shape post-#3313', () => {
    const dir = tmpDir();
    const out = secrets.listKeys({
        canonicalPath: path.join(dir, 'no-canonical.json'),
        legacyPath: path.join(dir, 'no-legacy.json'),
    });
    const providers = out.map(k => k.provider).sort();
    assert.deepEqual(providers, [
        'anthropic',
        'cerebras',
        'elevenlabs',
        'gemini-google',
        'groq',
        'nvidia',
        'openai',
    ]);

    // anthropic siempre editable=false
    const anthropic = out.find(k => k.provider === 'anthropic');
    assert.equal(anthropic.editable, false);
    assert.ok(anthropic.reason);
});
