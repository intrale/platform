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

// CA-11.1 (#2332 / rebote #2333): el formato real de URL de Telegram es
// `https://api.telegram.org/bot<TOKEN>/<metodo>`. Sin lookbehind tolerante,
// el `\b` entre "bot" y el primer dígito del token no matcheaba y el token
// quedaba expuesto en rejection reports y logs del pulpo.

test('TELEGRAM_BOT_TOKEN positivo: prefijo "bot" concatenado sin separador', () => {
    const realishToken = '1234567890:AAEhBOweik9ai9RQDRkUH8s9w1aKf5MYZxs';
    const out = sanitize(`bot${realishToken}`);
    assert.ok(out.includes('[REDACTED:TELEGRAM_BOT_TOKEN]'), `out=${out}`);
    assert.ok(!out.includes(realishToken), `fuga detectada: out=${out}`);
});

test('TELEGRAM_BOT_TOKEN positivo: URL completa api.telegram.org/bot<TOKEN>/sendMessage', () => {
    const realishToken = '1234567890:AAEhBOweik9ai9RQDRkUH8s9w1aKf5MYZxs';
    const url = `https://api.telegram.org/bot${realishToken}/sendMessage`;
    const out = sanitize(url);
    assert.ok(out.includes('[REDACTED:TELEGRAM_BOT_TOKEN]'), `out=${out}`);
    assert.ok(!out.includes(realishToken), `fuga detectada: out=${out}`);
    // La URL debe seguir siendo legible (preservamos prefijo y path)
    assert.ok(out.includes('api.telegram.org'), `out=${out}`);
    assert.ok(out.includes('/sendMessage'), `out=${out}`);
});

test('TELEGRAM_BOT_TOKEN positivo: URL con query /bot<TOKEN>/getUpdates?offset=5', () => {
    const realishToken = '9876543210:BBFiCPxflj0bj0SRESlVI9t0x2bLg6NZayt';
    const url = `/bot${realishToken}/getUpdates?offset=5`;
    const out = sanitize(url);
    assert.ok(out.includes('[REDACTED:TELEGRAM_BOT_TOKEN]'), `out=${out}`);
    assert.ok(!out.includes(realishToken), `fuga detectada: out=${out}`);
    assert.ok(out.includes('getUpdates?offset=5'), `out=${out}`);
});

test('TELEGRAM_BOT_TOKEN negativo: /bot/list sin token no se redacta', () => {
    const out = sanitize('GET /bot/list HTTP/1.1');
    assert.ok(!out.includes('[REDACTED:TELEGRAM_BOT_TOKEN]'), `out=${out}`);
});

test('TELEGRAM_BOT_TOKEN positivo: case-insensitive /Bot<TOKEN>/', () => {
    const realishToken = '1122334455:CCGjDQygmk1ck1TSFTmWJ0u1y3cMh7OAbzu';
    const url = `/Bot${realishToken}/sendPhoto`;
    const out = sanitize(url);
    assert.ok(out.includes('[REDACTED:TELEGRAM_BOT_TOKEN]'), `out=${out}`);
    assert.ok(!out.includes(realishToken), `fuga detectada: out=${out}`);
});

test('TELEGRAM_BOT_TOKEN positivo: /BOT<TOKEN>/ (uppercase)', () => {
    const realishToken = '5566778899:DDHkERzhnl2dl2UTGUnXK1v2z4dNi8PBcav';
    const out = sanitize(`https://api.telegram.org/BOT${realishToken}/getMe`);
    assert.ok(out.includes('[REDACTED:TELEGRAM_BOT_TOKEN]'), `out=${out}`);
    assert.ok(!out.includes(realishToken), `fuga detectada: out=${out}`);
});

test('TELEGRAM_BOT_TOKEN positivo: token bare al inicio de linea', () => {
    // Caso original: el token suelto debe seguir siendo redactado.
    const out = sanitize(FAKE_TG_BOT);
    assert.ok(out.includes('[REDACTED:TELEGRAM_BOT_TOKEN]'), `out=${out}`);
});

test('TELEGRAM_BOT_TOKEN negativo: bot embebido en palabra no matchea (abcdbot1234:...)', () => {
    // Si "bot" viene pegado a letras previas (no es word boundary), NO
    // queremos matchear — seria falso positivo en strings aleatorios.
    const realishToken = '1234567890:AAEhBOweik9ai9RQDRkUH8s9w1aKf5MYZxs';
    const out = sanitize(`abcdbot${realishToken}`);
    // En este caso el token NO se redacta porque está pegado a "abcdbot"
    // y no hay boundary claro. Es aceptable — el caso real de leak es URL
    // donde siempre hay `/` antes.
    assert.ok(!out.includes('[REDACTED:TELEGRAM_BOT_TOKEN]'), `out=${out}`);
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
// Performance: 10MB adversarial sin catastrophic backtracking
//
// El budget original de 500ms era brittle bajo carga: cuando el tester corre
// los 47 archivos `.test.js` del pipeline en paralelo (`node --test` hace
// pool de workers), un sanitize de 10MB que en aislado tarda ~150ms puede
// trepar a >500ms por CPU contention en la máquina del CI/agente — y el
// test fallaba sin que hubiera regresión real (rebote tester rev-3
// #2891 / #2894).
//
// Contexto adicional del rebote tester #2891 / #2894: el budget original de
// 500ms era brittle bajo carga porque `node --test` hace pool de workers y un
// sanitize de 10MB que en aislado tarda ~150ms puede trepar a >500ms por CPU
// contention. El umbral 2000ms es 13x más rápido que un O(n²) catastrófico
// (que tardaría >>30s en 10MB), así que cubre la regresión que el test quería
// atajar pero tolera la variabilidad del entorno paralelo del tester.
// =============================================================================

test('performance: 10MB adversarial sin catastrophic backtracking', () => {
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
    // Umbral generoso (2000ms) para tolerar concurrencia del runner;
    // catastrophic backtracking sería >>10s, así que igual lo cazamos.
    assert.ok(elapsed < 2000, `elapsed=${elapsed}ms (sospecha de catastrophic backtracking)`);
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

// =============================================================================
// Multi-provider LLM API keys (issue #3073, S2 multi-provider)
//
// Cobertura: Anthropic, OpenAI clásico, OpenAI project, Google OAuth access.
// Tests exigidos por security review (#3073 → comentario "Análisis de
// seguridad"): positivos por proveedor, orden mixto, prefijo malicioso,
// idempotencia, chunk-split, anti-bypass, panic dump, falso positivo en
// código legítimo.
// =============================================================================

// Secretos ficticios (forma correcta, ninguno es real).
const FAKE_ANTHROPIC = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH_-AAAA';
const FAKE_ANTHROPIC_SID = 'sk-ant-sid01-IIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP_xx';
const FAKE_OPENAI_CLASSIC = 'sk-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL'; // 48 chars after sk-
const FAKE_OPENAI_PROJECT = 'sk-proj-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ_KKKK';
const FAKE_GOOGLE_OAUTH_ACCESS = 'ya29.A0AfH6SMBAAAABBBBCCCCDDDDEEEEFFFFGGGG';

// ─── Positivos por proveedor (CA1 + CA2 del PO) ─────────────────────────────

test('ANTHROPIC_KEY positivo: sk-ant-api03-... redacted con placeholder propio', () => {
    const out = sanitize(`token=${FAKE_ANTHROPIC}`);
    assert.ok(out.includes('[REDACTED:ANTHROPIC_KEY]'), `out=${out}`);
    assert.ok(!out.includes(FAKE_ANTHROPIC), `leak: ${out}`);
});

test('ANTHROPIC_KEY positivo: variante sid01 (admin)', () => {
    const out = sanitize(`x=${FAKE_ANTHROPIC_SID}`);
    assert.ok(out.includes('[REDACTED:ANTHROPIC_KEY]'), `out=${out}`);
    assert.ok(!out.includes(FAKE_ANTHROPIC_SID));
});

test('OPENAI_PROJECT_KEY positivo: sk-proj-... redacted', () => {
    const out = sanitize(`OPENAI_API_KEY ${FAKE_OPENAI_PROJECT}`);
    assert.ok(out.includes('[REDACTED:OPENAI_PROJECT_KEY]'), `out=${out}`);
    assert.ok(!out.includes(FAKE_OPENAI_PROJECT));
});

test('OPENAI_KEY positivo: sk-<48 chars> clásico redacted', () => {
    const out = sanitize(`bearer ${FAKE_OPENAI_CLASSIC}`);
    assert.ok(out.includes('[REDACTED:OPENAI_KEY]'), `out=${out}`);
    assert.ok(!out.includes(FAKE_OPENAI_CLASSIC));
});

test('GOOGLE_OAUTH_TOKEN positivo: ya29.... redacted', () => {
    const out = sanitize(`access_token=${FAKE_GOOGLE_OAUTH_ACCESS}`);
    assert.ok(out.includes('[REDACTED:GOOGLE_OAUTH_TOKEN]'), `out=${out}`);
    assert.ok(!out.includes(FAKE_GOOGLE_OAUTH_ACCESS));
});

// ─── Orden mixto (test crítico exigido por security punto 4) ────────────────

test('orden: sk-ant-... y sk-... clásico se redactan con sus placeholders distintos', () => {
    const input = `key1=${FAKE_ANTHROPIC} key2=${FAKE_OPENAI_CLASSIC}`;
    const out = sanitize(input);
    // Ambos placeholders presentes
    assert.ok(out.includes('[REDACTED:ANTHROPIC_KEY]'), `falta ANTHROPIC_KEY: ${out}`);
    assert.ok(out.includes('[REDACTED:OPENAI_KEY]'), `falta OPENAI_KEY: ${out}`);
    // Ningún leak
    assert.ok(!out.includes(FAKE_ANTHROPIC), `leak Anthropic: ${out}`);
    assert.ok(!out.includes(FAKE_OPENAI_CLASSIC), `leak OpenAI: ${out}`);
    // Forensia: el orden en el output preserva el orden del input
    const idxAnt = out.indexOf('[REDACTED:ANTHROPIC_KEY]');
    const idxOai = out.indexOf('[REDACTED:OPENAI_KEY]');
    assert.ok(idxAnt < idxOai, `orden invertido: ant=${idxAnt} oai=${idxOai}`);
});

test('orden: sk-proj-... antes que sk-... clásico no se confunden', () => {
    const input = `${FAKE_OPENAI_PROJECT} | ${FAKE_OPENAI_CLASSIC}`;
    const out = sanitize(input);
    assert.ok(out.includes('[REDACTED:OPENAI_PROJECT_KEY]'), `falta OPENAI_PROJECT_KEY: ${out}`);
    assert.ok(out.includes('[REDACTED:OPENAI_KEY]'), `falta OPENAI_KEY: ${out}`);
    assert.ok(!out.includes('[REDACTED:OPENAI_KEY] '));  // sólo una vez
});

test('orden: input con los 4 providers a la vez, cada uno con su placeholder', () => {
    const input = [
        `anth=${FAKE_ANTHROPIC}`,
        `oai_proj=${FAKE_OPENAI_PROJECT}`,
        `oai=${FAKE_OPENAI_CLASSIC}`,
        `goog=${FAKE_GOOGLE_OAUTH_ACCESS}`,
    ].join(' ');
    const out = sanitize(input);
    assert.ok(out.includes('[REDACTED:ANTHROPIC_KEY]'));
    assert.ok(out.includes('[REDACTED:OPENAI_PROJECT_KEY]'));
    assert.ok(out.includes('[REDACTED:OPENAI_KEY]'));
    assert.ok(out.includes('[REDACTED:GOOGLE_OAUTH_TOKEN]'));
    assert.ok(!out.includes(FAKE_ANTHROPIC));
    assert.ok(!out.includes(FAKE_OPENAI_PROJECT));
    assert.ok(!out.includes(FAKE_OPENAI_CLASSIC));
    assert.ok(!out.includes(FAKE_GOOGLE_OAUTH_ACCESS));
});

// ─── Prefijo malicioso (test exigido por security punto 5) ──────────────────

test('prefijo malicioso: sk-ant-AAA (corto) NO matchea ningún placeholder', () => {
    const out = sanitize('debug: sk-ant-AAA observed');
    assert.ok(!out.includes('[REDACTED:ANTHROPIC_KEY]'), `falso positivo: ${out}`);
    assert.ok(!out.includes('[REDACTED:OPENAI_KEY]'), `falso positivo: ${out}`);
    assert.ok(!out.includes('[REDACTED:OPENAI_PROJECT_KEY]'), `falso positivo: ${out}`);
});

test('prefijo malicioso: sk-proj-AAA (corto) NO matchea ningún placeholder', () => {
    const out = sanitize('id=sk-proj-AAA');
    assert.ok(!out.includes('[REDACTED:OPENAI_PROJECT_KEY]'), `falso positivo: ${out}`);
    assert.ok(!out.includes('[REDACTED:OPENAI_KEY]'), `falso positivo: ${out}`);
});

test('prefijo malicioso: sk-AAAA (4 chars) NO matchea OpenAI clásico', () => {
    const out = sanitize('css class sk-AAAA-button');
    assert.ok(!out.includes('[REDACTED:OPENAI_KEY]'), `falso positivo: ${out}`);
});

// ─── Falsos positivos sobre código legítimo (security punto 3) ──────────────

test('no falso positivo: clase CSS Tailwind sk-button-primary', () => {
    const out = sanitize('<div class="sk-button-primary">click</div>');
    assert.ok(!out.includes('[REDACTED:OPENAI_KEY]'), `falso positivo: ${out}`);
    assert.ok(!out.includes('[REDACTED:ANTHROPIC_KEY]'), `falso positivo: ${out}`);
    assert.ok(out.includes('sk-button-primary'), `texto removido sin razón: ${out}`);
});

test('no falso positivo: identificador interno claude_session_id', () => {
    const out = sanitize('const claude_session_id = "abc123"');
    assert.ok(!out.includes('[REDACTED:'), `falso positivo: ${out}`);
});

test('no falso positivo: slug SEO sk-thumbnail-default', () => {
    const out = sanitize('GET /static/sk-thumbnail-default.png HTTP/1.1');
    assert.ok(!out.includes('[REDACTED:OPENAI_KEY]'), `falso positivo: ${out}`);
});

test('no falso positivo: prefijo ya29 sin punto (sólo "ya29" suelto)', () => {
    const out = sanitize('build version ya29 release');
    assert.ok(!out.includes('[REDACTED:GOOGLE_OAUTH_TOKEN]'));
});

test('no falso positivo: id alfanumérico de 48 chars que empieza con sk-', () => {
    // El charset de OPENAI_KEY excluye `_-`, así que un id con guiones medios
    // no matchea aunque tenga 48+ chars de longitud total.
    const out = sanitize('build-id sk-ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ01-2345-6789-ABCD');
    assert.ok(!out.includes('[REDACTED:OPENAI_KEY]'), `falso positivo: ${out}`);
});

// ─── Idempotencia con providers nuevos (security punto §6.5) ────────────────

test('idempotencia multi-provider: doble pasada no altera placeholders', () => {
    const input = [
        `anth=${FAKE_ANTHROPIC}`,
        `oai_proj=${FAKE_OPENAI_PROJECT}`,
        `oai=${FAKE_OPENAI_CLASSIC}`,
        `goog=${FAKE_GOOGLE_OAUTH_ACCESS}`,
    ].join(' ');
    const once = sanitize(input);
    const twice = sanitize(once);
    assert.strictEqual(once, twice, 'idempotencia rota');
});

// ─── Anti-bypass: ZWSP en medio de sk-ant- ──────────────────────────────────

test('bypass ZWSP en sk-ant-: se redacta igual (NFC + zero-width strip)', () => {
    const zwsp = '​';
    const poisoned = `sk-${zwsp}ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH_-AAAA`;
    const out = sanitize(poisoned);
    assert.ok(out.includes('[REDACTED:ANTHROPIC_KEY]'), `out=${out}`);
});

// ─── Stream chunk-split (CA4 del PO) ────────────────────────────────────────

test('stream-filter: sk-ant-... partido en 2 chunks se redacta', async () => {
    const input = `header line\nsecret prefix ${FAKE_ANTHROPIC} suffix\ntail line\n`;
    // Forzamos el split en el medio del token Anthropic.
    const splitAt = input.indexOf('sk-ant-') + 4;  // dentro del prefijo
    const chunks = [input.slice(0, splitAt), input.slice(splitAt)];
    const stream = createSanitizeStream({ minBufferBytes: 256 });
    let out = '';
    stream.on('data', (d) => { out += d.toString(); });
    for (const c of chunks) stream.write(c);
    await new Promise((resolve, reject) => {
        stream.end();
        stream.on('end', resolve);
        stream.on('error', reject);
    });
    assert.ok(out.includes('[REDACTED:ANTHROPIC_KEY]'), `out=${out}`);
    assert.ok(!out.includes(FAKE_ANTHROPIC), `leak: ${out}`);
});

test('stream-filter: ya29.... partido en 3 chunks se redacta', async () => {
    const input = `pre ${FAKE_GOOGLE_OAUTH_ACCESS} post\n`;
    const chunks = [input.slice(0, 8), input.slice(8, 16), input.slice(16)];
    const stream = createSanitizeStream({ minBufferBytes: 256 });
    let out = '';
    stream.on('data', (d) => { out += d.toString(); });
    for (const c of chunks) stream.write(c);
    await new Promise((r) => { stream.end(); stream.on('end', r); });
    assert.ok(out.includes('[REDACTED:GOOGLE_OAUTH_TOKEN]'), `out=${out}`);
    assert.ok(!out.includes(FAKE_GOOGLE_OAUTH_ACCESS), `leak: ${out}`);
});

// ─── Panic dump simulado (security punto §2 "Adversarial: dump del CLI") ────

test('panic dump simulado: stack trace con sk-ant-... como string literal', () => {
    const stack = [
        'Error: 401 Unauthorized',
        '    at processResponse (provider/anthropic.js:42:13)',
        `    at validate(token = "${FAKE_ANTHROPIC}")`,
        '    at <anonymous>',
    ].join('\n');
    const out = sanitize(stack);
    assert.ok(out.includes('[REDACTED:ANTHROPIC_KEY]'), `out=${out}`);
    assert.ok(!out.includes(FAKE_ANTHROPIC), `leak en stack: ${out}`);
});

test('panic dump simulado: header x-api-key con sk-ant-... cae en HEADER_X_API_KEY genérico', () => {
    // Comportamiento aceptado (security punto §9): el patrón estructural de
    // header redacta primero. El secreto NO leakea, sólo pierde el detalle
    // de provider — aceptable y documentado.
    const out = sanitize(`x-api-key: ${FAKE_ANTHROPIC}\n`);
    assert.ok(out.includes('[REDACTED:API_KEY]') || out.includes('[REDACTED:ANTHROPIC_KEY]'));
    assert.ok(!out.includes(FAKE_ANTHROPIC), `leak en header: ${out}`);
});

test('panic dump simulado: apiKey="sk-ant-..." cae con placeholder específico', () => {
    // El patrón ANTHROPIC_KEY corre antes que CONF_STRUCTURED, así que el
    // valor queda con placeholder por proveedor — preserva forensia.
    const input = `apiKey="${FAKE_ANTHROPIC}"`;
    const out = sanitize(input);
    assert.ok(out.includes('[REDACTED:ANTHROPIC_KEY]'), `out=${out}`);
    assert.ok(!out.includes(FAKE_ANTHROPIC));
});

// ─── run ────────────────────────────────────────────────────────────────────
runAll().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
});
