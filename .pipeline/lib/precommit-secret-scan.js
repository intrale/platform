#!/usr/bin/env node
// =============================================================================
// precommit-secret-scan.js — Issue #3310 CA-5 · ampliado por #5463
//
// Red de seguridad para evitar que estado interno del pipeline con secretos
// llegue al repo. Estos archivos están en `.gitignore`, pero si alguien
// (humano o agente) los des-ignora por error, este script bloquea el commit
// antes de que la fuga toque la rama.
//
// #5463 — el inventario dejó de vivir acá: ahora sale de
// `.pipeline/lib/sensitive-paths.js`, la MISMA fuente que alimenta `.gitignore`
// y la suite `credential-path-guards.test.js`. Antes esta lista y la de
// `.gitignore` divergían en silencio (los dos stores de credenciales del
// pipeline no estaban en ninguna de las dos).
//
// Dos niveles de bloqueo:
//
//   1. **Path del inventario staged** (`requiereIgnore: true`) → bloquea SIEMPRE,
//      haya o no secretos detectables. Que el archivo esté en el índice ya es
//      el defecto: significa que alguien des-ignoró un path sensible.
//   2. **Contenido con secretos** → bloquea si el sanitizer redacta algo. Cubre
//      también las entradas de sólo-contenido (`.pipeline/servicios/**/*.json`,
//      que mezcla estado efímero con artefactos trackeados legítimos).
//
// Estrategia: lee cada archivo staged que matchee el glob y lo pasa por
// `sanitizer.sanitize()`. Si la salida difiere del input, hay al menos un
// patrón redactado → aborta el commit con mensaje accionable que indica:
//
//   1. QUÉ archivo gatilló la detección (path absoluto + relativo al repo).
//   2. QUÉ patrón (o cantidad de patrones) cazó el sanitizer.
//   3. CÓMO salir (un-stage el archivo + agregar a .gitignore + revisar
//      manualmente antes de commitear).
//
// Diseño:
//   - **Sin dependencias externas** (solo `fs`, `path`, `child_process`).
//   - **Reusa el mismo sanitizer del runtime** — single source of truth para
//     los patrones (Anthropic, OpenAI, Groq (legacy, defense-in-depth post
//     #3353), Cerebras, NVIDIA NIM, Google, AWS, GitHub, JWT, etc.).
//   - **Robusto al escaping** de Windows / MINGW / Git Bash (no regex en
//     bash).
//   - **Fail-closed**: si el sanitizer tira, bloquea el commit (preferimos un
//     falso positivo al leak silencioso).
//
// Exit codes:
//   - 0 → OK (no se detectaron secretos en archivos sensibles).
//   - 1 → BLOQUEAR commit (secretos detectados o error del sanitizer).
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { sanitize } = require('../sanitizer');
const { SENSITIVE_PATHS, clasificarPath } = require('./sensitive-paths');

// Inventario derivado (#5463): la forma `{ name, test }` se conserva por compat
// con los consumidores previos, pero las entradas salen del módulo compartido.
// Agregar un path acá NO es el camino: se agrega en `sensitive-paths.js` y las
// tres capas (ignore / pre-commit / test) lo heredan juntas.
const SENSITIVE_PATTERNS = SENSITIVE_PATHS
    .filter((e) => e.escaneaContenido)
    .map((e) => ({ name: e.id, test: e.test }));

function listStagedFiles() {
    // Lista archivos staged en el commit (added/copied/modified/renamed).
    // `-z` para tolerar paths con espacios; lo splitteamos por NUL.
    try {
        const out = execSync('git diff --cached --name-only --diff-filter=ACMR -z', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return out.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
    } catch (_e) {
        // Si git rompe (no estamos en repo, etc.), no bloqueamos.
        return [];
    }
}

function isSensitive(stagedPath) {
    for (const pat of SENSITIVE_PATTERNS) {
        if (pat.test(stagedPath)) return pat.name;
    }
    return null;
}

/**
 * Cuenta cuántos placeholders distintos de redacción aparecen en el output
 * — sólo para reportar al operador "qué patrones cazaste".
 */
function countRedactions(sanitizedText) {
    const placeholderRe = /\[REDACTED:[A-Z_]+\]/g;
    const matches = sanitizedText.match(placeholderRe) || [];
    const tally = {};
    for (const m of matches) tally[m] = (tally[m] || 0) + 1;
    return tally;
}

function readStagedContent(stagedPath) {
    // Leemos el contenido staged (`:0:<path>`) en vez del worktree, porque
    // alguien podría haber unstaged el secreto después de stagearlo.
    try {
        return execSync(`git show :0:${shellQuote(stagedPath)}`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 50 * 1024 * 1024,
        });
    } catch (e) {
        // Si falla (binario, archivo deleted desde el index, etc.), caemos al
        // contenido del worktree como mejor esfuerzo.
        try {
            return fs.readFileSync(stagedPath, 'utf8');
        } catch {
            return null;
        }
    }
}

function shellQuote(p) {
    // git show acepta paths sin quoting si no tienen caracteres especiales.
    // Para paths con espacio o `'`, los escapamos.
    if (/^[A-Za-z0-9_./-]+$/.test(p)) return p;
    return `'${p.replace(/'/g, `'\\''`)}'`;
}

function main() {
    const staged = listStagedFiles();
    const findings = [];

    for (const rel of staged) {
        const kind = isSensitive(rel);
        if (!kind) continue;

        // ── Nivel 1 (#5463): el path pertenece al inventario que DEBE estar
        // ignorado. Que aparezca staged ya es el defecto — no hace falta que el
        // sanitizer encuentre nada. Fail-closed sin leer el contenido: el
        // mensaje nombra el path y la razón, nunca lo que hay adentro.
        const clase = clasificarPath(rel);
        if (clase && clase.requiereIgnore) {
            findings.push({
                path: rel,
                kind,
                staged_sensible: true,
                motivo: clase.motivo,
                redactions: {},
            });
            continue;
        }

        const content = readStagedContent(rel);
        if (content == null || content.length === 0) continue;

        // El sanitizer normaliza CRLF→LF como efecto colateral. Comparar el
        // contenido crudo contra el sanitizado marcaba como "secreto detectado"
        // a CUALQUIER archivo con finales de línea de Windows — sin un solo
        // patrón redactado, y en este repo el CRLF es el caso por default. El
        // operador veía "(sanitizer redactó algo pero no se identificó)" sobre
        // un archivo limpio, y el camino de salida obvio pasaba a ser
        // `--no-verify`, que desactiva las DOS capas. Normalizamos ANTES de
        // comparar para que la señal sea "el sanitizer redactó algo", no "el
        // archivo venía en CRLF".
        const normalizado = content.replace(/\r\n/g, '\n');

        let sanitized;
        try {
            sanitized = sanitize(normalizado);
        } catch (e) {
            // Fail-closed: si el sanitizer tira, asumimos que hay algo raro
            // que justifica bloquear el commit.
            findings.push({
                path: rel,
                kind,
                error: (e && e.message) || 'unknown',
                redactions: {},
            });
            continue;
        }

        if (sanitized !== normalizado) {
            findings.push({
                path: rel,
                kind,
                redactions: countRedactions(sanitized),
            });
        }
    }

    if (findings.length === 0) return 0;

    // ── Formato accionable de error (UX-friendly) ──────────────────────────
    const lines = [];
    lines.push('');
    lines.push('━'.repeat(72));
    lines.push('🚨 pre-commit BLOQUEADO: paths sensibles en el commit');
    lines.push('━'.repeat(72));
    lines.push('');
    lines.push('El commit toca archivos del inventario cerrado de paths sensibles');
    lines.push('(.pipeline/lib/sensitive-paths.js): o están en el índice cuando');
    lines.push('deberían estar ignorados (#5463), o su contenido matchea patrones');
    lines.push('de credencial en plaintext (#3310).');
    lines.push('');

    for (const f of findings) {
        lines.push(`  ✗ ${f.path}`);
        lines.push(`      tipo: ${f.kind}`);
        if (f.staged_sensible) {
            lines.push('      causa: path del inventario sensible presente en el índice');
            lines.push(`      motivo: ${f.motivo}`);
        } else if (f.error) {
            lines.push(`      sanitizer falló: ${f.error}`);
        } else {
            const tally = Object.entries(f.redactions);
            if (tally.length === 0) {
                lines.push('      patrones: (sanitizer redactó algo pero no se identificó)');
            } else {
                lines.push('      patrones detectados:');
                for (const [placeholder, count] of tally) {
                    lines.push(`        · ${placeholder} × ${count}`);
                }
            }
        }
        lines.push('');
    }

    lines.push('Cómo salir:');
    lines.push('');
    lines.push('  1. Sacá los archivos del stage:');
    for (const f of findings) {
        lines.push(`       git restore --staged ${shellQuote(f.path)}`);
    }
    lines.push('');
    lines.push('  2. Si alguno YA estaba trackeado, sacalo también del índice:');
    for (const f of findings) {
        if (f.staged_sensible) lines.push(`       git rm --cached ${shellQuote(f.path)}`);
    }
    lines.push('');
    lines.push('  3. Verificá que la regla de ignore exista y aplique:');
    lines.push('       git check-ignore -v --no-index <path>');
    lines.push('     El inventario y sus reglas viven en');
    lines.push('     .pipeline/lib/sensitive-paths.js — un alta se hace ahí y');
    lines.push('     .gitignore + este scanner + los tests la heredan juntos.');
    lines.push('');
    lines.push('  4. Si el contenido legítimo del archivo coincidentemente');
    lines.push('     matchea un patrón de secret (falso positivo), reportalo en');
    lines.push('     #3310 con el patrón concreto para ajustar la heurística.');
    lines.push('');
    lines.push('━'.repeat(72));
    lines.push('');

    process.stderr.write(lines.join('\n'));
    return 1;
}

if (require.main === module) {
    process.exit(main());
}

module.exports = {
    SENSITIVE_PATTERNS,
    isSensitive,
    countRedactions,
    __forTestsOnly__: { listStagedFiles, readStagedContent, shellQuote },
};
