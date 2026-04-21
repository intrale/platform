// =============================================================================
// java-home-normalizer.js — Saneado global de JAVA_HOME para el pipeline
//
// Incidente 2026-04-21: varios agentes builder fallaron porque heredaban
// JAVA_HOME=C:\Program Files\JetBrains\IntelliJ IDEA 2024.3.1\jbr — una ruta
// stale que dejaba de existir al reinstalar/actualizar IntelliJ. El gradlew
// aborta antes de compilar y el log del build queda vacío/sin timestamp
// nuevo, haciendo parecer que el dev "no trabajó".
//
// Este módulo corre una sola vez al arranque de cada proceso raíz del
// pipeline (pulpo, restart, smoke-test, cualquier helper que spawnee gradle).
// Sobrescribe `process.env.JAVA_HOME` a un Temurin 21 válido del sistema si
// la variable apunta a algo inexistente o sin `bin/java`. Todos los hijos
// que spawnee el proceso heredan el valor corregido.
// =============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function isValidJavaHome(candidate) {
    if (!candidate || typeof candidate !== 'string') return false;
    try {
        const exe = process.platform === 'win32' ? 'java.exe' : 'java';
        return fs.existsSync(path.join(candidate, 'bin', exe));
    } catch {
        return false;
    }
}

function pickTemurin21() {
    const candidates = [];

    // Preferencia #1: variable explícita para el pipeline (permite override fácil).
    if (process.env.PIPELINE_JAVA_HOME) candidates.push(process.env.PIPELINE_JAVA_HOME);
    if (process.env.JAVA_HOME_21) candidates.push(process.env.JAVA_HOME_21);

    // #2: carpeta .jdks del usuario (IntelliJ coloca acá los toolchains descargados).
    const home = os.homedir();
    if (home) {
        const jdksDir = path.join(home, '.jdks');
        try {
            if (fs.existsSync(jdksDir)) {
                const entries = fs.readdirSync(jdksDir).filter((n) => /^temurin-21/i.test(n));
                entries.sort().reverse(); // más nuevo primero (string sort alcanza para 21.x.y)
                for (const name of entries) candidates.push(path.join(jdksDir, name));
            }
        } catch { /* best-effort */ }
    }

    // #3: Temurin instalado vía MSI en Program Files.
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const temurinRoot = path.join(pf, 'Eclipse Adoptium');
    try {
        if (fs.existsSync(temurinRoot)) {
            const entries = fs.readdirSync(temurinRoot).filter((n) => /jdk-21/i.test(n));
            entries.sort().reverse();
            for (const name of entries) candidates.push(path.join(temurinRoot, name));
        }
    } catch { /* best-effort */ }

    return candidates.find(isValidJavaHome) || null;
}

/**
 * Normaliza process.env.JAVA_HOME al arranque del proceso.
 *
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log] — función de logging opcional
 * @returns {{changed: boolean, previous: string|null, current: string|null, reason: string}}
 */
function normalizeJavaHome(opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const previous = process.env.JAVA_HOME || null;
    const previousOk = isValidJavaHome(previous);

    if (previousOk) {
        // Propagamos PIPELINE_JAVA_HOME con el valor validado para que los roles
        // bash (build.md, tester.md) lo usen como fallback garantizado sin
        // hardcodear rutas machine-specific.
        process.env.PIPELINE_JAVA_HOME = previous;
        return { changed: false, previous, current: previous, reason: 'valid' };
    }

    const chosen = pickTemurin21();
    if (!chosen) {
        log(`[java-home-normalizer] JAVA_HOME inválido (${previous || 'unset'}) y no se encontró Temurin 21 en el sistema`);
        return { changed: false, previous, current: previous, reason: 'no-temurin-found' };
    }

    process.env.JAVA_HOME = chosen;
    // Propagamos PIPELINE_JAVA_HOME con el valor efectivamente normalizado — los
    // roles bash lo leen como fallback cuando necesitan reconstruir el entorno.
    process.env.PIPELINE_JAVA_HOME = chosen;

    // Reforzar el PATH para que `java`/`javac` también resuelvan al nuevo JDK.
    // Agregamos el bin/ al FRENTE del PATH (idempotente — no duplicamos si ya estaba).
    const binDir = path.join(chosen, 'bin');
    const sep = process.platform === 'win32' ? ';' : ':';
    const pathParts = (process.env.PATH || '').split(sep).filter(Boolean);
    if (!pathParts.some((p) => path.resolve(p).toLowerCase() === path.resolve(binDir).toLowerCase())) {
        process.env.PATH = [binDir, ...pathParts].join(sep);
    }

    const reason = previous ? 'stale-path' : 'unset';
    log(`[java-home-normalizer] JAVA_HOME ${reason}: "${previous || ''}" → "${chosen}"`);
    return { changed: true, previous, current: chosen, reason };
}

module.exports = { normalizeJavaHome, isValidJavaHome, pickTemurin21 };
