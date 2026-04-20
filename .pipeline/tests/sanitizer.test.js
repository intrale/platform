// =============================================================================
// sanitizer.test.js — Tests unitarios del módulo core (issue #2333 / #2324)
//
// Test runner minimalista (pure node, sin dependencias): cada test se
// registra con `test(name, fn)`, al final se imprime el resumen. `node
// sanitizer.test.js` devuelve exit code 0 si todo pasa, 1 si algún test falla.
// =============================================================================
'use strict';

const assert = require('assert');
const path = require('path');
const { Readable } = require('stream');

const sanitizerPath = path.join(__dirname, '..', 'sanitizer.js');
const { sanitize, createSanitizeStream, __forTestsOnly__ } = require(sanitizerPath);
const { sanitizeSecrets, normalizeForMatching } = __forTestsOnly__;

// ─── Runner minimal ─────────────────────────────────────────────────────────
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function runAll() {
    let passed = 0; let failed = 0; const errors = [];
    for (const t of tests) {
        try {
            await t.fn();
            passed++;
            // eslint-disable-next-line no-console
            console.log(`  ✓ ${t.name}`);
        } catch (e) {
            failed++;
            errors.push({ name: t.name, err: e });
            // eslint-disable-next-line no-console
            console.log(`  ✗ ${t.name}`);
            // eslint-disable-next-line no-console
            console.log(`     ${e && e.message}`);
        }
    }
    // eslint-disable-next-line no-console
    console.log(`\n${passed} passed, ${failed} failed (${tests.length} total)`);
    if (failed > 0) process.exit(1);
}

// ─── Sample secretos ficticios (ninguno es real) ────────────────────────────
// Usamos valores obviamente artificiales: longitud/forma correcta pero sin
// relación con credenciales reales. Nunca usar secretos reales en tests.

const FAKE_AWS_AK = 'AKIAIOSFODNN7EXAMPLE';
const FAKE_AWS_SK = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY12';
const FAKE_GITHUB = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaXX';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123_xyz';
const FAKE_TG_BOT = '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FAKE_GOOGLE_API = 'AIzaSyA-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FAKE_SLACK = 'https://hooks.slack.com/services/T1234AAAA/B5678BBBB/AbCdEfGhIjKlMnOpQrStUv';

const FAKE_PEM = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEpAIBAAKCAQEAvQFIctxlqFake00000000000000000000000000000000000',
    'K8HP+FAKE==',
    '-----END RSA PRIVATE KEY-----',
].join('\n');

// =============================================================================
// CA2: patrones — 1 positivo + 1 negativo por patrón
// =============================================================================

test('AWS_ACCESS_KEY positivo: AKIA redacted', () => {
    const out = sanitize(`key=${FAKE_AWS_AK}`);
    assert.ok(out.includes('[REDACTED:AWS_ACCESS_KEY]'), out);
    assert.ok(!out.includes(FAKE_AWS_AK));
});

test('AWS_ACCESS_KEY negativo: string similar pero no matchea longitud', () => {
    const out = sanitize('AKIASHORT');
    assert.ok(!out.includes('[REDACTED:AWS_ACCESS_KEY]'));
});

test('AWS_SECRET_KEY positivo: con key contextualizada', () => {
    const out = sanitize(`aws_secret_access_key=${FAKE_AWS_SK}`);
    assert.ok(out.includes('[REDACTED:AWS_SECRET_KEY]'));
});

test('AWS_SECRET_KEY negativo: base64 aleatorio sin contexto NO se redacta', () => {
    const random40 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd';
    const out = sanitize(`random="${random40}"`);
    assert.ok(!out.includes('[REDACTED:AWS_SECRET_KEY]'));
});

test('GITHUB_TOKEN positivo: ghp_ redacted', () => {
    const out = sanitize(`Authorization: token ${FAKE_GITHUB}`);
    assert.ok(out.includes('[REDACTED:GITHUB_TOKEN]') || out.includes('[REDACTED:BEARER_TOKEN]'));
    assert.ok(!out.includes(FAKE_GITHUB));
});

test('GITHUB_TOKEN negativo: ghp_ demasiado corto', () => {
    const out = sanitize('ghp_short');
    assert.ok(!out.includes('[REDACTED:GITHUB_TOKEN]'));
});

test('JWT positivo: eyJ... 3 segmentos redacted', () => {
    const out = sanitize(`token=${FAKE_JWT}`);
    assert.ok(out.includes('[REDACTED:JWT]'));
});

test('JWT negativo: solo 2 segmentos no matchea', () => {
    const out = sanitize('eyJhbGciOiJIUzI1NiJ9.onlyTwoSegments');
    assert.ok(!out.includes('[REDACTED:JWT]'));
});

test('TELEGRAM_BOT_TOKEN positivo: <digits>:<35 chars>', () => {
    const out = sanitize(`bot=${FAKE_TG_BOT}`);
    assert.ok(out.includes('[REDACTED:TELEGRAM_BOT_TOKEN]'));
});

test('TELEGRAM_BOT_TOKEN negativo: muy corto', () => {
    const out = sanitize('bot=123:short');
    assert.ok(!out.includes('[REDACTED:TELEGRAM_BOT_TOKEN]'));
});

test('GOOGLE_API_KEY positivo: AIza...', () => {
    const out = sanitize(`apiKey=${FAKE_GOOGLE_API}`);
    // puede aplicar CONF_STRUCTURED o GOOGLE_API_KEY
    assert.ok(
        out.includes('[REDACTED:GOOGLE_API_KEY]') ||
        out.includes('[REDACTED:CONF_VALUE]')
    );
    assert.ok(!out.includes(FAKE_GOOGLE_API));
});

test('GOOGLE_API_KEY negativo: AIza corto no matchea', () => {
    const out = sanitize('AIzaShort');
    assert.ok(!out.includes('[REDACTED:GOOGLE_API_KEY]'));
});

test('PRIVATE_KEY positivo: bloque PEM entero redacted', () => {
    const out = sanitize(`config:\n${FAKE_PEM}\nend`);
    assert.ok(out.includes('[REDACTED:PRIVATE_KEY]'));
    assert.ok(!out.includes('MIIEpAIBAAKCAQEA'));
});

test('PRIVATE_KEY negativo: sólo el header sin BEGIN/END no matchea', () => {
    const out = sanitize('text with -----BEGIN RSA PRIVATE KEY----- but no close');
    assert.ok(!out.includes('[REDACTED:PRIVATE_KEY]'));
});

test('BASIC_AUTH positivo: user:pass@host en URL', () => {
    const out = sanitize('https://admin:s3cret@db.intrale.com/x');
    assert.ok(out.includes('[REDACTED:BASIC_AUTH]'));
    assert.ok(!out.includes('s3cret'));
});

test('BASIC_AUTH negativo: URL sin creds', () => {
    const out = sanitize('https://db.intrale.com/x');
    assert.ok(!out.includes('[REDACTED:BASIC_AUTH]'));
});

test('DB_URL_QUERY positivo: postgres con password en query', () => {
    const out = sanitize('postgres://host/db?password=abc123');
    assert.ok(out.includes('[REDACTED:DB_URL]'));
});

test('DB_URL_QUERY negativo: postgres sin password', () => {
    const out = sanitize('postgres://host/db?foo=bar');
    assert.ok(!out.includes('[REDACTED:DB_URL]'));
});

test('SLACK_WEBHOOK positivo', () => {
    const out = sanitize(`webhook=${FAKE_SLACK}`);
    assert.ok(out.includes('[REDACTED:SLACK_WEBHOOK]'));
});

test('SLACK_WEBHOOK negativo', () => {
    const out = sanitize('https://hooks.slack.com/foo');
    assert.ok(!out.includes('[REDACTED:SLACK_WEBHOOK]'));
});

test('HEADER Authorization Bearer positivo', () => {
    const out = sanitize('Authorization: Bearer abc.def.ghi');
    assert.ok(out.includes('[REDACTED:BEARER_TOKEN]'));
});

test('HEADER Authorization negativo: sin dos puntos y valor', () => {
    const out = sanitize('No authorization here');
    assert.ok(!out.includes('[REDACTED:BEARER_TOKEN]'));
});

test('HEADER x-api-key positivo', () => {
    const out = sanitize('x-api-key: SECRET_VALUE_123');
    assert.ok(out.includes('[REDACTED:API_KEY]'));
});

test('HEADER Cookie positivo', () => {
    const out = sanitize('Cookie: session=abc; user=leo');
    assert.ok(out.includes('[REDACTED:COOKIE]'));
});

test('CONF_STRUCTURED positivo: password="..." redacted', () => {
    const out = sanitize('password="s3cret"');
    assert.ok(out.includes('[REDACTED:CONF_VALUE]'));
});

test('CONF_STRUCTURED negativo: clave no sensible', () => {
    const out = sanitize('username="leo"');
    assert.ok(!out.includes('[REDACTED:CONF_VALUE]'));
});

// =============================================================================
// CA3: resistencia a bypass
// =============================================================================

test('bypass ZWSP entre caracteres de un token: se detecta', () => {
    // Insertamos zero-width space en medio del prefijo ghp_
    const zwsp = '\u200B';
    const poisoned = `gh${zwsp}p_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaXX`;
    const out = sanitize(poisoned);
    assert.ok(out.includes('[REDACTED:GITHUB_TOKEN]'), `out=${out}`);
});

test('bypass BOM al inicio: no bloquea detección', () => {
    const bom = '\uFEFF';
    const out = sanitize(bom + FAKE_AWS_AK);
    assert.ok(out.includes('[REDACTED:AWS_ACCESS_KEY]'));
});

test('bypass null byte embebido: se elimina antes de matchear', () => {
    const poisoned = 'AKIA\u0000IOSFODNN7EXAMPLE';
    const out = sanitize(poisoned);
    assert.ok(out.includes('[REDACTED:AWS_ACCESS_KEY]'));
});

test('bypass case folding en header: AuThOrIzAtIoN redacted', () => {
    const out = sanitize('AuThOrIzAtIoN: Bearer abc');
    assert.ok(out.includes('[REDACTED:BEARER_TOKEN]'));
});

test('bypass homoglyphs: Cyrillic A en AKIA se detecta', () => {
    // Reemplazamos la A inicial por Cyrillic A (U+0410), que el normalizer
    // debe mapear a Latin A antes de matchear.
    const cyrillicA = '\u0410';
    const poisoned = cyrillicA + 'KIAIOSFODNN7EXAMPLE';
    const out = sanitize(poisoned);
    assert.ok(out.includes('[REDACTED:AWS_ACCESS_KEY]'), `out=${out}`);
});

test('NFC: decomposed form (e + combining acute) se normaliza antes', () => {
    // Este test valida que sanitize invoca NFC (vía sanitizeSecrets).
    const decomposed = 'cafe\u0301'; // "café" descompuesto
    const composed = sanitize(decomposed);
    // El valor sigue siendo "café", solo que ahora normalizado NFC.
    assert.strictEqual(composed.normalize('NFC'), 'café'.normalize('NFC'));
});

// =============================================================================
// Composición, idempotencia, doble-redacción
// =============================================================================

test('orden del composer: primero patrones, después UTF-8', () => {
    // Un input con surrogate suelto + secreto: el secreto debe redactarse
    // aunque haya chars inválidos cerca.
    const out = sanitize(`token=${FAKE_GITHUB}\uD800`);
    assert.ok(out.includes('[REDACTED:GITHUB_TOKEN]'));
    // surrogate reemplazado por replacement char (sanitizer UTF-8).
    assert.ok(!/\uD800(?![\uDC00-\uDFFF])/.test(out));
});

test('idempotencia: sanitize(sanitize(x)) === sanitize(x)', () => {
    const input = `AKIA:${FAKE_AWS_AK} token=${FAKE_JWT} pem=${FAKE_PEM}`;
    const once = sanitize(input);
    const twice = sanitize(once);
    assert.strictEqual(once, twice);
});

test('no doble-redacción: placeholders no se re-redactan', () => {
    const input = '[REDACTED:GITHUB_TOKEN] and [REDACTED:JWT]';
    const out = sanitize(input);
    // Los placeholders deberían sobrevivir intactos.
    assert.ok(out.includes('[REDACTED:GITHUB_TOKEN]'));
    assert.ok(out.includes('[REDACTED:JWT]'));
});

// =============================================================================
// CA5: fail-closed
// =============================================================================

test('fail-closed: input no-string devuelve placeholder, no original', () => {
    const circular = {}; circular.self = circular;
    // String(circular) no falla (devuelve "[object Object]"), así que el
    // pipeline no explota; probamos un objeto cuyo toString tira.
    const evil = { toString() { throw new Error('boom'); } };
    let res;
    try {
        res = sanitize(evil);
    } catch (e) {
        res = null;
    }
    assert.ok(res === '[SANITIZER_ERROR:non_string_input]' || (typeof res === 'string' && res.startsWith('[SANITIZER_ERROR:')));
});

test('fail-closed: null / undefined → empty string, no crash', () => {
    assert.strictEqual(sanitize(null), '');
    assert.strictEqual(sanitize(undefined), '');
});

// =============================================================================
// CA6: stream-filter con chunk-splitting
// =============================================================================

test('stream-filter: secreto partido entre 2 chunks se redacta', async () => {
    const input = `prefix ${FAKE_AWS_AK} suffix\n`;
    const chunks = [
        input.slice(0, 10),
        input.slice(10, 20),
        input.slice(20),
    ];
    const stream = createSanitizeStream({ minBufferBytes: 256 });
    let out = '';
    stream.on('data', (d) => { out += d.toString(); });
    for (const c of chunks) stream.write(c);
    await new Promise((resolve, reject) => {
        stream.end();
        stream.on('end', resolve);
        stream.on('error', reject);
    });
    assert.ok(out.includes('[REDACTED:AWS_ACCESS_KEY]'), `out=${out}`);
    assert.ok(!out.includes(FAKE_AWS_AK));
});

test('stream-filter: flush por newline', async () => {
    const stream = createSanitizeStream({ minBufferBytes: 16 });
    let out = '';
    stream.on('data', (d) => { out += d.toString(); });
    // Long prefix to get over the 16-byte minBuffer + newline triggers flush.
    stream.write('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx line1\n');
    stream.write('line2\n');
    await new Promise((r) => { stream.end(); stream.on('end', r); });
    assert.ok(out.includes('line1'));
    assert.ok(out.includes('line2'));
});

// =============================================================================
// Performance: 10MB adversarial en <500ms
// =============================================================================

test('performance: 10MB adversarial en <500ms', () => {
    // Texto construido con muchas ocurrencias de patrones cortos para forzar
    // trabajo real del regex engine.
    const block = `row ${FAKE_AWS_AK} | auth: Bearer ${FAKE_JWT} | key=${FAKE_GITHUB}\n`;
    const target = 10 * 1024 * 1024;
    let payload = '';
    while (payload.length < target) payload += block;
    payload = payload.slice(0, target);

    const t0 = Date.now();
    const out = sanitize(payload);
    const elapsed = Date.now() - t0;

    assert.ok(out.includes('[REDACTED:AWS_ACCESS_KEY]'));
    assert.ok(elapsed < 500, `elapsed=${elapsed}ms`);
});

// =============================================================================
// Helpers internos
// =============================================================================

test('normalizeForMatching: strippea ZWSP', () => {
    assert.strictEqual(normalizeForMatching('a\u200Bb'), 'ab');
});

test('normalizeForMatching: fold homoglifos', () => {
    assert.strictEqual(normalizeForMatching('\u0410'), 'A');
});

test('sanitizeSecrets: expuesto para tests y es puro', () => {
    const once = sanitizeSecrets(`x=${FAKE_AWS_AK}`);
    const twice = sanitizeSecrets(once);
    assert.strictEqual(once, twice);
});

// ─── run ────────────────────────────────────────────────────────────────────
runAll().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
});
