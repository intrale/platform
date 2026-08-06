// =============================================================================
// code-scanning-alerts.js — Consulta de alertas de code-scanning de un PR
// (#5337, CA-3, caso 1 de los cuatro del 2026-08-01).
//
// Separado de `human-block-triggers.js` A PROPÓSITO: aquel módulo es PURO
// (recibe estado, devuelve veredicto) y esa pureza es lo que lo hace testeable
// sin red. Toda la parte sucia — spawnear `gh`, timeouts, JSON roto — vive acá.
//
// -----------------------------------------------------------------------------
// POR QUÉ NO ALCANZA CON PEDIR "LAS ALERTAS DEL REPO"
// -----------------------------------------------------------------------------
// `/repos/:owner/:repo/code-scanning/alerts` devuelve TODAS las alertas del
// repositorio, incluidas las `open` sobre `refs/heads/main` (al 2026-08-01
// existen varias, p.ej. la #109 de Semgrep). Si el trigger las tomara todas,
// CADA PR quedaría bloqueado por deuda preexistente que no introdujo y el
// pipeline se autobloquearía entero — el problema inverso al que #5337 arregla.
//
// Por eso se consulta con `ref` explícito: le pedimos a GitHub las alertas
// instanciadas en el ref DEL PR, no las del repo. El filtro final por ref lo
// vuelve a aplicar `detectSecurityFindingBlock` (defensa en profundidad: si
// algún día la API ignora el parámetro, el detector igual descarta lo ajeno).
//
// -----------------------------------------------------------------------------
// FALLO = SILENCIO, NO BLOQUEO
// -----------------------------------------------------------------------------
// Si `gh` falla, hace timeout, el repo no tiene code-scanning habilitado (404)
// o el token no tiene el scope (403), devolvemos `{ alerts: [], error }`. NO se
// inventa un bloqueo por no poder consultar: un falso positivo acá frena un
// issue sano esperando a un humano que no tiene nada que resolver.
// El estado de merge (que sí es consultable siempre) sigue evaluándose igual.
// =============================================================================

'use strict';

const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 8000;
// Cap de alertas traídas. Un PR con más de 50 hallazgos ya está sobradamente
// bloqueado: pedir más sólo agranda el payload y el tiempo de la llamada.
const DEFAULT_LIMIT = 50;

/**
 * Construye los args de `gh api`. Array (no shell-string) → sin superficie de
 * inyección, mismo criterio que `pr-info-fetcher.js`.
 */
function _buildArgs({ repo, ref, limit }) {
    const qs = `ref=${encodeURIComponent(ref)}&state=open&per_page=${limit}`;
    return ['api', `/repos/${repo}/code-scanning/alerts?${qs}`];
}

/**
 * Trae las alertas de code-scanning ABIERTAS instanciadas en el ref de un PR.
 *
 * @param {object} args
 * @param {string} args.repo        — `owner/name`.
 * @param {number} args.prNumber    — número del PR.
 * @param {string} [args.headRefName] — rama del PR; si viene, se consulta también
 *   `refs/heads/<branch>` (el análisis puede haber corrido sobre la rama).
 * @param {object} [opts]
 * @param {string} [opts.ghBin]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.runner]  — inyectable para tests, firma spawnSync.
 * @returns {{alerts: Array, error: (string|null)}}
 */
function fetchPrCodeScanningAlerts({ repo, prNumber, headRefName } = {}, opts = {}) {
    const n = Number(prNumber);
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(String(repo))) {
        return { alerts: [], error: 'repo inválido' };
    }
    if (!Number.isInteger(n) || n <= 0) return { alerts: [], error: 'prNumber inválido' };

    const ghBin = opts.ghBin || process.env.GH_BIN || 'gh';
    const cwd = opts.cwd || process.cwd();
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const limit = Number.isFinite(opts.limit) ? opts.limit : DEFAULT_LIMIT;
    const runner = typeof opts.runner === 'function' ? opts.runner : spawnSync;

    // Refs donde la alerta puede estar instanciada. `refs/heads/main` NUNCA
    // entra: esa es justamente la deuda preexistente que no debe bloquear.
    const refs = [`refs/pull/${n}/head`];
    if (headRefName && typeof headRefName === 'string') {
        refs.push(`refs/heads/${headRefName}`);
    }

    const porNumero = new Map();
    let ultimoError = null;

    for (const ref of refs) {
        let result;
        try {
            result = runner(ghBin, _buildArgs({ repo, ref, limit }), {
                encoding: 'utf8',
                timeout: timeoutMs,
                windowsHide: true,
                cwd,
            });
        } catch (e) {
            ultimoError = `spawn falló: ${e && e.message}`;
            continue;
        }
        if (!result) { ultimoError = 'sin resultado'; continue; }
        if (result.error) { ultimoError = `gh error: ${result.error.message}`; continue; }
        if (result.status !== 0) {
            // 404 = code-scanning no habilitado o ref sin análisis. 403 = sin
            // scope. Ninguno es un bloqueo: es "no sé", y "no sé" nunca bloquea.
            ultimoError = `exit ${result.status}: ${String(result.stderr || '').slice(0, 160)}`;
            continue;
        }
        let parsed;
        try {
            parsed = JSON.parse(result.stdout || '[]');
        } catch (e) {
            ultimoError = `JSON inválido: ${e.message}`;
            continue;
        }
        if (!Array.isArray(parsed)) continue;
        for (const a of parsed) {
            if (!a || !Number.isFinite(Number(a.number))) continue;
            // Dedup: la misma alerta puede venir por los dos refs consultados.
            if (!porNumero.has(a.number)) porNumero.set(a.number, a);
        }
    }

    const alerts = Array.from(porNumero.values());
    // Sólo reportamos error si además NO trajimos nada: si un ref respondió y
    // el otro falló, el dato sirve igual.
    return { alerts, error: alerts.length === 0 ? ultimoError : null };
}

module.exports = {
    fetchPrCodeScanningAlerts,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_LIMIT,
    _buildArgs,
};
