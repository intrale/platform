'use strict';

// =============================================================================
// render-sandbox.js — Política de seguridad para el render HTML→PDF (CA-7 / #3929)
//
// Fuente única de la política `isRequestAllowed` que aplican TODOS los renders
// con puppeteer del pipeline:
//   - scripts/report-to-pdf-telegram.js  (entregables / reportes derivados de
//     LLM o input del issue)  → modo 'strict'
//   - docs/qa/generate-pdf.js            (reportes legacy autorados por el
//     equipo, con diagramas Mermaid)     → modo 'report'
//
// Función PURA y testeable sin lanzar el browser. El objetivo es cerrar los
// vectores de CA-7:
//   - LFI:  <img src="file:///.../credentials.json"> / <iframe src=file://...>
//   - SSRF: <img src="http://169.254.169.254/..."> / endpoints internos
//   - Exfiltración de datos por red durante el render.
// =============================================================================

// CDNs de confianza permitidos SOLO en modo 'report'. Los reportes legacy del
// equipo cargan Mermaid desde jsdelivr (autores confiables, contenido propio).
// En modo 'strict' (contenido no confiable) NO se permite ninguna red.
const TRUSTED_CDN_PREFIXES = [
    'https://cdn.jsdelivr.net/npm/mermaid',
];

function isTrustedCdn(lowerUrl) {
    return TRUSTED_CDN_PREFIXES.some((p) => lowerUrl.startsWith(p));
}

/**
 * Decide si una request del render puede continuar.
 *
 * @param {object} req
 * @param {string} req.url          - URL de la request.
 * @param {boolean} req.isNavigation - true si es la navegación del documento.
 * @param {string} req.mainUrl       - URL del documento principal (única
 *                                      navegación file:// permitida).
 * @param {'strict'|'report'} [req.mode='strict'] - política a aplicar.
 *   - 'strict': bloquea TODO file:// adicional y TODA la red.
 *   - 'report': igual, pero permite la CDN de Mermaid (TRUSTED_CDN_PREFIXES).
 * @returns {boolean}
 */
function isRequestAllowed({ url, isNavigation, mainUrl, mode = 'strict' } = {}) {
    if (typeof url !== 'string') return false;

    // El documento principal: única navegación file:// permitida.
    if (isNavigation && url === mainUrl) return true;

    const lower = url.toLowerCase();

    // LFI: cualquier file:// que no sea el documento principal.
    if (lower.startsWith('file:')) return false;

    const isNetwork =
        lower.startsWith('http:') ||
        lower.startsWith('https:') ||
        lower.startsWith('ftp:') ||
        lower.startsWith('ws:') ||
        lower.startsWith('wss:');

    if (isNetwork) {
        // Sólo en modo 'report' se admite la CDN de Mermaid (https).
        if (mode === 'report' && lower.startsWith('https:') && isTrustedCdn(lower)) {
            return true;
        }
        // SSRF / exfiltración: todo lo demás se bloquea.
        return false;
    }

    // data:, about:blank, etc. — inocuos.
    return true;
}

/**
 * Construye el handler de `page.on('request', ...)` que aplica la política.
 * Centraliza el wiring para que ambos scripts compartan exactamente el mismo
 * comportamiento (continue/abort) — evita el dead-code de CA-7 (#3929).
 *
 * @param {string} mainUrl
 * @param {'strict'|'report'} [mode='strict']
 * @returns {(req: object) => void}
 */
function makeRequestHandler(mainUrl, mode = 'strict') {
    return (req) => {
        const allowed = isRequestAllowed({
            url: typeof req.url === 'function' ? req.url() : req.url,
            isNavigation:
                typeof req.isNavigationRequest === 'function'
                    ? req.isNavigationRequest()
                    : false,
            mainUrl,
            mode,
        });
        if (allowed) req.continue();
        else req.abort();
    };
}

module.exports = { isRequestAllowed, makeRequestHandler, TRUSTED_CDN_PREFIXES };
