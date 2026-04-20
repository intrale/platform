// =============================================================================
// apk-freshness.js — Validar existencia + frescura de APKs debug y saneo de
// matches del rejection-report que disparan "APK no se pudo generar".
//
// Issue #2351 — El pattern-match de `rejection-report.js` sobre logs de Gradle
// matcheaba tasks Release que fallan por un bug conocido de AGP + Kotlin MP
// (`bundle<Flavor>ReleaseClassesToRuntimeJar`) aunque los APKs Debug sí se
// generaran correctamente. El reporte creaba entonces un issue fantasma
// ("El APK no se pudo generar") con `priority:high`.
//
// Este módulo implementa R2 y R5 de la auditoría de seguridad:
//   R2: un APK se considera válido sólo si `mtime > buildStartTime`.
//       Un APK exitoso de hace 3 días no puede enmascarar un build roto hoy.
//   R5: restringir el pattern-match a líneas que empiecen con `FAILURE:` o
//       contengan `> Task ... FAILED`. Nunca buscar en todo el buffer crudo
//       del log — un path/filename llamado `apk-not-found.kt` haría match
//       espurio.
//
// PURE JS + fs — fácil de testear con `node --test` (inyectamos `rootDir` y
// `now` para no pisar disco real en los tests).
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_FLAVORS = Object.freeze(['client', 'business', 'delivery']);

// Pattern original (compat): lo exportamos para tests y regresiones históricas,
// pero el matcher nuevo lo complementa con detección order-agnostic dentro
// de cada línea de falla real.
const APK_PATTERN = /assemble.*fail|build.*apk.*fail|apk.*not\s*(?:found|generated)/i;

// Verbos de falla — una línea de error real típicamente los contiene
const APK_FAIL_VERBS = /\b(?:fail(?:ed|ure)?|error|exception)\b/i;
// Targets de falla típicos del pipeline Android: APK, tareas assemble*, bundle*
// que producen el paquete Android, y el texto genérico "apk not (found|generated)"
const APK_TARGET_TOKENS = /\bapk\b|\bassemble\w*\b|\bbundle\w*(?:classes|jar|aab|runtime)\w*\b/i;

/**
 * Extrae únicamente las líneas que representan errores "reales" de Gradle:
 *   - Comienzan con "FAILURE:" (header del block de error de Gradle)
 *   - Contienen "> Task :xxx FAILED" (task que falló explícitamente)
 *
 * Esto evita falsos positivos cuando paths, filenames o comentarios en el log
 * contienen palabras como "apk-not-found" o "assemble" sin ser errores.
 *
 * @param {string} text
 * @returns {string}  Texto con sólo líneas de falla real. Cadena vacía si no hay.
 */
function extractFailureLines(text) {
    if (!text || typeof text !== 'string') return '';
    const keep = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trimStart();
        if (line.startsWith('FAILURE:')) { keep.push(rawLine); continue; }
        // Match `> Task :modulo:task FAILED` (con o sin espacios extra)
        if (/^\s*>\s*Task\s+[:\w.-]+\s+FAILED\b/i.test(rawLine)) { keep.push(rawLine); continue; }
    }
    return keep.join('\n');
}

/**
 * Chequea el pattern de APK únicamente sobre las líneas de falla real (R5).
 *
 * Motivo de no usar el regex original literal: Gradle escribe "Execution
 * failed for task ':...:assembleFooRelease'" — el verbo ("failed") viene ANTES
 * del target ("assemble"), así que `assemble.*fail` no matchea dentro de la
 * misma línea. Aquí buscamos CO-OCURRENCIA (en la misma línea) de un verbo de
 * falla + un token de target (apk, assemble*, bundle*Jar/*Aab) sin importar
 * el orden, más el fallback literal del pattern original.
 *
 * @param {string} text
 * @returns {boolean}
 */
function matchesApkFailureInFailureLines(text) {
    const lines = extractFailureLines(text);
    if (!lines) return false;
    for (const line of lines.split(/\r?\n/)) {
        // Co-ocurrencia en la misma línea: verbo de falla + target de APK/assemble/bundle
        if (APK_FAIL_VERBS.test(line) && APK_TARGET_TOKENS.test(line)) return true;
        // Fallback: preservar el match del pattern original por compat con logs
        // que usen las frases exactas "apk not found / not generated"
        if (APK_PATTERN.test(line)) return true;
    }
    return false;
}

/**
 * Resuelve el path esperado del APK debug para un flavor dado.
 * @param {string} rootDir
 * @param {string} flavor
 */
function apkPathForFlavor(rootDir, flavor) {
    return path.join(
        rootDir,
        'app', 'composeApp', 'build', 'outputs', 'apk',
        flavor, 'debug',
        `composeApp-${flavor}-debug.apk`
    );
}

/**
 * Inspecciona los APKs debug de los flavors dados y reporta si existen y son
 * frescos respecto a un buildStartTime dado (R2).
 *
 * @param {object} opts
 * @param {string} opts.rootDir - raíz del repo (donde cuelga `app/composeApp/...`)
 * @param {number} opts.buildStartTimeMs - epoch ms; APK con `mtime > este valor` es fresco.
 * @param {string[]} [opts.flavors] - lista de flavors a chequear (default: los 3).
 * @param {object} [opts.fsImpl] - override de fs para tests (opcional).
 * @returns {{
 *   checked: Array<{flavor:string, path:string, exists:boolean, fresh:boolean, mtimeMs:number|null, sizeBytes:number|null}>,
 *   anyFresh: boolean,
 *   allFresh: boolean,
 *   allPresent: boolean,
 * }}
 */
function checkDebugApksFresh({ rootDir, buildStartTimeMs, flavors = DEFAULT_FLAVORS, fsImpl } = {}) {
    const FS = fsImpl || fs;
    const checked = [];
    let freshCount = 0;
    let presentCount = 0;
    for (const flavor of flavors) {
        const p = apkPathForFlavor(rootDir, flavor);
        let exists = false;
        let mtimeMs = null;
        let sizeBytes = null;
        try {
            const st = FS.statSync(p);
            if (st && st.isFile && st.isFile()) {
                exists = true;
                mtimeMs = typeof st.mtimeMs === 'number' ? st.mtimeMs : (st.mtime ? st.mtime.getTime() : 0);
                sizeBytes = st.size;
            }
        } catch (_) { /* not present */ }
        const fresh = exists && typeof buildStartTimeMs === 'number' && mtimeMs > buildStartTimeMs;
        if (exists) presentCount++;
        if (fresh) freshCount++;
        checked.push({ flavor, path: p, exists, fresh, mtimeMs, sizeBytes });
    }
    return {
        checked,
        anyFresh: freshCount > 0,
        allFresh: freshCount === flavors.length,
        allPresent: presentCount === flavors.length,
    };
}

/**
 * Construye el payload estructurado de un descarte de match (R3/CA-3).
 * Lo consume `rejection-report.js` para loguear via JSON inline junto al log
 * textual.
 *
 * @param {object} ctx
 * @param {string|number} ctx.issue
 * @param {string} ctx.pattern - nombre simbólico del pattern (p. ej. 'apk_not_generated')
 * @param {string} ctx.reason
 * @param {object} ctx.apkStatus - objeto devuelto por `checkDebugApksFresh`
 */
function buildDismissEvent({ issue, pattern, reason, apkStatus }) {
    return {
        event: 'match-dismissed',
        issue: String(issue),
        pattern,
        reason,
        apkStatus: apkStatus ? {
            anyFresh: apkStatus.anyFresh,
            allFresh: apkStatus.allFresh,
            allPresent: apkStatus.allPresent,
            flavors: (apkStatus.checked || []).map(c => ({
                flavor: c.flavor,
                exists: c.exists,
                fresh: c.fresh,
                ageSec: c.mtimeMs ? Math.round((Date.now() - c.mtimeMs) / 1000) : null,
                sizeKb: c.sizeBytes ? Math.round(c.sizeBytes / 1024) : null,
            })),
        } : null,
    };
}

/**
 * Heurística para estimar el inicio del build actual a partir de lo que
 * `rejection-report.js` conoce: `elapsed` (segundos que duró el agente) +
 * un margen de seguridad. Si no hay elapsed confiable, usa 30 min atrás por
 * defecto (suficiente para builds largos sin tragarse APKs verdaderamente
 * stale).
 *
 * @param {object} opts
 * @param {number|string|null} opts.elapsedSec
 * @param {number} [opts.safetyMarginMs] - default 10 min.
 * @param {number} [opts.nowMs] - inyectable para tests.
 * @param {number} [opts.fallbackWindowMs] - ventana default si no hay elapsed.
 */
function estimateBuildStartTimeMs({ elapsedSec, safetyMarginMs = 10 * 60 * 1000, nowMs = Date.now(), fallbackWindowMs = 30 * 60 * 1000 } = {}) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const parsed = elapsedSec === null || elapsedSec === undefined
        ? NaN
        : parseInt(elapsedSec, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
        return now - (parsed * 1000) - safetyMarginMs;
    }
    return now - fallbackWindowMs;
}

module.exports = {
    DEFAULT_FLAVORS,
    APK_PATTERN,
    extractFailureLines,
    matchesApkFailureInFailureLines,
    apkPathForFlavor,
    checkDebugApksFresh,
    buildDismissEvent,
    estimateBuildStartTimeMs,
};
