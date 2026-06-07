// =============================================================================
// screenshot-capture.js — Captura headless del dashboard del Pulpo (Caso A)
// Issue #3381 · CA-15 / CA-16 / CA-22
//
// Responsabilidad acotada:
//   - Lanzar puppeteer headless contra http://localhost:3200 (URL hardcodeada
//     anti-SSRF) y exportar PNG fullPage.
//   - Manejar el fallback CA-2 (dashboard caído) devolviendo {ok:false, reason}
//     sin tirar excepción.
//   - Sanitizar el outputPath con path.resolve + prefix-check (CA-16).
//
// Lo que NO hace:
//   - NO acepta URL arbitraria. La URL es constante de módulo.
//   - NO genera mockups (eso vive en ux-mockup-generator.js).
//   - NO comenta el issue en GitHub (lo hace el agente /ux por separado).
//
// Diseño:
//   - Stateless (cada llamada lanza/cierra browser).
//   - Permite override del launcher (DI) para tests sin browser real.
//   - Sin Telegram, sin GitHub: helpers puros, los efectos los hace /ux.
// =============================================================================

'use strict';

const path = require('node:path');
const fs = require('node:fs');

// -----------------------------------------------------------------------------
// Constantes (CA-15)
// -----------------------------------------------------------------------------

// URL hardcodeada: el helper NUNCA acepta URL del agente. Si en el futuro hay
// que capturar otra ruta, agregar a ALLOWED_PATHS — no exponer URL libre.
const DASHBOARD_BASE_URL = 'http://localhost:3200';

// Allowlist de paths del dashboard que pueden capturarse. Limita SSRF a paths
// conocidos del propio dashboard, no a `/ops` o paneles internos con secrets
// (CA-19).
// #3742 — `/dashboard/wizard/allowlist` habilitado para evidencia visual del
// wizard de triaje de allowlist (mockup/QA). No-op si #3751 (viewSlug) lo
// agrega antes por otra vía.
const ALLOWED_PATHS = Object.freeze(['/', '/v3', '/dashboard', '/dashboard/wizard/allowlist']);

// Default viewport del dashboard (CA-UX-7: 1 estado solo, no exigir múltiples).
const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });

// Tiempo máximo del intento de captura. Si el dashboard no responde en 8s,
// declaramos baseline no disponible (CA-2: continuar con warning, no abortar).
const CAPTURE_TIMEOUT_MS = 8000;

// Caracteres permitidos en el filename (CA-16: anti path-traversal + clean).
const FILENAME_SAFE_REGEX = /[^a-z0-9_-]/gi;

// -----------------------------------------------------------------------------
// Sanitización del path destino (CA-16)
// -----------------------------------------------------------------------------

/**
 * Sanitiza un componente de filename: deja solo `[a-z0-9_-]`, sin separadores
 * de path ni caracteres especiales. Devuelve string seguro para usar como
 * basename.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
    if (typeof name !== 'string') return '';
    return name.replace(FILENAME_SAFE_REGEX, '_').slice(0, 120);
}

/**
 * Resuelve outputPath defensivamente:
 *   1. path.resolve sobre el cwd dado.
 *   2. Verifica que el destino esté dentro de allowedRoot (prefix-check).
 *   3. Sanitiza el basename: prohibido `..`, `/`, `\`, espacios, etc.
 *
 * Tira `Error` con mensaje claro si algo no calza — el caller decide cómo
 * manejarlo (en /ux abortamos; en tests verificamos el throw).
 *
 * @param {string} outputPath
 * @param {string} allowedRoot — directorio raíz donde se permite escribir
 * @returns {string} — outputPath absoluto, seguro de usar
 */
function resolveSafeOutputPath(outputPath, allowedRoot) {
    if (typeof outputPath !== 'string' || outputPath.length === 0) {
        throw new Error('screenshot-capture: outputPath vacío');
    }
    if (typeof allowedRoot !== 'string' || allowedRoot.length === 0) {
        throw new Error('screenshot-capture: allowedRoot vacío');
    }

    const resolvedRoot = path.resolve(allowedRoot);
    const resolvedTarget = path.resolve(allowedRoot, outputPath);

    // Prefix-check: el target debe estar dentro del root.
    const rel = path.relative(resolvedRoot, resolvedTarget);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`screenshot-capture: path traversal detectado (${outputPath})`);
    }

    // El basename del filename debe ser seguro (sin chars raros).
    const base = path.basename(resolvedTarget);
    const sanitized = sanitizeFilename(base.replace(/\.png$/i, '')) + '.png';
    if (base !== sanitized) {
        throw new Error(`screenshot-capture: basename inválido (${base}), esperado ${sanitized}`);
    }

    return resolvedTarget;
}

// -----------------------------------------------------------------------------
// Validación del path del dashboard (CA-15 / CA-19)
// -----------------------------------------------------------------------------

/**
 * Verifica que el path solicitado esté en ALLOWED_PATHS y arma URL completa.
 * Si el path no está allowed, tira `Error`.
 *
 * @param {string} dashboardPath — ej. '/', '/v3'
 * @returns {string} URL completa
 */
function buildDashboardUrl(dashboardPath) {
    const p = typeof dashboardPath === 'string' && dashboardPath.length > 0
        ? dashboardPath
        : '/';
    if (!ALLOWED_PATHS.includes(p)) {
        throw new Error(`screenshot-capture: path no autorizado (${p}); allowed=${ALLOWED_PATHS.join(',')}`);
    }
    return DASHBOARD_BASE_URL + (p === '/' ? '' : p);
}

// -----------------------------------------------------------------------------
// Captura headless
// -----------------------------------------------------------------------------

/**
 * Resultado uniforme del helper. Siempre devuelve un objeto, nunca throws
 * por dashboard caído (CA-2). Sí throws por validación de input (CA-16).
 *
 * @typedef {Object} CaptureResult
 * @property {boolean} ok
 * @property {string} [outputPath] — set si ok=true
 * @property {string} [reason] — set si ok=false; clave estable para grep
 *   ('dashboard-down' | 'puppeteer-missing' | 'timeout' | 'unknown')
 * @property {string} [detail] — texto descriptivo opcional
 */

/**
 * Carga puppeteer perezosamente. Si no está instalado, devolvemos null y el
 * caller produce un fallback CA-2 (no abortar con stack trace).
 *
 * @returns {object|null}
 */
function tryRequirePuppeteer() {
    try {
        return require('puppeteer');
    } catch {
        return null;
    }
}

/**
 * Captura PNG fullPage del dashboard.
 *
 * @param {Object} opts
 * @param {string} opts.outputPath — path destino (relativo a allowedRoot o absoluto dentro)
 * @param {string} opts.allowedRoot — root donde se permite escribir (CA-16)
 * @param {string} [opts.dashboardPath='/'] — path del dashboard (de ALLOWED_PATHS)
 * @param {{width:number,height:number}} [opts.viewport]
 * @param {number} [opts.timeoutMs=CAPTURE_TIMEOUT_MS]
 * @param {Function} [opts._requirePuppeteer] — DI para tests
 * @returns {Promise<CaptureResult>}
 */
async function capture(opts) {
    const _opts = opts || {};
    const allowedRoot = _opts.allowedRoot;
    const dashboardPath = _opts.dashboardPath || '/';
    const viewport = _opts.viewport || DEFAULT_VIEWPORT;
    const timeoutMs = Number.isFinite(_opts.timeoutMs) ? _opts.timeoutMs : CAPTURE_TIMEOUT_MS;
    const requirePuppeteer = _opts._requirePuppeteer || tryRequirePuppeteer;

    // Validaciones de input — estos sí pueden tirar (input malicioso, no
    // estado del runtime). El caller en /ux las atrapará con try/catch
    // y abortará la captura sin levantar el agente entero.
    const url = buildDashboardUrl(dashboardPath);
    const resolvedOutput = resolveSafeOutputPath(_opts.outputPath, allowedRoot);

    const puppeteer = requirePuppeteer();
    if (!puppeteer) {
        return {
            ok: false,
            reason: 'puppeteer-missing',
            detail: 'puppeteer no está instalado. Ejecutar `npm install puppeteer` en .pipeline/.',
        };
    }

    // Asegurar dir padre antes de delegar al browser.
    try {
        fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    } catch (e) {
        return { ok: false, reason: 'mkdir-failed', detail: String(e && e.message || e) };
    }

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        const page = await browser.newPage();
        await page.setViewport({
            width: Number(viewport.width) || DEFAULT_VIEWPORT.width,
            height: Number(viewport.height) || DEFAULT_VIEWPORT.height,
        });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
        await page.screenshot({ path: resolvedOutput, fullPage: true });
        return { ok: true, outputPath: resolvedOutput };
    } catch (e) {
        // Dashboard caído / timeout / red — todos son CA-2: no abortar.
        const msg = String(e && e.message || e);
        const reason = msg.toLowerCase().includes('timeout')
            ? 'timeout'
            : msg.toLowerCase().includes('connection') || msg.toLowerCase().includes('refused')
                ? 'dashboard-down'
                : 'unknown';
        return { ok: false, reason, detail: msg.slice(0, 200) };
    } finally {
        if (browser) {
            try { await browser.close(); } catch { /* best-effort */ }
        }
    }
}

// -----------------------------------------------------------------------------
// Render de HTML arbitrario a PNG (compartido con ux-mockup-generator)
// -----------------------------------------------------------------------------

/**
 * Renderiza un HTML self-contained a PNG. NO hace fetch externo: setContent
 * inline. Sirve para tomar el HTML/CSS que devuelve el LLM y exportar mockup.
 *
 * @param {Object} opts
 * @param {string} opts.html — HTML self-contained
 * @param {string} opts.outputPath
 * @param {string} opts.allowedRoot
 * @param {{width:number,height:number}} [opts.viewport]
 * @param {number} [opts.timeoutMs=CAPTURE_TIMEOUT_MS]
 * @param {Function} [opts._requirePuppeteer]
 * @returns {Promise<CaptureResult>}
 */
async function renderHtmlToPng(opts) {
    const _opts = opts || {};
    const allowedRoot = _opts.allowedRoot;
    const viewport = _opts.viewport || DEFAULT_VIEWPORT;
    const timeoutMs = Number.isFinite(_opts.timeoutMs) ? _opts.timeoutMs : CAPTURE_TIMEOUT_MS;
    const requirePuppeteer = _opts._requirePuppeteer || tryRequirePuppeteer;

    if (typeof _opts.html !== 'string' || _opts.html.length === 0) {
        throw new Error('screenshot-capture: html vacío');
    }
    const resolvedOutput = resolveSafeOutputPath(_opts.outputPath, allowedRoot);

    const puppeteer = requirePuppeteer();
    if (!puppeteer) {
        return {
            ok: false,
            reason: 'puppeteer-missing',
            detail: 'puppeteer no está instalado. Ejecutar `npm install puppeteer` en .pipeline/.',
        };
    }

    try {
        fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    } catch (e) {
        return { ok: false, reason: 'mkdir-failed', detail: String(e && e.message || e) };
    }

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        const page = await browser.newPage();
        await page.setViewport({
            width: Number(viewport.width) || DEFAULT_VIEWPORT.width,
            height: Number(viewport.height) || DEFAULT_VIEWPORT.height,
        });
        await page.setContent(_opts.html, { waitUntil: 'networkidle2', timeout: timeoutMs });
        await page.screenshot({ path: resolvedOutput, fullPage: true });
        return { ok: true, outputPath: resolvedOutput };
    } catch (e) {
        const msg = String(e && e.message || e);
        return { ok: false, reason: 'render-failed', detail: msg.slice(0, 200) };
    } finally {
        if (browser) {
            try { await browser.close(); } catch { /* best-effort */ }
        }
    }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // constantes
    DASHBOARD_BASE_URL,
    ALLOWED_PATHS,
    DEFAULT_VIEWPORT,
    CAPTURE_TIMEOUT_MS,
    // helpers de validación (también testeables aislados)
    sanitizeFilename,
    resolveSafeOutputPath,
    buildDashboardUrl,
    // captura
    capture,
    renderHtmlToPng,
};
