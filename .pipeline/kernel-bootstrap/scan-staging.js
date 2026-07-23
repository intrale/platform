'use strict';

// -----------------------------------------------------------------------------
// scan-staging.js — Escáner de secretos fail-closed para el commit 1 del repo
// del kernel (issue #4662 · Ola 9.1 · precondición de `kernel-migration-plan.md §3.3`).
//
// Reutiliza la MISMA primitiva de detección del runtime del pipeline:
// `.pipeline/sanitizer.js` → `sanitize(text)` (patrones Anthropic/OpenAI/AWS/
// GitHub/JWT/password, fail-closed). NO reimplementa patrones.
//
// Por qué no se usa `.pipeline/lib/precommit-secret-scan.js` directamente: su
// `SENSITIVE_PATTERNS` está restringido por glob a paths de estado del pipeline
// (commander-session.json, servicios/**/*.json) y daría un falso "verde" sobre
// el staging del kernel. Aquí iteramos TODOS los archivos staged por `sanitize()`.
//
// Criterio fail-closed (RS-1):
//   - Si `sanitize(raw)` difiere de `raw` → al menos un patrón fue redactado → HIT → BLOQUEA.
//   - Si `sanitize()` devuelve `[SANITIZER_ERROR:...]` → el escáner no pudo correr → BLOQUEA.
//   - Si `readFileSync` tira (archivo ilegible) → "no pudo correr" ≠ "verde" → BLOQUEA.
// "No pudo correr" nunca equivale a "verde".
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

// Ruta al sanitizer reutilizado del runtime. Resoluble desde .pipeline/kernel-bootstrap/.
const { sanitize } = require('../sanitizer');

const SANITIZER_ERROR_MARKER = '[SANITIZER_ERROR:';

/**
 * Escanea una lista de archivos (paths absolutos o relativos) por secretos,
 * de forma fail-closed. Devuelve un reporte estructurado. NO tira: el caller
 * decide el exit code. Para el patrón "tira excepción" usar `assertClean`.
 *
 * @param {string[]} files
 * @returns {{ clean: boolean, hits: Array<{file:string, reason:string}>, scanned:string[] }}
 */
function scanStaging(files) {
    const hits = [];
    const scanned = [];
    for (const f of files) {
        let raw;
        try {
            raw = fs.readFileSync(f, 'utf8');
        } catch (e) {
            // Archivo ilegible: el escáner no pudo procesarlo → bloquea (RS-1).
            hits.push({ file: f, reason: `no legible: ${(e && e.message) || 'unknown'}` });
            continue;
        }
        scanned.push(f);

        let out;
        try {
            out = sanitize(raw);
        } catch (e) {
            hits.push({ file: f, reason: `sanitize() tiró: ${(e && e.message) || 'unknown'}` });
            continue;
        }

        if (typeof out === 'string' && out.startsWith(SANITIZER_ERROR_MARKER)) {
            // El sanitizer se auto-protegió con su marcador de error → no pudo correr limpio.
            hits.push({ file: f, reason: `sanitizer error interno (${out.slice(0, 60)})` });
            continue;
        }

        if (out !== raw) {
            // Al menos un patrón de secreto fue redactado.
            hits.push({ file: f, reason: 'patrón de secreto detectado (salida redactada difiere del input)' });
        }
    }
    return { clean: hits.length === 0, hits, scanned };
}

/**
 * Versión fail-closed que TIRA si hay hallazgos — pensada para usarse como
 * precondición del commit 1 (aborta el proceso antes de stagear/commitear).
 *
 * @param {string[]} files
 * @returns {{ scanned:string[] }}
 */
function assertClean(files) {
    const report = scanStaging(files);
    if (!report.clean) {
        const detalle = report.hits.map((h) => `  - ${h.file}: ${h.reason}`).join('\n');
        throw new Error(
            `Secretos/errores detectados — commit 1 del kernel BLOQUEADO:\n${detalle}\n` +
            `El escaneo es precondición fail-closed (RS-1). Frenar y escalar al operador.`
        );
    }
    return { scanned: report.scanned };
}

module.exports = { scanStaging, assertClean };

// -----------------------------------------------------------------------------
// CLI: `node scan-staging.js <archivo...>` o `node scan-staging.js --dir <dir>`
// Exit 0 = verde (cero hallazgos). Exit 1 = bloqueado. Exit 2 = uso inválido.
// -----------------------------------------------------------------------------
if (require.main === module) {
    const argv = process.argv.slice(2);
    let files = [];
    const dirIdx = argv.indexOf('--dir');
    if (dirIdx !== -1) {
        const dir = argv[dirIdx + 1];
        if (!dir) {
            process.stderr.write('Uso: node scan-staging.js --dir <directorio>\n');
            process.exit(2);
        }
        // Recorre recursivamente todos los archivos del directorio (excluye .git).
        const walk = (d) => {
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
                if (entry.name === '.git') continue;
                const full = path.join(d, entry.name);
                if (entry.isDirectory()) walk(full);
                else files.push(full);
            }
        };
        walk(dir);
    } else {
        files = argv;
    }

    if (files.length === 0) {
        process.stderr.write('Uso: node scan-staging.js <archivo...> | --dir <directorio>\n');
        process.exit(2);
    }

    const report = scanStaging(files);
    process.stdout.write(`Escaneo fail-closed del staging del kernel (issue #4662)\n`);
    process.stdout.write(`Archivos escaneados: ${report.scanned.length}\n`);
    for (const f of report.scanned) process.stdout.write(`  [ok] ${f}\n`);
    if (report.clean) {
        process.stdout.write(`Resultado: VERDE — cero hallazgos. Habilitado para commit 1.\n`);
        process.exit(0);
    } else {
        process.stdout.write(`Resultado: BLOQUEADO — hallazgos:\n`);
        for (const h of report.hits) process.stdout.write(`  [HIT] ${h.file}: ${h.reason}\n`);
        process.exit(1);
    }
}
