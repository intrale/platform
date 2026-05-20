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

test('generate: happy path llama SDK con temperature 0.3 y renderiza HTML', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-test-'));
    let rendererCalledWith = null;
    const fakeRenderer = async (opts) => {
        rendererCalledWith = opts;
        return { ok: true, outputPath: opts.outputPath };
    };
    const result = await ux.generate({
        prompt: 'Cambio del header',
        caseKind: 'dashboard',
        outputPath: 'esperado.png',
        repoRoot: tmp,
        allowedRoot: tmp,
        apiKey: 'sk-test',
        _requireAnthropic: () => fakeAnthropicClass('<!DOCTYPE html><html><body>X</body></html>'),
        _renderHtmlToPng: fakeRenderer,
    });
    assert.equal(result.ok, true);
    assert.match(result.outputPath, /esperado\.png$/);
    assert.equal(result.tokens.input, 100);
    assert.equal(result.tokens.output, 200);
    assert.match(rendererCalledWith.html, /<!DOCTYPE html>/);
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
        _renderHtmlToPng: async (o) => ({ ok: true, outputPath: o.outputPath }),
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
