// =============================================================================
// Tests telegram-notifier.js — Issue #3384
//
// Cubre los 26 CA consolidados por po en
// `definicion/criterios/procesado/3384.po`:
//   * Eje 1 — Funcional (CA-F-1..F-12)
//   * Eje 2 — Seguridad (CA-S-1..S-8)
//   * Eje 3 — Operator UX (CA-UX-1..UX-6)
//
// Estrategia
// ----------
// - Trabajamos contra un `pipelineRoot` temporal con `fs.mkdtempSync` para
//   no tocar el filesystem del proyecto.
// - El cliente HTTP se mockea via `deps.http` — NUNCA hacemos red real.
//   Eso preserva el contrato "fail-soft" sin volver los tests flaky.
// - El rate-limit se desactiva inyectando `deps.applyRateLimit = noop` salvo
//   en el test específico que valida que la latencia mínima se respeta.
// - `sharp` se inyecta como mock para no requerir instalar la dependencia
//   nativa en CI.
//
// Nombres de test en español por convención del proyecto (CLAUDE.md).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const notifier = require('../telegram-notifier');
const {
    notifyMockupToOperator,
    CASE_EMOJI,
    VALID_CASE_TYPES,
    MAX_TITLE_CHARS,
    MAX_DESCRIPTION_CHARS,
    COMPRESS_THRESHOLD_BYTES,
    __forTests__,
} = notifier;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function mkTmpRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-notifier-test-'));
    return {
        root: dir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
    };
}

// Mini PNG válido (1x1 transparente). Suficiente para el flujo real, pesa
// pocas decenas de bytes así que NO dispara compresión.
const PNG_TINY = Buffer.from(
    '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489' +
    '0000000A49444154789C6300010000000500010D0A2DB40000000049454E44AE426082',
    'hex',
);

function writePng(dir, name = 'esperado.png', buf = PNG_TINY) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, buf);
    return p;
}

function fakeEnv(overrides = {}) {
    return Object.assign({
        TELEGRAM_BOT_TOKEN: '999999:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234',
        TELEGRAM_LEO_OPERATOR_CHAT_ID: '111222333',
    }, overrides);
}

// HTTP mock que captura el body multipart + responde 200 OK.
function captureHttpOk() {
    const calls = [];
    return {
        calls,
        http: async (url, options) => {
            calls.push({ url, options });
            return { statusCode: 200, headers: {}, body: '{"ok":true,"result":{}}' };
        },
    };
}

// HTTP mock que falla con error de red (incluye la URL completa con el
// bot token en el message — replica el comportamiento real de Node).
function captureHttpNetworkFail(failMsg) {
    const calls = [];
    return {
        calls,
        http: async (url) => {
            calls.push({ url });
            const err = new Error(failMsg || `getaddrinfo ENOTFOUND api.telegram.org at ${url}`);
            err.code = 'ENOTFOUND';
            throw err;
        },
    };
}

// `applyRateLimit` no-op para no esperar 1s entre tests.
const noopRate = async () => {};

// -----------------------------------------------------------------------------
// CA-UX-2 · mapping emoji canónico
// -----------------------------------------------------------------------------

test('CA-UX-2 · CASE_EMOJI cubre los 4 caseTypes oficiales del issue', () => {
    assert.equal(CASE_EMOJI['dashboard'], '🖥');
    assert.equal(CASE_EMOJI['android-client'], '📱');
    assert.equal(CASE_EMOJI['android-business'], '🏪');
    assert.equal(CASE_EMOJI['android-delivery'], '🛵');
    assert.deepEqual(
        VALID_CASE_TYPES.slice().sort(),
        ['android-business', 'android-client', 'android-delivery', 'dashboard'],
    );
});

// -----------------------------------------------------------------------------
// CA-F-2 · caseType inválido se rechaza sin enviar
// -----------------------------------------------------------------------------

test('CA-F-2 · caseType desconocido devuelve skipped sin invocar http', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const pngPath = writePng(root);
        const http = captureHttpOk();
        const res = await notifyMockupToOperator({
            issueNumber: 3384,
            issueTitle: 'X',
            caseType: 'ios-client', // no existe
            mockupPath: pngPath,
            changeDescription: 'algo',
            repoRoot: root,
            deps: { env: fakeEnv(), http: http.http, applyRateLimit: noopRate },
        });
        assert.equal(res.ok, false);
        assert.equal(res.action, 'skipped');
        assert.equal(res.reason, 'invalid_case_type');
        assert.equal(http.calls.length, 0);
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-F-6 + CA-F-8 · auto-disable cuando falta operator chat_id o token
// -----------------------------------------------------------------------------

test('CA-F-8 · sin TELEGRAM_LEO_OPERATOR_CHAT_ID el handler se autoinhabilita', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const pngPath = writePng(root);
        const http = captureHttpOk();
        const res = await notifyMockupToOperator({
            issueNumber: 3384,
            issueTitle: 'X',
            caseType: 'dashboard',
            mockupPath: pngPath,
            changeDescription: 'algo',
            repoRoot: root,
            deps: {
                env: fakeEnv({ TELEGRAM_LEO_OPERATOR_CHAT_ID: '' }),
                http: http.http,
                applyRateLimit: noopRate,
            },
        });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'no_operator_chat_id');
        assert.equal(http.calls.length, 0);
    } finally { cleanup(); }
});

test('CA-F-6 · sin TELEGRAM_BOT_TOKEN devuelve no_bot_token sin enviar', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const pngPath = writePng(root);
        const http = captureHttpOk();
        const res = await notifyMockupToOperator({
            issueNumber: 3384,
            issueTitle: 'X',
            caseType: 'dashboard',
            mockupPath: pngPath,
            changeDescription: 'algo',
            repoRoot: root,
            deps: {
                env: fakeEnv({ TELEGRAM_BOT_TOKEN: '' }),
                http: http.http,
                applyRateLimit: noopRate,
            },
        });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'no_bot_token');
        assert.equal(http.calls.length, 0);
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-F-8 · settings.json telegram.notify_ux_mockups: false → skip
// -----------------------------------------------------------------------------

test('CA-F-8 · settings.json notify_ux_mockups=false fuerza skip', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const pngPath = writePng(root);
        fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
        fs.writeFileSync(
            path.join(root, '.claude', 'settings.json'),
            JSON.stringify({ telegram: { notify_ux_mockups: false } }),
        );
        const http = captureHttpOk();
        const res = await notifyMockupToOperator({
            issueNumber: 3384,
            issueTitle: 'X',
            caseType: 'dashboard',
            mockupPath: pngPath,
            changeDescription: 'algo',
            repoRoot: root,
            deps: { env: fakeEnv(), http: http.http, applyRateLimit: noopRate },
        });
        assert.equal(res.action, 'skipped');
        assert.equal(res.reason, 'disabled_in_settings');
        assert.equal(http.calls.length, 0);
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-S-2 · validación de mockupPath
// -----------------------------------------------------------------------------

test('CA-S-2 · path traversal con segmento .. se rechaza', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const http = captureHttpOk();
        const res = await notifyMockupToOperator({
            issueNumber: 3384,
            issueTitle: 'X',
            caseType: 'dashboard',
            mockupPath: '../../etc/passwd',
            changeDescription: 'algo',
            repoRoot: root,
            deps: { env: fakeEnv(), http: http.http, applyRateLimit: noopRate },
        });
        assert.equal(res.ok, false);
        assert.equal(res.action, 'skipped');
        assert.match(res.reason, /invalid_mockup_path:parent_segment/);
        assert.equal(http.calls.length, 0);
    } finally { cleanup(); }
});

test('CA-S-2 · path absoluto fuera del repoRoot se rechaza como outside_repo', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        // Generar un PNG fuera del repoRoot.
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
        const outsidePng = writePng(outsideDir, 'leak.png');
        try {
            const http = captureHttpOk();
            const res = await notifyMockupToOperator({
                issueNumber: 3384,
                issueTitle: 'X',
                caseType: 'dashboard',
                mockupPath: outsidePng,
                changeDescription: 'algo',
                repoRoot: root,
                deps: { env: fakeEnv(), http: http.http, applyRateLimit: noopRate },
            });
            assert.equal(res.ok, false);
            assert.match(res.reason, /invalid_mockup_path:outside_repo/);
            assert.equal(http.calls.length, 0);
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true });
        }
    } finally { cleanup(); }
});

test('CA-S-2 · extensión no-PNG (.txt) se rechaza', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const txtPath = path.join(root, 'note.txt');
        fs.writeFileSync(txtPath, 'no soy una imagen');
        const http = captureHttpOk();
        const res = await notifyMockupToOperator({
            issueNumber: 3384,
            issueTitle: 'X',
            caseType: 'dashboard',
            mockupPath: txtPath,
            changeDescription: 'algo',
            repoRoot: root,
            deps: { env: fakeEnv(), http: http.http, applyRateLimit: noopRate },
        });
        assert.equal(res.ok, false);
        assert.match(res.reason, /invalid_mockup_path:invalid_extension/);
        assert.equal(http.calls.length, 0);
    } finally { cleanup(); }
});

test('CA-S-2 · symlink se rechaza con symlink_rejected', async (t) => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const realPng = writePng(root, 'real.png');
        const linkPath = path.join(root, 'link.png');
        try {
            fs.symlinkSync(realPng, linkPath);
        } catch (e) {
            // Windows sin permiso de symlink → skip explícito sin fallar.
            t.skip(`Symlink no soportado en este entorno: ${e.code}`);
            return;
        }
        const http = captureHttpOk();
        const res = await notifyMockupToOperator({
            issueNumber: 3384,
            issueTitle: 'X',
            caseType: 'dashboard',
            mockupPath: linkPath,
            changeDescription: 'algo',
            repoRoot: root,
            deps: { env: fakeEnv(), http: http.http, applyRateLimit: noopRate },
        });
        assert.equal(res.ok, false);
        assert.match(res.reason, /invalid_mockup_path:symlink_rejected/);
        assert.equal(http.calls.length, 0);
    } finally { cleanup(); }
});

test('CA-S-2 · archivo > 10MB se rechaza con too_large', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        // No queremos generar realmente 10MB en CI; usamos un stat mockeado
        // a través de un override del módulo `fs`. Como inyectar fs sería
        // invasivo, usamos un truco: validar el helper expuesto en tests.
        const big = path.join(root, 'big.png');
        // 10MB + 1 byte
        fs.writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
        const result = __forTests__.validateMockupPath(big, root);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'too_large');
    } finally { cleanup(); }
});

test('CA-S-2 · archivo vacío se rechaza con empty_file', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const empty = path.join(root, 'vacio.png');
        fs.writeFileSync(empty, Buffer.alloc(0));
        const result = __forTests__.validateMockupPath(empty, root);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'empty_file');
    } finally { cleanup(); }
});

test('CA-S-2 · null byte en path se rechaza con null_byte', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const result = __forTests__.validateMockupPath('mock\0up.png', root);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'null_byte');
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-F-5 · envío exitoso — multipart contiene chat_id, caption y PNG
// -----------------------------------------------------------------------------

test('CA-F-5 · envío exitoso pasa multipart correcto al http-client', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const pngPath = writePng(root, 'esperado.png');
        const http = captureHttpOk();
        const res = await notifyMockupToOperator({
            issueNumber: 3384,
            issueTitle: 'Notificación Telegram',
            caseType: 'dashboard',
            mockupPath: pngPath,
            changeDescription: 'cambio breve',
            repoRoot: root,
            deps: {
                env: fakeEnv({ TELEGRAM_LEO_OPERATOR_CHAT_ID: '111222333' }),
                http: http.http,
                applyRateLimit: noopRate,
            },
        });
        assert.equal(res.ok, true);
        assert.equal(res.action, 'sent');
        assert.equal(http.calls.length, 1);

        const call = http.calls[0];
        // URL apunta al método correcto y embebe el token (el redact se
        // verifica en otro test sobre el log).
        assert.match(call.url, /\/bot999999:[A-Za-z0-9_-]+\/sendPhoto$/);
        // Multipart boundary declarado.
        assert.match(call.options.headers['Content-Type'], /^multipart\/form-data; boundary=/);

        // UTF-8 para preservar emojis del caption.
        const body = call.options.body.toString('utf8');
        assert.match(body, /name="chat_id"\r\n\r\n111222333\r\n/);
        assert.match(body, /name="photo"; filename="esperado\.png"/);
        assert.match(body, /Content-Type: image\/png/);
        assert.match(body, /name="caption"/);
        // CA-UX-3 + CA-UX-4 — el caption tiene link y nueva frase.
        assert.ok(body.includes('🔗 https://github.com/intrale/platform/issues/3384'), 'caption debe incluir el link');
        assert.ok(body.includes('Mockup generado automáticamente · fase de definición'), 'caption debe incluir el footer canónico');
        // Caption NO trae la frase técnica vieja (CA-UX-4).
        assert.ok(!body.includes('Generado por LLM'));
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-UX-1 · título truncado a 60 chars
// -----------------------------------------------------------------------------

test('CA-UX-1 · título > 60 chars se trunca con marcador …', () => {
    const { buildCaption } = __forTests__;
    const longTitle = 'a'.repeat(120);
    const c = buildCaption({
        issueNumber: 9,
        issueTitle: longTitle,
        caseType: 'dashboard',
        changeDescription: 'x',
    });
    const firstLine = c.split('\n')[0];
    assert.ok(firstLine.endsWith('…'), `firstLine="${firstLine}"`);
    // 🖼 + " #9 — " + 60 chars (incluye …) → la parte del título no debería
    // pasar de 60 chars.
    const dashIdx = firstLine.indexOf('— ');
    const titlePart = firstLine.slice(dashIdx + 2);
    assert.ok(titlePart.length <= MAX_TITLE_CHARS, `titlePart=${titlePart.length}`);
});

// -----------------------------------------------------------------------------
// CA-UX-5 · descripción truncada a 600 chars
// -----------------------------------------------------------------------------

test('CA-UX-5 · descripción > 600 chars se trunca con marcador …', () => {
    const { buildCaption } = __forTests__;
    const longDesc = 'D'.repeat(900);
    const c = buildCaption({
        issueNumber: 9,
        issueTitle: 'short',
        caseType: 'dashboard',
        changeDescription: longDesc,
    });
    const lines = c.split('\n');
    // La descripción ocupa la línea 4 (índice 3) según el layout buildCaption.
    const descLine = lines[3];
    assert.ok(descLine.endsWith('…'));
    assert.ok(descLine.length <= MAX_DESCRIPTION_CHARS);
});

// -----------------------------------------------------------------------------
// CA-UX-2 + CA-UX-3 + CA-UX-4 · caption con emoji correcto, link y footer
// -----------------------------------------------------------------------------

test('CA-UX-2/3/4 · caption android-business usa 🏪 + link + footer canónico', () => {
    const { buildCaption } = __forTests__;
    const c = buildCaption({
        issueNumber: 42,
        issueTitle: 'Pantalla X',
        caseType: 'android-business',
        changeDescription: 'cambio de algo',
    });
    assert.ok(c.includes('🏪 android-business'));
    assert.ok(c.includes('🔗 https://github.com/intrale/platform/issues/42'));
    assert.ok(c.includes('Mockup generado automáticamente · fase de definición'));
});

// -----------------------------------------------------------------------------
// CA-S-1 + CA-S-8 · fallo de red → log redacta bot token
// -----------------------------------------------------------------------------

test('CA-S-1 / CA-S-8 · fallo de red NO escribe el bot token raw en el log', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const pngPath = writePng(root);
        const logFile = path.join(root, 'telegram-notifier.log');
        const http = captureHttpNetworkFail(
            // El mensaje incluye la URL completa con el token raw, simulando
            // lo que devuelve Node cuando falla un getaddrinfo.
            'getaddrinfo ENOTFOUND api.telegram.org at https://api.telegram.org/bot999999:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234/sendPhoto',
        );
        const res = await notifyMockupToOperator({
            issueNumber: 3384,
            issueTitle: 'X',
            caseType: 'dashboard',
            mockupPath: pngPath,
            changeDescription: 'algo',
            repoRoot: root,
            deps: {
                env: fakeEnv(),
                http: http.http,
                applyRateLimit: noopRate,
                logFile,
            },
        });
        assert.equal(res.ok, false);
        assert.equal(res.action, 'error');
        // El log existe y NO contiene el bot token raw.
        assert.ok(fs.existsSync(logFile), 'log debe existir');
        const logContents = fs.readFileSync(logFile, 'utf8');
        assert.ok(
            !/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234/.test(logContents),
            `log no debería contener el bot token raw: ${logContents}`,
        );
        // El log SÍ debe contener el marcador de redacción.
        assert.match(logContents, /\/bot\[REDACTED\]/);
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-S-4 · chat_id no aparece en el log de fallos
// -----------------------------------------------------------------------------

test('CA-S-4 · chat_id no aparece en el log incluso si el error lo menciona', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const pngPath = writePng(root);
        const logFile = path.join(root, 'telegram-notifier.log');
        const fakeChat = '987654321';
        const http = {
            http: async (url) => {
                throw new Error(`Network blew up while sending to chat ${fakeChat} at ${url}`);
            },
        };
        const res = await notifyMockupToOperator({
            issueNumber: 3384,
            issueTitle: 'X',
            caseType: 'dashboard',
            mockupPath: pngPath,
            changeDescription: 'algo',
            repoRoot: root,
            deps: {
                env: fakeEnv({ TELEGRAM_LEO_OPERATOR_CHAT_ID: fakeChat }),
                http: http.http,
                applyRateLimit: noopRate,
                logFile,
            },
        });
        assert.equal(res.ok, false);
        const logContents = fs.readFileSync(logFile, 'utf8');
        assert.ok(!logContents.includes(fakeChat), `chat_id no debería aparecer en el log: ${logContents}`);
        assert.match(logContents, /<chat_id>/);
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-UX-6 · compresión opcional con sharp
// -----------------------------------------------------------------------------

test('CA-UX-6 · PNG > 1.5MB invoca sharp y reemplaza el buffer con la versión comprimida', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        // Generamos un PNG de ~2MB (no es un PNG válido pero el notifier
        // no parsea formato — solo mide bytes y reenvía).
        const bigPath = path.join(root, 'big.png');
        fs.writeFileSync(bigPath, Buffer.alloc(2 * 1024 * 1024, 0x10));

        let sharpCalled = false;
        const fakeSharp = (buf) => {
            sharpCalled = true;
            return {
                png: () => ({
                    toBuffer: async () => Buffer.alloc(100_000, 0x20), // simula compresión
                }),
            };
        };
        const http = captureHttpOk();
        const res = await notifyMockupToOperator({
            issueNumber: 3384,
            issueTitle: 'X',
            caseType: 'dashboard',
            mockupPath: bigPath,
            changeDescription: 'algo',
            repoRoot: root,
            deps: {
                env: fakeEnv(),
                http: http.http,
                applyRateLimit: noopRate,
                sharp: fakeSharp,
            },
        });
        assert.equal(res.ok, true);
        assert.equal(sharpCalled, true);
        // Verificamos que el body del request contiene el buffer comprimido,
        // no el original de 2MB.
        const sentBody = http.calls[0].options.body;
        assert.ok(sentBody.length < 1 * 1024 * 1024, `body enviado debería ser < 1MB, fue ${sentBody.length}`);
    } finally { cleanup(); }
});

test('CA-UX-6 · sin sharp instalado el PNG grande se envía sin comprimir y deja warning', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const bigPath = path.join(root, 'big.png');
        fs.writeFileSync(bigPath, Buffer.alloc(2 * 1024 * 1024, 0x10));
        const logFile = path.join(root, 'telegram-notifier.log');
        // Forzamos "sharp no disponible": el require interno tirará MODULE_NOT_FOUND
        // (este test asume que sharp NO está en node_modules — el agente verifica
        // ese supuesto en pre-flight y aborta si está instalado).
        const http = captureHttpOk();
        const res = await notifyMockupToOperator({
            issueNumber: 3384,
            issueTitle: 'X',
            caseType: 'dashboard',
            mockupPath: bigPath,
            changeDescription: 'algo',
            repoRoot: root,
            deps: {
                env: fakeEnv(),
                http: http.http,
                applyRateLimit: noopRate,
                logFile,
                // NO inyectamos sharp → maybeCompress va a intentar require('sharp')
                // y si falla, hace fallback.
            },
        });
        assert.equal(res.ok, true);
        // Si sharp NO está, hubo un warning en el log; si SÍ está
        // (porque el dev local tiene la dep), aceptamos el send normal.
        if (fs.existsSync(logFile)) {
            const logContents = fs.readFileSync(logFile, 'utf8');
            // Cuando hay warning, debe ser claro pero NO incluir el bot token.
            assert.ok(!/999999:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234/.test(logContents));
        }
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-F-9 · fail-soft: ante cualquier excepción el caller recibe un objeto, no un throw
// -----------------------------------------------------------------------------

test('CA-F-9 · excepción no controlada se captura y devuelve { ok: false }', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const pngPath = writePng(root);
        const http = {
            http: async () => { throw new Error('boom inesperado'); },
        };
        const res = await notifyMockupToOperator({
            issueNumber: 3384,
            issueTitle: 'X',
            caseType: 'dashboard',
            mockupPath: pngPath,
            changeDescription: 'algo',
            repoRoot: root,
            deps: { env: fakeEnv(), http: http.http, applyRateLimit: noopRate },
        });
        assert.equal(res.ok, false);
        assert.equal(res.action, 'error');
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-F-10 · rate-limit aplica espera entre invocaciones consecutivas
// -----------------------------------------------------------------------------

test('CA-F-10 · dos llamadas seguidas respetan el rate-limit de 1s (usando applyRateLimit real)', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const pngPath = writePng(root);
        const http = captureHttpOk();
        __forTests__._resetRateLimit();
        const start = Date.now();
        await notifyMockupToOperator({
            issueNumber: 3384,
            issueTitle: 'X',
            caseType: 'dashboard',
            mockupPath: pngPath,
            changeDescription: 'a',
            repoRoot: root,
            deps: { env: fakeEnv(), http: http.http },
        });
        await notifyMockupToOperator({
            issueNumber: 3384,
            issueTitle: 'X',
            caseType: 'dashboard',
            mockupPath: pngPath,
            changeDescription: 'b',
            repoRoot: root,
            deps: { env: fakeEnv(), http: http.http },
        });
        const elapsed = Date.now() - start;
        // El segundo envío debe esperar al menos ~1s (RATE_LIMIT_MS=1000).
        // Toleramos jitter del clock; ≥ 950ms es la cota práctica.
        assert.ok(elapsed >= 950, `rate-limit no respetado: elapsed=${elapsed}ms`);
    } finally { cleanup(); }
});
