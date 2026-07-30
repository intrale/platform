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
    // #3353: cualquier flat key conocida sigue marcando legacy (groq fue
    // removido del MANAGED_KEYS, así que ya no aparece acá).
    assert.equal(secrets.detectFormat({ anthropic_api_key: 'sk-ant-xxx' }), 'legacy');
    assert.equal(secrets.detectFormat({}), 'canonical');
});

test('setNested crea estructura intermedia y asigna el valor', () => {
    const obj = {};
    secrets.setNested(obj, 'providers.cerebras.api_key', 'csk_real');
    assert.deepEqual(obj, { providers: { cerebras: { api_key: 'csk_real' } } });

    secrets.setNested(obj, 'providers.openai.api_key', 'sk-real');
    assert.equal(obj.providers.openai.api_key, 'sk-real');
    assert.equal(obj.providers.cerebras.api_key, 'csk_real', 'no debe pisar siblings');
});

test('listKeys lee del formato CANONICAL nested', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify({
        providers: {
            openai:   { api_key: 'sk-actual-key-1234567890abcdef' },
            anthropic: { api_key: 'PLACEHOLDER' },
            google:   { api_key: 'AIza_real_key_1234567890abc' },
            cerebras: { api_key: 'csk_real_key_1234567890abcdef' },
        },
    }));
    const out = secrets.listKeys({ secretsPath: file });
    const byProvider = Object.fromEntries(out.map(k => [k.provider, k]));

    assert.equal(byProvider.openai.status, 'present');
    assert.ok(byProvider.openai.masked.startsWith('sk-act'));
    assert.equal(byProvider.openai.masked.endsWith('cdef'), true);
    assert.equal(byProvider.openai.editable, true);

    assert.equal(byProvider.anthropic.status, 'placeholder');
    assert.equal(byProvider.anthropic.editable, false);

    // Los free providers vivos DEBEN aparecer como present con la estructura
    // nested — éste es exactamente el caso que rompía el dashboard antes de
    // #3313. #3353 eliminó groq, así que ya no aparece en este listado.
    assert.equal(byProvider['gemini-google'].status, 'present');
    assert.equal(byProvider.cerebras.status, 'present');
    assert.equal(byProvider.groq, undefined, 'groq debería estar removido tras #3353');
});

test('listKeys lee del formato LEGACY flat (fallback)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'telegram-config.json');
    fs.writeFileSync(file, JSON.stringify({
        openai_api_key: 'sk-legacy-1234567890abcdef',
        anthropic_api_key: 'PLACEHOLDER',
    }));
    const out = secrets.listKeys({ secretsPath: file });
    const byProvider = Object.fromEntries(out.map(k => [k.provider, k]));

    assert.equal(byProvider.openai.status, 'present');
    assert.equal(byProvider.anthropic.status, 'placeholder');
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
        multimedia: { tts_voice: 'preserved-voice' },
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
    assert.equal(updated.multimedia.tts_voice, 'preserved-voice', 'siblings preservados');
});

test('rotateKey crea archivo CANONICAL si no existe (estructura nested)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'bak');
    const result = secrets.rotateKey({
        provider: 'cerebras',
        newValue: 'csk_fresh_aaaaaaaaaaaaaaaaaaaa',
        secretsPath: file,
        backupDir: bakDir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.format, 'canonical');
    assert.equal(result.canonicalPath, 'providers.cerebras.api_key');
    const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(updated.providers.cerebras.api_key, 'csk_fresh_aaaaaaaaaaaaaaaaaaaa');
});

test('rotateKey sobre archivo LEGACY preserva formato flat (compat hacia atrás)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'telegram-config.json');
    const bakDir = path.join(dir, 'bak');
    fs.writeFileSync(file, JSON.stringify({
        openai_api_key: 'sk-old-12345678901234567890',
        anthropic_api_key: 'PLACEHOLDER',
    }));
    const result = secrets.rotateKey({
        provider: 'openai',
        newValue: 'sk-new-bbbbbbbbbbbbbbbbbbbbb',
        secretsPath: file,
        backupDir: bakDir,
    });
    assert.equal(result.format, 'legacy');
    const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(updated.openai_api_key, 'sk-new-bbbbbbbbbbbbbbbbbbbbb');
    assert.equal(updated.anthropic_api_key, 'PLACEHOLDER', 'flat siblings preservados');
});

test('rotateKey rechaza groq (provider descontinuado en #3353)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'bak');
    assert.throws(
        () => secrets.rotateKey({
            provider: 'groq',
            newValue: 'gsk_fresh_aaaaaaaaaaaaaaaaaaaa',
            secretsPath: file,
            backupDir: bakDir,
        }),
        /no está gestionado/,
        'groq ya no debería ser un provider gestionado'
    );
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
            anthropic: { api_key: 'PLACEHOLDER' },
        },
    }));
    assert.equal(secrets.getRawKey({ provider: 'openai', secretsPath: file }), 'sk-real-1234567890abcdef0000');
    // 'gemini-google' (UI) mapea a 'providers.google.api_key' en canonical.
    assert.equal(secrets.getRawKey({ provider: 'gemini-google', secretsPath: file }), 'AIza-real-1234567890abcdef');
    assert.equal(secrets.getRawKey({ provider: 'cerebras', secretsPath: file }), 'csk-real-1234567890abcdef');
    assert.equal(secrets.getRawKey({ provider: 'anthropic', secretsPath: file }), null, 'PLACEHOLDER → null');
});

test('getRawKey lee del LEGACY flat cuando el canonical no existe', () => {
    const dir = tmpDir();
    const legacyFile = path.join(dir, 'telegram-config.json');
    fs.writeFileSync(legacyFile, JSON.stringify({
        openai_api_key: 'sk-legacy-1234567890abcdef',
    }));
    assert.equal(secrets.getRawKey({ provider: 'openai', secretsPath: legacyFile }), 'sk-legacy-1234567890abcdef');
});

// ─── Free providers vivos (#3260 + #3313 + #3353) ───────────────────────────

test('MANAGED_KEYS incluye los free providers vivos con canonicalPath', () => {
    const providers = secrets.MANAGED_KEYS.map(k => k.provider);
    // #3353 — groq fue removido tras descontinuación del provider.
    assert.ok(!providers.includes('groq'), 'groq debería estar removido tras #3353');
    assert.ok(providers.includes('gemini-google'), 'gemini-google presente');
    assert.ok(providers.includes('cerebras'), 'cerebras presente');
    assert.ok(providers.includes('nvidia-nim'), 'nvidia-nim presente');

    const byP = Object.fromEntries(secrets.MANAGED_KEYS.map(k => [k.provider, k]));
    assert.equal(byP['gemini-google'].canonicalPath, 'providers.google.api_key');
    assert.equal(byP.cerebras.canonicalPath, 'providers.cerebras.api_key');
});

test('free providers son editable=true (rotables vía UI)', () => {
    for (const p of ['cerebras', 'nvidia-nim']) {
        const spec = secrets.MANAGED_KEYS.find(k => k.provider === p);
        assert.equal(spec.editable, true, `${p} debe ser editable`);
        assert.ok(spec.free_tier_notes, `${p} debe tener free_tier_notes`);
    }
    const gemini = secrets.MANAGED_KEYS.find(k => k.provider === 'gemini-google');
    assert.equal(gemini.editable, false, 'Gemini OAuth no rota API keys vía UI');
    assert.ok(gemini.free_tier_notes);
});

test('rotateKey de free provider sobre CANONICAL crea backup + write atómico 0600 (SR-1)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'bak');
    fs.writeFileSync(file, JSON.stringify({
        providers: { cerebras: { api_key: 'csk_old_aaaaaaaaaaaaaaaaaaaaa' } },
    }));
    const result = secrets.rotateKey({
        provider: 'cerebras',
        newValue: 'csk_new_bbbbbbbbbbbbbbbbbbbbb',
        secretsPath: file,
        backupDir: bakDir,
        retention: 5,
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'cerebras');
    assert.equal(result.format, 'canonical');
    assert.ok(result.fingerprint, 'fingerprint generado');
    assert.equal(result.fingerprint.length, 16);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.providers.cerebras.api_key, 'csk_new_bbbbbbbbbbbbbbbbbbbbb');
    const backups = fs.readdirSync(bakDir).filter(f => f.startsWith('credentials.'));
    assert.equal(backups.length, 1);
});

test('listKeys de free provider incluye free_tier_notes en metadata', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify({
        providers: { cerebras: { api_key: 'csk_aaaaaaaaaaaaaaaaaaaaaa' } },
    }));
    const out = secrets.listKeys({ secretsPath: file });
    const cerebras = out.find(k => k.provider === 'cerebras');
    assert.equal(cerebras.status, 'present');
    assert.ok(cerebras.free_tier_notes, 'free_tier_notes debe estar en la metadata listKeys');
});

// =============================================================================
// writeCanonicalPaths — punto de escritura único del store canónico (#5217).
//
// Extraído del core que rotateKey ya tenía probado. Los productores que NO son
// providers de IA (el setup OAuth de Drive) escriben por acá en vez de hacer su
// propio writeFileSync, para no perder backup + atomicidad + 0600 + retención.
//
// Valores SINTÉTICOS: ningún test lee ni escribe el store real.
// =============================================================================

test('writeCanonicalPaths escribe dot-paths anidados en el store canónico', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    writeCanonical(file);

    const res = secrets.writeCanonicalPaths({
        'google_drive.oauth_client_id': 'fake-client-id.apps.googleusercontent.com',
        'google_drive.oauth_client_secret': 'FAKE-client-secret-0000',
        'google_drive.oauth_refresh_token': '1//fake-refresh-token-000000',
    }, { secretsPath: file, backupDir: path.join(dir, 'backups') });

    assert.equal(res.ok, true);
    assert.equal(res.format, 'canonical');
    assert.deepEqual(res.written.sort(), [
        'google_drive.oauth_client_id',
        'google_drive.oauth_client_secret',
        'google_drive.oauth_refresh_token',
    ]);

    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Anidado bajo `google_drive`, no como claves flat top-level: con los nombres
    // flat del legacy, getNested() devolvería undefined y el fix quedaría sin efecto.
    assert.equal(persisted.google_drive.oauth_client_id, 'fake-client-id.apps.googleusercontent.com');
    assert.equal(persisted.google_drive.oauth_refresh_token, '1//fake-refresh-token-000000');
    assert.equal(persisted.google_oauth_client_id, undefined);
    // No pisa lo que ya estaba.
    assert.equal(persisted.telegram.bot_token, 'x');
});

test('writeCanonicalPaths genera backup previo y deja 0600 (best-effort en Windows)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'backups');
    writeCanonical(file, { google_drive: { oauth_refresh_token: '1//viejo-fake-token-0000' } });

    const res = secrets.writeCanonicalPaths(
        { 'google_drive.oauth_refresh_token': '1//nuevo-fake-token-0000' },
        { secretsPath: file, backupDir: bakDir },
    );

    assert.ok(res.backupPath, 'debe generar backup pre-save');
    const backup = JSON.parse(fs.readFileSync(res.backupPath, 'utf8'));
    assert.equal(backup.google_drive.oauth_refresh_token, '1//viejo-fake-token-0000');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).google_drive.oauth_refresh_token, '1//nuevo-fake-token-0000');

    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    // Escritura atómica: no queda ningún .tmp huérfano.
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes('.tmp.')), []);
});

test('writeCanonicalPaths crea el archivo (y su directorio) si no existen, sin backup', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'anidado', 'credentials.json');

    const res = secrets.writeCanonicalPaths(
        { 'google_drive.drive_folder_id': '1FakeFolderIdForUnitTests000000' },
        { secretsPath: file, backupDir: path.join(dir, 'backups') },
    );

    assert.equal(res.backupPath, null, 'sin archivo previo no hay nada que respaldar');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).google_drive.drive_folder_id, '1FakeFolderIdForUnitTests000000');
});

test('writeCanonicalPaths aplica retención de backups', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'backups');
    writeCanonical(file);

    for (let i = 0; i < 5; i++) {
        secrets.writeCanonicalPaths(
            { 'google_drive.oauth_refresh_token': '1//fake-token-' + i },
            { secretsPath: file, backupDir: bakDir, retention: 2, now: Date.UTC(2026, 0, 1 + i) },
        );
    }

    const backups = fs.readdirSync(bakDir).filter(f => f.startsWith('credentials.'));
    assert.equal(backups.length, 2, 'retención=2 deja sólo los 2 backups más nuevos');
});

test('writeCanonicalPaths respeta el formato legacy cuando el destino es flat', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'telegram-config.json');
    writeLegacy(file, { openai_api_key: 'sk-legacy-aaaaaaaaaaaaaaaaaaaa' });

    const res = secrets.writeCanonicalPaths(
        { 'providers.openai.api_key': 'sk-nuevo-bbbbbbbbbbbbbbbbbbbb' },
        {
            secretsPath: file,
            backupDir: path.join(dir, 'backups'),
            legacyUpdates: { openai_api_key: 'sk-nuevo-bbbbbbbbbbbbbbbbbbbb' },
        },
    );

    assert.equal(res.format, 'legacy');
    assert.deepEqual(res.written, ['openai_api_key']);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.openai_api_key, 'sk-nuevo-bbbbbbbbbbbbbbbbbbbb');
    assert.equal(persisted.providers, undefined, 'no debe mezclar nested en un archivo legacy');
});

test('writeCanonicalPaths rechaza updates vacío o ausente', () => {
    assert.throws(() => secrets.writeCanonicalPaths(), /updates/);
    assert.throws(() => secrets.writeCanonicalPaths({}), /updates/);
    assert.throws(() => secrets.writeCanonicalPaths(null), /updates/);
});

test('rotateKey sigue verde delegando en writeCanonicalPaths', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    const bakDir = path.join(dir, 'backups');
    writeCanonical(file, { providers: { openai: { api_key: 'sk-viejo-aaaaaaaaaaaaaaaaaaaa' } } });

    const res = secrets.rotateKey({
        provider: 'openai',
        newValue: 'sk-nuevo-bbbbbbbbbbbbbbbbbbbb',
        secretsPath: file,
        backupDir: bakDir,
    });

    // El contrato de retorno de rotateKey no cambió.
    assert.equal(res.ok, true);
    assert.equal(res.provider, 'openai');
    assert.equal(res.canonicalPath, 'providers.openai.api_key');
    assert.equal(res.jsonField, 'openai_api_key');
    assert.equal(res.format, 'canonical');
    assert.equal(res.targetPath, file);
    assert.equal(res.fingerprint.length, 16);
    assert.ok(res.backupPath, 'rotateKey conserva el backup pre-save');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).providers.openai.api_key, 'sk-nuevo-bbbbbbbbbbbbbbbbbbbb');
});

test('MANAGED_KEYS NO se extiende con Drive (no es un provider administrable por UI)', () => {
    // MANAGED_KEYS alimenta listKeys() y la UI de credenciales del dashboard.
    // Drive entraría ahí con semántica `editable` que no le corresponde.
    const paths = secrets.MANAGED_KEYS.map(k => k.canonicalPath);
    assert.ok(!paths.some(p => p.startsWith('google_drive.')));
    assert.ok(!paths.some(p => p.startsWith('r2.')));
});

test('writeCanonicalPaths NO destruye un store ilegible: falla cerrado sin escribir', () => {
    // Antes, un JSON corrupto se degradaba a `{}` y el write lo reemplazaba por
    // un archivo con SOLO las claves nuevas: se perdian Telegram y todos los
    // providers de IA de una. El pipeline entero se quedaba sin credenciales
    // por un archivo mal formado. Ahora aborta sin tocar nada.
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    const corrupto = '{ "telegram": { "bot_token": "x" }, ESTO NO ES JSON';
    fs.writeFileSync(file, corrupto, 'utf8');

    assert.throws(
        () => secrets.writeCanonicalPaths(
            { 'google_drive.oauth_client_id': 'fake-client-id.apps.googleusercontent.com' },
            { secretsPath: file, backupDir: path.join(dir, 'backups') },
        ),
        /no es un JSON de objeto válido/,
    );

    // El archivo original quedo intacto: nada se perdio.
    assert.equal(fs.readFileSync(file, 'utf8'), corrupto);
});

test('writeCanonicalPaths rechaza un store que es un array (no un objeto)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, '["no", "es", "un", "objeto"]', 'utf8');

    assert.throws(
        () => secrets.writeCanonicalPaths(
            { 'google_drive.oauth_client_id': 'fake' },
            { secretsPath: file, backupDir: path.join(dir, 'backups') },
        ),
        /no es un JSON de objeto válido/,
    );
});
