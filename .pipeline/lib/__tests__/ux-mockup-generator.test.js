// =============================================================================
// ux-mockup-generator.test.js — Tests unitarios (#3381 · CA-21 / CA-UX-*)
//
// Cobertura:
//   - loadDesignTokens: parse OK + fallback con warning.
//   - buildPrompt: incluye reglas (CA-UX-1/2/3), tokens (CA-UX-4), estado (CA-UX-6).
//   - extractHtml: fence ```html```, fallback DOCTYPE pelado.
//   - generate: abort conditions (sdk-missing, missing-credentials), happy path
//     con fakes inyectados.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ux = require('../ux-mockup-generator');

// -----------------------------------------------------------------------------
// loadDesignTokens
// -----------------------------------------------------------------------------

test('loadDesignTokens: lee y parsea tokens.json válido', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-test-'));
    fs.mkdirSync(path.join(tmp, 'docs', 'design-system'), { recursive: true });
    fs.writeFileSync(
        path.join(tmp, 'docs', 'design-system', 'tokens.json'),
        JSON.stringify({ palette: { primary: '#abc' } }),
    );
    const { tokens, warning } = ux.loadDesignTokens(tmp);
    assert.deepEqual(tokens.palette, { primary: '#abc' });
    assert.equal(warning, null);
});

test('loadDesignTokens: archivo ausente devuelve warning (sin throws)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-test-'));
    const { tokens, warning } = ux.loadDesignTokens(tmp);
    assert.equal(tokens, null);
    assert.match(warning, /tokens-not-loaded/);
});

test('loadDesignTokens: JSON inválido devuelve warning', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-test-'));
    fs.mkdirSync(path.join(tmp, 'docs', 'design-system'), { recursive: true });
    fs.writeFileSync(
        path.join(tmp, 'docs', 'design-system', 'tokens.json'),
        '{ not json',
    );
    const { tokens, warning } = ux.loadDesignTokens(tmp);
    assert.equal(tokens, null);
    assert.match(warning, /tokens-not-loaded/);
});

// -----------------------------------------------------------------------------
// buildPrompt — reglas inquebrantables presentes
// -----------------------------------------------------------------------------

test('buildPrompt: incluye reglas inquebrantables completas (CA-UX-1/2/3/10)', () => {
    const prompt = ux.buildPrompt({
        changeDescription: 'Cambiar color del header',
        caseKind: 'dashboard',
        viewport: { width: 1440, height: 900 },
        tokens: null,
    });
    assert.match(prompt, /REGLAS INQUEBRANTABLES/);
    assert.match(prompt, /WCAG AA/);
    assert.match(prompt, /48dp/);
    assert.match(prompt, /Material 3/);
    assert.match(prompt, /HTML\/CSS self-contained/);
});

test('buildPrompt: incluye tokens cuando se pasan', () => {
    const prompt = ux.buildPrompt({
        changeDescription: 'X',
        caseKind: 'android',
        flavor: 'client',
        viewport: { width: 411, height: 891 },
        tokens: { palette: { primary: '#abc' } },
    });
    assert.match(prompt, /"primary": "#abc"/);
    assert.match(prompt, /Material Design 3/);
    assert.match(prompt, /viewport 411x891/);
});

test('buildPrompt: estado != base se documenta (CA-UX-6)', () => {
    const prompt = ux.buildPrompt({
        changeDescription: 'X',
        caseKind: 'android',
        viewport: { width: 411, height: 891 },
        tokens: null,
        state: 'error',
    });
    assert.match(prompt, /Estado a representar: error/);
});

// -----------------------------------------------------------------------------
// extractHtml
// -----------------------------------------------------------------------------

test('extractHtml: extrae contenido del fence ```html```', () => {
    const resp = 'Algo de prefijo\n```html\n<!DOCTYPE html><html><body>X</body></html>\n```\nsufijo';
    const html = ux.extractHtml(resp);
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<\/html>$/);
});

test('extractHtml: fallback acepta HTML pelado sin fence', () => {
    const resp = '<!DOCTYPE html><html><body>X</body></html>';
    const html = ux.extractHtml(resp);
    assert.match(html, /^<!DOCTYPE html>/);
});

test('extractHtml: respuesta vacía o sin html devuelve null', () => {
    assert.equal(ux.extractHtml(''), null);
    assert.equal(ux.extractHtml('solo texto sin html'), null);
    assert.equal(ux.extractHtml(null), null);
});

// -----------------------------------------------------------------------------
// generate: abort conditions
// -----------------------------------------------------------------------------

test('generate: sin API key devuelve missing-credentials', async () => {
    const result = await ux.generate({
        prompt: 'X',
        outputPath: 'a.png',
        repoRoot: '/tmp',
        allowedRoot: '/tmp',
        apiKey: null,
        _requireAnthropic: () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-credentials');
    assert.match(result.detail, /terminal-only/);
});

test('generate: sin SDK devuelve sdk-missing', async () => {
    const result = await ux.generate({
        prompt: 'X',
        outputPath: 'a.png',
        repoRoot: '/tmp',
        allowedRoot: '/tmp',
        apiKey: 'sk-test',
        _requireAnthropic: () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'sdk-missing');
});

test('generate: prompt vacío devuelve empty-prompt', async () => {
    const result = await ux.generate({
        prompt: '',
        outputPath: 'a.png',
        repoRoot: '/tmp',
        allowedRoot: '/tmp',
        apiKey: 'sk-test',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty-prompt');
});

// -----------------------------------------------------------------------------
// generate: happy path con fakes
// -----------------------------------------------------------------------------

function fakeAnthropicClass(htmlResponse) {
    return function FakeAnthropic(opts) {
        this.opts = opts;
        this.messages = {
            create: async (params) => {
                // Verificamos que el SDK reciba temperature 0.3 (CA-UX-11)
                assert.equal(params.temperature, 0.3);
                return {
                    content: [{ text: `\`\`\`html\n${htmlResponse}\n\`\`\`` }],
                    usage: { input_tokens: 100, output_tokens: 200 },
                };
            },
        };
    };
}

// Fake renderer que sí escribe el PNG temporal en outputPath (cumple el
// contrato real del renderer: si ok=true, el archivo existe en outputPath).
function fakeRendererThatWrites(captureRef) {
    return async (opts) => {
        if (captureRef) captureRef.value = opts;
        fs.writeFileSync(opts.outputPath, 'fake-png-bytes');
        return { ok: true, outputPath: opts.outputPath };
    };
}

test('generate: happy path llama SDK con temperature 0.3 y renderiza HTML', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-test-'));
    const ref = { value: null };
    const result = await ux.generate({
        prompt: 'Cambio del header',
        caseKind: 'dashboard',
        outputPath: 'esperado.png',
        repoRoot: tmp,
        allowedRoot: tmp,
        apiKey: 'sk-test',
        _requireAnthropic: () => fakeAnthropicClass('<!DOCTYPE html><html><body>X</body></html>'),
        _renderHtmlToPng: fakeRendererThatWrites(ref),
    });
    assert.equal(result.ok, true);
    assert.match(result.outputPath, /esperado\.png$/);
    assert.equal(result.tokens.input, 100);
    assert.equal(result.tokens.output, 200);
    assert.match(ref.value.html, /<!DOCTYPE html>/);
    // El PNG final existe (rename desde tmpdir funcionó).
    assert.equal(fs.existsSync(result.outputPath), true);
});

test('generate: SDK falla en opus pero éxito en sonnet (fallback CA-5)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-test-'));
    let calls = 0;
    const FakeAnthropic = function () {
        this.messages = {
            create: async (params) => {
                calls++;
                if (params.model === 'claude-opus-4-7') {
                    throw new Error('rate-limit');
                }
                return {
                    content: [{ text: '```html\n<!DOCTYPE html><html><body>x</body></html>\n```' }],
                    usage: { input_tokens: 50, output_tokens: 100 },
                };
            },
        };
    };
    const result = await ux.generate({
        prompt: 'X',
        caseKind: 'dashboard',
        outputPath: 'esperado.png',
        repoRoot: tmp,
        allowedRoot: tmp,
        apiKey: 'sk-test',
        _requireAnthropic: () => FakeAnthropic,
        _renderHtmlToPng: fakeRendererThatWrites(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.model, 'claude-sonnet-4-6');
    assert.equal(calls, 2);
});

test('generate: ambos modelos fallan → llm-failed', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-test-'));
    const FakeAnthropic = function () {
        this.messages = {
            create: async () => { throw new Error('out of quota'); },
        };
    };
    const result = await ux.generate({
        prompt: 'X',
        outputPath: 'esperado.png',
        repoRoot: tmp,
        allowedRoot: tmp,
        apiKey: 'sk-test',
        _requireAnthropic: () => FakeAnthropic,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'llm-failed');
    assert.match(result.detail, /out of quota/);
});

test('generate: respuesta sin HTML devuelve no-html-in-response', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-test-'));
    const FakeAnthropic = function () {
        this.messages = {
            create: async () => ({
                content: [{ text: 'no tengo HTML que mostrarte' }],
                usage: { input_tokens: 10, output_tokens: 5 },
            }),
        };
    };
    const result = await ux.generate({
        prompt: 'X',
        outputPath: 'esperado.png',
        repoRoot: tmp,
        allowedRoot: tmp,
        apiKey: 'sk-test',
        _requireAnthropic: () => FakeAnthropic,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-html-in-response');
});

// =============================================================================
// CA-S3 — Redacción de la API key en errores del SDK (credential safety)
// =============================================================================

test('redactKey: redacta la clave entera del mensaje', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const msg = `auth failed for ${key} please retry`;
    const out = ux.redactKey(msg, key);
    assert.equal(out.includes(key), false);
    assert.match(out, /\[REDACTED-API-KEY\]/);
});

test('redactKey: redacta subcadenas ≥ 8 chars de la clave', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    // El SDK loguea solo parte de la clave (prefijo común de 20 chars).
    const fragment = key.slice(0, 20);
    const msg = `bad key: ${fragment}... [truncated]`;
    const out = ux.redactKey(msg, key);
    assert.equal(out.includes(fragment), false);
    assert.match(out, /\[REDACTED-API-KEY\]/);
});

test('redactKey: NO redacta cuando la clave es null/undefined/corta', () => {
    assert.equal(ux.redactKey('foo bar', null), 'foo bar');
    assert.equal(ux.redactKey('foo bar', undefined), 'foo bar');
    assert.equal(ux.redactKey('foo bar', 'short'), 'foo bar');
    assert.equal(ux.redactKey('foo bar', ''), 'foo bar');
});

test('redactKey: NO toca un mensaje que no contiene la clave', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const msg = 'rate limit exceeded';
    assert.equal(ux.redactKey(msg, key), msg);
});

test('redactKey: tolera msg null/undefined/objeto', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    assert.equal(ux.redactKey(null, key), '');
    assert.equal(ux.redactKey(undefined, key), '');
    assert.equal(typeof ux.redactKey({ foo: 1 }, key), 'string');
});

test('generate: cuando el SDK tira un error con la api key, el detail viene redactado (CA-S3)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-test-'));
    const apiKey = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const FakeAnthropic = function () {
        this.messages = {
            create: async () => {
                throw new Error(`auth failed for ${apiKey}`);
            },
        };
    };
    const result = await ux.generate({
        prompt: 'X',
        outputPath: 'esperado.png',
        repoRoot: tmp,
        allowedRoot: tmp,
        apiKey,
        _requireAnthropic: () => FakeAnthropic,
        // Forzar que sea único intento (sin fallback)
        model: 'claude-sonnet-4-6',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'llm-failed');
    assert.equal(result.detail.includes(apiKey), false);
    assert.match(result.detail, /\[REDACTED-API-KEY\]/);
});

test('generate: ambos modelos fallan con la key en el error → detail redactado (CA-S3)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-test-'));
    const apiKey = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const FakeAnthropic = function () {
        this.messages = {
            create: async (params) => {
                throw new Error(`401 for ${apiKey} on ${params.model}`);
            },
        };
    };
    const result = await ux.generate({
        prompt: 'X',
        outputPath: 'esperado.png',
        repoRoot: tmp,
        allowedRoot: tmp,
        apiKey,
        _requireAnthropic: () => FakeAnthropic,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'llm-failed');
    assert.equal(result.detail.includes(apiKey), false);
    assert.match(result.detail, /opus: .*\[REDACTED-API-KEY\].*\| sonnet: .*\[REDACTED-API-KEY\]/);
});

// =============================================================================
// CA-S4 — Validación del viewport (bounds [320,4096] x [240,8192])
// =============================================================================

test('validateViewport: default 411x891 (Android mdpi) es válido', () => {
    assert.equal(ux.validateViewport(ux.VIEWPORT_ANDROID_MDPI).ok, true);
});

test('validateViewport: default 1440x900 (dashboard) es válido', () => {
    assert.equal(ux.validateViewport(ux.VIEWPORT_DASHBOARD).ok, true);
});

test('validateViewport: límites inferiores [320, 240] son válidos', () => {
    assert.equal(ux.validateViewport({ width: 320, height: 240 }).ok, true);
});

test('validateViewport: límites superiores [4096, 8192] son válidos', () => {
    assert.equal(ux.validateViewport({ width: 4096, height: 8192 }).ok, true);
});

test('validateViewport: width < 320 abort', () => {
    const r = ux.validateViewport({ width: 319, height: 600 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'viewport-out-of-bounds');
    assert.match(r.detail, /width 319/);
});

test('validateViewport: width > 4096 abort', () => {
    const r = ux.validateViewport({ width: 100000, height: 600 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'viewport-out-of-bounds');
    assert.match(r.detail, /4096/);
});

test('validateViewport: height < 240 abort', () => {
    const r = ux.validateViewport({ width: 600, height: 239 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'viewport-out-of-bounds');
});

test('validateViewport: height > 8192 abort', () => {
    const r = ux.validateViewport({ width: 600, height: 100000 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'viewport-out-of-bounds');
});

test('validateViewport: NaN width abort', () => {
    const r = ux.validateViewport({ width: NaN, height: 600 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'viewport-out-of-bounds');
});

test('validateViewport: Infinity height abort', () => {
    const r = ux.validateViewport({ width: 600, height: Infinity });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'viewport-out-of-bounds');
});

test('validateViewport: width 0 abort', () => {
    const r = ux.validateViewport({ width: 0, height: 600 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'viewport-out-of-bounds');
});

test('validateViewport: width negativo abort', () => {
    const r = ux.validateViewport({ width: -100, height: 600 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'viewport-out-of-bounds');
});

test('validateViewport: viewport no-objeto abort', () => {
    assert.equal(ux.validateViewport(null).ok, false);
    assert.equal(ux.validateViewport(undefined).ok, false);
    assert.equal(ux.validateViewport('411x891').ok, false);
    assert.equal(ux.validateViewport([411, 891]).ok, false);
});

test('validateViewport: width string abort', () => {
    const r = ux.validateViewport({ width: '411', height: 891 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'viewport-out-of-bounds');
});

test('generate: viewport fuera de rango aborta antes de llamar al SDK (CA-S4)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-test-'));
    let sdkCalled = false;
    const FakeAnthropic = function () {
        this.messages = {
            create: async () => {
                sdkCalled = true;
                return { content: [{ text: '```html\n<x></x>\n```' }], usage: {} };
            },
        };
    };
    const result = await ux.generate({
        prompt: 'X',
        outputPath: 'esperado.png',
        repoRoot: tmp,
        allowedRoot: tmp,
        apiKey: 'sk-test',
        viewport: { width: 100000, height: 100000 },
        _requireAnthropic: () => FakeAnthropic,
        _renderHtmlToPng: fakeRendererThatWrites(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'viewport-out-of-bounds');
    assert.equal(sdkCalled, false, 'el SDK no debería haber sido invocado');
});

// =============================================================================
// CA-S7 — PNG intermedio en tmpdir + rename atómico al outputPath final
// =============================================================================

test('generate: render escribe primero en tmpdir y después mueve al outputPath (CA-S7)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-test-'));
    let tmpDirSeenByRenderer = null;
    const fakeRenderer = async (opts) => {
        tmpDirSeenByRenderer = opts.allowedRoot;
        // Verifica que el outputPath que recibe el renderer esté dentro del tmpdir
        // del sistema, no en allowedRoot del caller.
        assert.match(opts.outputPath, new RegExp(path.basename(opts.outputPath) + '$'));
        assert.equal(opts.outputPath.startsWith(opts.allowedRoot), true);
        fs.writeFileSync(opts.outputPath, 'fake-png-bytes');
        return { ok: true, outputPath: opts.outputPath };
    };
    const result = await ux.generate({
        prompt: 'X',
        outputPath: 'esperado.png',
        repoRoot: tmp,
        allowedRoot: tmp,
        apiKey: 'sk-test',
        _requireAnthropic: () => fakeAnthropicClass('<!DOCTYPE html><html><body>X</body></html>'),
        _renderHtmlToPng: fakeRenderer,
    });
    assert.equal(result.ok, true);
    // El renderer vio un allowedRoot dentro de os.tmpdir().
    assert.equal(tmpDirSeenByRenderer.startsWith(os.tmpdir()), true);
    assert.match(tmpDirSeenByRenderer, /ux-mockup-/);
    // El archivo final existe en allowedRoot del caller.
    assert.equal(fs.existsSync(result.outputPath), true);
    assert.equal(result.outputPath.startsWith(tmp), true);
});

test('generate: tmpDir queda limpio después de un render exitoso (CA-S7)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-test-'));
    let capturedTmpDir = null;
    const fakeRenderer = async (opts) => {
        capturedTmpDir = opts.allowedRoot;
        fs.writeFileSync(opts.outputPath, 'fake-png-bytes');
        return { ok: true, outputPath: opts.outputPath };
    };
    const result = await ux.generate({
        prompt: 'X',
        outputPath: 'esperado.png',
        repoRoot: tmp,
        allowedRoot: tmp,
        apiKey: 'sk-test',
        _requireAnthropic: () => fakeAnthropicClass('<!DOCTYPE html><html><body>X</body></html>'),
        _renderHtmlToPng: fakeRenderer,
    });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(capturedTmpDir), false, 'el tmpDir debería estar limpio');
});

test('generate: si el renderer crashea mid-flight, el tmpDir queda limpio (CA-S7)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-test-'));
    let capturedTmpDir = null;
    let partialPngPath = null;
    const fakeRenderer = async (opts) => {
        capturedTmpDir = opts.allowedRoot;
        // Simula crash mid-flight: escribe PNG parcial pero retorna error.
        partialPngPath = opts.outputPath;
        fs.writeFileSync(opts.outputPath, 'partial-bytes');
        return { ok: false, reason: 'crashed-mid-flight', detail: 'simulación' };
    };
    const result = await ux.generate({
        prompt: 'X',
        outputPath: 'esperado.png',
        repoRoot: tmp,
        allowedRoot: tmp,
        apiKey: 'sk-test',
        _requireAnthropic: () => fakeAnthropicClass('<!DOCTYPE html><html><body>X</body></html>'),
        _renderHtmlToPng: fakeRenderer,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'crashed-mid-flight');
    // El PNG parcial NUNCA llegó a qa/evidence/ del caller.
    assert.equal(fs.existsSync(path.join(tmp, 'esperado.png')), false);
    // El tmpDir entero quedó limpio.
    assert.equal(fs.existsSync(capturedTmpDir), false);
    assert.equal(fs.existsSync(partialPngPath), false);
});

test('generate: outputPath con traversal (../) aborta antes de tocar tmpDir (CA-S7)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-test-'));
    const result = await ux.generate({
        prompt: 'X',
        outputPath: '../../etc/passwd',
        repoRoot: tmp,
        allowedRoot: tmp,
        apiKey: 'sk-test',
        _requireAnthropic: () => fakeAnthropicClass('<!DOCTYPE html><html><body>X</body></html>'),
        _renderHtmlToPng: fakeRendererThatWrites(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsafe-output-path');
});
