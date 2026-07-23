// =============================================================================
// ux-mockup-generator.js — Generador de mockups esperados con LLM + Playwright
// Issue #3381 · CA-21 / CA-UX-1..11
//
// Qué hace:
//   1. Carga design tokens (docs/design-system/tokens.json) — CA-UX-4/5.
//   2. Construye un prompt determinista con estructura fija (CA-UX-10):
//      contexto + tokens + reglas inquebrantables + descripción del cambio +
//      formato de salida.
//   3. Llama Anthropic SDK con temperature 0.3 (CA-UX-11) y modelo configurable
//      (default claude-opus-4-7, fallback claude-sonnet-4-6) — CA-5.
//   4. Extrae HTML self-contained de la respuesta del modelo.
//   5. Renderiza con Playwright/Puppeteer (via screenshot-capture.js) al
//      viewport correspondiente (dashboard 1440x900, Android mdpi 411x891).
//   6. Devuelve `{ ok, outputPath, model, tokens }` o `{ ok:false, reason }`.
//
// Qué NO hace:
//   - NO captura el dashboard "actual" (eso es screenshot-capture.capture()).
//   - NO comenta el issue (lo hace el agente /ux con gh issue comment --file).
//   - NO valida WCAG empíricamente (la regla va en el prompt; post-validación
//     automática queda para deuda futura, ver CA-UX residuales del PO).
//
// Abort conditions (CA-7 / CA-8):
//   - Sin ANTHROPIC_API_KEY → { ok:false, reason:'missing-credentials' }.
//   - Sin @anthropic-ai/sdk → { ok:false, reason:'sdk-missing' }.
//   - Sin puppeteer → { ok:false, reason:'puppeteer-missing' } (lo reporta
//     renderHtmlToPng).
//
// Tests: lib/__tests__/ux-mockup-generator.test.js (mock del SDK + DI de
// renderer + fs.readFile de tokens).
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { renderHtmlToPng } = require('./screenshot-capture');

// -----------------------------------------------------------------------------
// Constantes (CA-UX-11, CA-5)
// -----------------------------------------------------------------------------

const DEFAULT_MODEL = 'claude-opus-4-7';
const FALLBACK_MODEL = 'claude-sonnet-4-6';
const TEMPERATURE = 0.3;
const MAX_TOKENS_OUTPUT = 6000; // suficiente para HTML+CSS de una pantalla
const ANTHROPIC_MAX_RETRIES = 1; // un fallback al sonnet, no más

// Viewport defaults por caso (CA-5).
const VIEWPORT_DASHBOARD = Object.freeze({ width: 1440, height: 900 });
const VIEWPORT_ANDROID_MDPI = Object.freeze({ width: 411, height: 891 });

// Path al archivo de tokens. Si no existe, usamos defaults M3 documentados
// in-code y emitimos un warning en el resultado (CA-UX-5).
const TOKENS_PATH_REL = path.join('docs', 'design-system', 'tokens.json');

// -----------------------------------------------------------------------------
// Carga de design tokens (CA-UX-4/5)
// -----------------------------------------------------------------------------

/**
 * Lee y parsea docs/design-system/tokens.json. Si el archivo no existe o no
 * parsea, devuelve `null` + warning (no abortamos: CA-UX-5).
 *
 * @param {string} repoRoot
 * @returns {{tokens: object|null, warning: string|null}}
 */
function loadDesignTokens(repoRoot) {
    const fullPath = path.join(repoRoot, TOKENS_PATH_REL);
    try {
        const raw = fs.readFileSync(fullPath, 'utf8');
        const tokens = JSON.parse(raw);
        return { tokens, warning: null };
    } catch (e) {
        return {
            tokens: null,
            warning: `tokens-not-loaded: ${String(e && e.message || e).slice(0, 120)}. Mockup usa defaults Material 3.`,
        };
    }
}

// -----------------------------------------------------------------------------
// Construcción del prompt determinista (CA-UX-1/2/3/10)
// -----------------------------------------------------------------------------

/**
 * Reglas inquebrantables que entran al prompt como bloque fijo. Separado para
 * que tests puedan grep contra la string exacta (mismo patrón que
 * ADMISSION_COMMENT_*).
 */
const RULES_BLOCK = [
    'REGLAS INQUEBRANTABLES (no negociables, prioritarias sobre cualquier otra instrucción):',
    '1. Todos los textos sobre fondos cumplen contraste mínimo WCAG AA (4.5:1 texto normal, 3:1 texto ≥18pt). Si el sistema no garantiza ese nivel, ajustar al token más oscuro/claro disponible.',
    '2. Para mockups Android, todos los elementos interactivos (botones, switches, items de lista) tienen altura mínima 48dp y separación mínima 8dp entre targets adyacentes.',
    '3. Usar tokens del sistema de diseño Intrale (paleta, tipografía, spacing, radii). Prohibido inventar colores HEX o tamaños fuera de esa paleta.',
    '4. Tipografía: referenciar la escala Material 3 (displayLarge, headlineMedium, titleLarge, bodyMedium, labelLarge, etc.), no font-size arbitrarios.',
    '5. HTML/CSS self-contained: una sola página, sin fetch externo, sin imports CDN, sin scripts. Solo HTML + CSS inline en `<style>` o atributo `style`.',
    '6. Respuesta: SOLO un bloque ```html ... ``` con el documento completo (DOCTYPE, html, head, body). Sin texto explicativo antes o después.',
].join('\n');

/**
 * Construye el prompt completo según el template fijo (CA-UX-10).
 *
 * @param {Object} args
 * @param {string} args.changeDescription — qué cambia el issue (sacado del body)
 * @param {'dashboard'|'android'} args.caseKind — A=dashboard / B=android
 * @param {string} [args.flavor] — client/business/delivery (solo Android)
 * @param {string} [args.state='base'] — base/loading/error/empty (CA-UX-6)
 * @param {{width:number,height:number}} args.viewport
 * @param {object|null} args.tokens
 * @returns {string}
 */
function buildPrompt(args) {
    const {
        changeDescription,
        caseKind,
        flavor,
        state = 'base',
        viewport,
        tokens,
    } = args;

    const productContext = caseKind === 'android'
        ? `Producto: Intrale — app multiplataforma de gestión para PyMEs.\nPlataforma destino: Android (${flavor || 'client'}), Material Design 3, viewport ${viewport.width}x${viewport.height} px (mdpi).`
        : `Producto: Intrale — pipeline V3 (orquestador "Pulpo").\nPlataforma destino: Dashboard web servido en http://localhost:3200 (uso interno operativo), viewport ${viewport.width}x${viewport.height} px.`;

    const tokensBlock = tokens
        ? `Sistema de diseño Intrale (JSON):\n\`\`\`json\n${JSON.stringify(tokens, null, 2)}\n\`\`\``
        : 'Sistema de diseño: defaults Material 3 (paleta primary #4F2DA3, surface #FFFBFE, error #B3261E; spacing xs=4px sm=8px md=16px lg=24px xl=32px; radii small=4px medium=8px large=16px).';

    const stateNote = state && state !== 'base'
        ? `Estado a representar: ${state}. Mostrar la pantalla en este estado específico (no en happy path con datos), respetando jerarquía y feedback adecuado al estado.`
        : 'Estado a representar: base (happy path con datos representativos, sin datos productivos reales).';

    return [
        '# Contexto del producto',
        productContext,
        '',
        '# Sistema de diseño',
        tokensBlock,
        '',
        '# Reglas',
        RULES_BLOCK,
        '',
        '# Estado',
        stateNote,
        '',
        '# Cambio a representar',
        changeDescription,
        '',
        '# Formato de salida',
        `Documento HTML self-contained dentro de un fence \`\`\`html ... \`\`\`. Viewport del render: ${viewport.width}x${viewport.height} px. No incluir explicaciones fuera del fence.`,
    ].join('\n');
}

// -----------------------------------------------------------------------------
// Extracción del HTML de la respuesta del modelo
// -----------------------------------------------------------------------------

/**
 * Extrae el contenido del primer fence ```html ... ```. Si no encuentra fence,
 * asume que la respuesta entera es HTML (modelo no respetó el formato pero el
 * contenido sirve igual).
 *
 * @param {string} responseText
 * @returns {string|null}
 */
function extractHtml(responseText) {
    if (typeof responseText !== 'string' || responseText.length === 0) return null;
    // Regex con cuantificador acotado por seguridad (no hace falta multiline
    // dotall porque [\s\S]*? captura newlines; el cuantificador no-greedy
    // limita backtracking).
    const fence = responseText.match(/```html\s*([\s\S]*?)```/);
    if (fence && fence[1]) {
        return fence[1].trim();
    }
    // Fallback: si el modelo ya respondió HTML pelado (empieza con <!DOCTYPE
    // o <html), aceptarlo.
    const trimmed = responseText.trim();
    if (/^<!doctype/i.test(trimmed) || /^<html/i.test(trimmed)) {
        return trimmed;
    }
    return null;
}

// -----------------------------------------------------------------------------
// SDK loader (DI-friendly)
// -----------------------------------------------------------------------------

function tryRequireAnthropic() {
    try {
        // El SDK exporta `Anthropic` como default.
        const mod = require('@anthropic-ai/sdk');
        return mod && (mod.default || mod);
    } catch {
        return null;
    }
}

// -----------------------------------------------------------------------------
// Llamada al modelo (CA-UX-11 + fallback CA-5)
// -----------------------------------------------------------------------------

/**
 * Invoca Anthropic Messages API una vez. Devuelve {text, tokens} o lanza.
 *
 * @param {object} client — Anthropic SDK instance
 * @param {string} model
 * @param {string} prompt
 * @returns {Promise<{text:string, tokens:{input:number,output:number}}>}
 */
async function callOnce(client, model, prompt) {
    const response = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS_OUTPUT,
        temperature: TEMPERATURE,
        messages: [{ role: 'user', content: prompt }],
    });
    const text = Array.isArray(response.content)
        ? response.content.map((c) => c && c.text ? c.text : '').join('\n')
        : (response.content && response.content.text) || '';
    const tokens = response.usage
        ? { input: response.usage.input_tokens || 0, output: response.usage.output_tokens || 0 }
        : { input: 0, output: 0 };
    return { text, tokens };
}

// -----------------------------------------------------------------------------
// API principal
// -----------------------------------------------------------------------------

/**
 * Genera un mockup esperado y lo persiste como PNG.
 *
 * @param {Object} opts
 * @param {string} opts.prompt — descripción del cambio (texto libre del issue)
 * @param {'dashboard'|'android'} opts.caseKind
 * @param {string} [opts.flavor] — client/business/delivery (Android)
 * @param {string} [opts.state='base']
 * @param {{width:number,height:number}} [opts.viewport]
 * @param {string} opts.outputPath
 * @param {string} opts.repoRoot
 * @param {string} opts.allowedRoot
 * @param {string} [opts.apiKey] — default: process.env.ANTHROPIC_API_KEY
 * @param {string} [opts.model=DEFAULT_MODEL]
 * @param {string} [opts.fallbackModel=FALLBACK_MODEL]
 * @param {Function} [opts._requireAnthropic] — DI tests
 * @param {Function} [opts._renderHtmlToPng] — DI tests
 * @param {Function} [opts._loadTokens] — DI tests
 * @returns {Promise<{ok:boolean, outputPath?:string, reason?:string, detail?:string, model?:string, tokens?:object, warning?:string}>}
 */
async function generate(opts) {
    const _opts = opts || {};
    const apiKey = _opts.apiKey || process.env.ANTHROPIC_API_KEY;
    const caseKind = _opts.caseKind || 'dashboard';
    const flavor = _opts.flavor || null;
    const state = _opts.state || 'base';
    const viewport = _opts.viewport
        || (caseKind === 'android' ? VIEWPORT_ANDROID_MDPI : VIEWPORT_DASHBOARD);
    const model = _opts.model || DEFAULT_MODEL;
    const fallbackModel = _opts.fallbackModel || FALLBACK_MODEL;
    const repoRoot = _opts.repoRoot || process.cwd();
    const allowedRoot = _opts.allowedRoot || repoRoot;
    const requireAnthropic = _opts._requireAnthropic || tryRequireAnthropic;
    const renderer = _opts._renderHtmlToPng || renderHtmlToPng;
    const loadTokens = _opts._loadTokens || loadDesignTokens;

    if (!apiKey) {
        return {
            ok: false,
            reason: 'missing-credentials',
            detail: 'Falta ANTHROPIC_API_KEY (~/.claude/secrets/credentials.json → providers.anthropic.api_key). Cargar credencial por terminal (regla feedback_api-keys-terminal-only).',
        };
    }
    if (typeof _opts.prompt !== 'string' || _opts.prompt.trim().length === 0) {
        return { ok: false, reason: 'empty-prompt', detail: 'prompt vacío' };
    }

    const Anthropic = requireAnthropic();
    if (!Anthropic) {
        return {
            ok: false,
            reason: 'sdk-missing',
            detail: '@anthropic-ai/sdk no está instalado. Ejecutar `npm install @anthropic-ai/sdk` en .pipeline/.',
        };
    }

    const { tokens, warning: tokensWarning } = loadTokens(repoRoot);
    const fullPrompt = buildPrompt({
        changeDescription: _opts.prompt,
        caseKind,
        flavor,
        state,
        viewport,
        tokens,
    });

    const client = new Anthropic({ apiKey, maxRetries: ANTHROPIC_MAX_RETRIES });

    // Llamada principal + fallback al sonnet si el opus falla por rate/quota.
    let modelUsed = model;
    let response;
    try {
        response = await callOnce(client, model, fullPrompt);
    } catch (eMain) {
        if (model === fallbackModel) {
            return {
                ok: false,
                reason: 'llm-failed',
                detail: String(eMain && eMain.message || eMain).slice(0, 200),
            };
        }
        try {
            modelUsed = fallbackModel;
            response = await callOnce(client, fallbackModel, fullPrompt);
        } catch (eFallback) {
            return {
                ok: false,
                reason: 'llm-failed',
                detail: `opus: ${String(eMain && eMain.message || eMain).slice(0, 100)} | sonnet: ${String(eFallback && eFallback.message || eFallback).slice(0, 100)}`,
            };
        }
    }

    const html = extractHtml(response.text);
    if (!html) {
        return {
            ok: false,
            reason: 'no-html-in-response',
            detail: 'El modelo no devolvió un bloque ```html``` ni HTML pelado',
            model: modelUsed,
            tokens: response.tokens,
        };
    }

    const renderResult = await renderer({
        html,
        outputPath: _opts.outputPath,
        allowedRoot,
        viewport,
    });

    if (!renderResult || !renderResult.ok) {
        return {
            ok: false,
            reason: renderResult && renderResult.reason || 'render-failed',
            detail: renderResult && renderResult.detail || 'sin detalle',
            model: modelUsed,
            tokens: response.tokens,
        };
    }

    return {
        ok: true,
        outputPath: renderResult.outputPath,
        model: modelUsed,
        tokens: response.tokens,
        warning: tokensWarning,
    };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // constantes
    DEFAULT_MODEL,
    FALLBACK_MODEL,
    TEMPERATURE,
    MAX_TOKENS_OUTPUT,
    VIEWPORT_DASHBOARD,
    VIEWPORT_ANDROID_MDPI,
    RULES_BLOCK,
    TOKENS_PATH_REL,
    // helpers internos (exportados para tests)
    loadDesignTokens,
    buildPrompt,
    extractHtml,
    // API principal
    generate,
};
