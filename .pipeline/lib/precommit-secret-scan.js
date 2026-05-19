#!/usr/bin/env node
// =============================================================================
// precommit-secret-scan.js — Issue #3310 CA-5
//
// Red de seguridad para evitar que estado interno del pipeline con secretos
// llegue al repo. Hoy estos archivos están en `.gitignore`, pero si alguien
// (humano o agente) los des-ignora por error, este script bloquea el commit
// antes de que la fuga toque la rama.
//
// Cubre los paths donde el commander persiste mensajes de Telegram en disco:
//
//   - `.pipeline/commander-session.json`
//   - `.pipeline/commander-history.jsonl`
//   - `.pipeline/servicios/**/*.json`
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
//     los patrones (Anthropic, OpenAI, Cerebras, NVIDIA NIM, Google,
//     AWS, GitHub, JWT, etc.).
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

// Paths sensibles relativos al root del repo. Los matcheamos con startsWith
// + endsWith para evitar dependencias de globbing externo.
const SENSITIVE_PATTERNS = [
    { name: 'commander-session', test: (p) => p === '.pipeline/commander-session.json' },
    { name: 'commander-history', test: (p) => p === '.pipeline/commander-history.jsonl' },
    { name: 'servicios-state',    test: (p) => p.startsWith('.pipeline/servicios/') && p.endsWith('.json') },
];

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

        const content = readStagedContent(rel);
        if (content == null || content.length === 0) continue;

        let sanitized;
        try {
            sanitized = sanitize(content);
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

        if (sanitized !== content) {
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
    lines.push('🚨 pre-commit BLOQUEADO: secretos detectados en archivos sensibles');
    lines.push('━'.repeat(72));
    lines.push('');
    lines.push('Issue #3310: el commit toca archivos de estado del pipeline que');
    lines.push('NO deberían vivir en git (están en .gitignore por una razón) y');
    lines.push('encima contienen lo que parecen ser credenciales en plaintext.');
    lines.push('');

    for (const f of findings) {
        lines.push(`  ✗ ${f.path}`);
        lines.push(`      tipo: ${f.kind}`);
        if (f.error) {
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
    lines.push('  2. Si estos paths NO deberían estar en git, asegurate de que');
    lines.push('     sigan en .gitignore. Si los des-ignoraste a propósito,');
    lines.push('     pensá si realmente querés exponer ese estado.');
    lines.push('');
    lines.push('  3. Si el contenido legítimo del archivo coincidentemente');
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
