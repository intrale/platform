#!/usr/bin/env node
// =============================================================================
// promote-screenshots.js — Hook QA post-ejecución exitosa que promueve PNGs
// de `qa/evidence/<issue>/` a la librería curada
// `docs/app-screenshots-reference/<pantalla>/<pantalla>-<flavor>-<YYYY-MM-DD>.png`.
//
// Issue #3409 (split 3/3 de #3382) · CA-7.1 a CA-7.9.
//
// Contrato CLI:
//   node qa/scripts/promote-screenshots.js \
//     --issue <N> \
//     [--evidence-dir <path>] \
//     [--library-dir <path>] \
//     [--report <path>] \
//     [--flavor <client|business|delivery>] \
//     [--date <YYYY-MM-DD>] \
//     [--dry-run]
//
// Salida JSON por stdout:
//   {
//     "promoted": <N>,
//     "already_in_library": <N>,
//     "skipped_pii": <N>,
//     "skipped_unmapped": <N>,
//     "log": [ ...mensajes accionables... ],
//     "errors": [ ... ]
//   }
//
// Exit codes:
//   0 → ejecución concluida (incluye fail-safe sin promoción)
//   1 → error duro (librería ausente, qa-report ilegible, etc.)
//   2 → argumentos inválidos
//
// Comportamiento fail-safe (CA-7.7/7.8):
//   El módulo de política PII se importa con `require('qa/lib/pii-policy.js')`
//   (path fijo, NO configurable por CLI/env para que un dev distraído no pueda
//   bypassear). Si el módulo no existe, no expone `hasPII`, o lanza al cargar,
//   se asume política NO disponible → exit 0 sin promover y log explícito.
//
// El repo `intrale/platform` es PÚBLICO: el default es siempre fail-safe.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PII_POLICY_PATH = path.join(REPO_ROOT, 'qa', 'lib', 'pii-policy.js');

// ─── Heurística de mapeo PNG → pantalla canónica ──────────────────────────
// Alineada con docs/pipeline/ux-android-visual-flow.md §7.
// Orden importa: las reglas más específicas van primero.
const SCREEN_HEURISTICS = Object.freeze([
    { canonical: 'login',            patterns: [/password-recovery/i, /recovery/i, /signin/i, /login/i] },
    { canonical: 'signup',           patterns: [/signup/i, /register/i, /registro/i] },
    { canonical: 'welcome',          patterns: [/welcome/i] },
    { canonical: 'home',             patterns: [/business-home/i, /home/i, /^main/i, /-main/i] },
    { canonical: 'busqueda',         patterns: [/drawer-search/i, /busqueda/i, /b[uú]squeda/i, /search/i] },
    { canonical: 'detalle-producto', patterns: [/detalle-producto/i, /product-detail/i, /producto/i, /detalle/i, /product/i] },
    { canonical: 'carrito',          patterns: [/carrito/i, /cart/i] },
    { canonical: 'checkout',         patterns: [/checkout/i] },
    { canonical: 'perfil',           patterns: [/profile-selector/i, /perfil/i, /profile/i] },
    { canonical: 'pedidos',          patterns: [/pedidos/i, /pedido/i, /orders/i, /order/i] },
]);

const VALID_FLAVORS = Object.freeze(['client', 'business', 'delivery']);

// ─── Util: parsing de argumentos ──────────────────────────────────────────
function parseArgs(argv) {
    const args = {
        issue: null,
        evidenceDir: null,
        libraryDir: null,
        report: null,
        flavor: null,
        date: null,
        dryRun: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--issue':         args.issue = argv[++i]; break;
            case '--evidence-dir':  args.evidenceDir = argv[++i]; break;
            case '--library-dir':   args.libraryDir = argv[++i]; break;
            case '--report':        args.report = argv[++i]; break;
            case '--flavor':        args.flavor = argv[++i]; break;
            case '--date':          args.date = argv[++i]; break;
            case '--dry-run':       args.dryRun = true; break;
            default:
                throw new Error(`unknown argument: ${a}`);
        }
    }
    return args;
}

// ─── Util: mapeo filename → pantalla canónica ─────────────────────────────
function inferScreen(filename) {
    const lower = filename.toLowerCase();
    for (const rule of SCREEN_HEURISTICS) {
        for (const pat of rule.patterns) {
            if (pat.test(lower)) return rule.canonical;
        }
    }
    return null;
}

// ─── Util: validar flavor ─────────────────────────────────────────────────
function validateFlavor(flavor) {
    if (!flavor) return null;
    if (VALID_FLAVORS.includes(flavor)) return flavor;
    return null;
}

// ─── Util: inferir flavor desde qa-report.json o labels ───────────────────
// Política: si el report incluye `flavor` (top-level) lo respeta. Si no, si
// el report incluye `labels` con UN SOLO `app:*` → ese flavor. Si hay varios
// app:* y no hay flavor explícito → retorna null (no promueve, registra).
function inferFlavorFromReport(report) {
    if (!report) return null;
    if (report.flavor && VALID_FLAVORS.includes(report.flavor)) return report.flavor;

    const labels = Array.isArray(report.labels) ? report.labels : null;
    if (!labels) return null;
    const appLabels = labels
        .filter((l) => typeof l === 'string' && l.startsWith('app:'))
        .map((l) => l.slice('app:'.length));
    const candidates = appLabels.filter((f) => VALID_FLAVORS.includes(f));
    if (candidates.length === 1) return candidates[0];
    return null;
}

// ─── Util: validar fecha YYYY-MM-DD ───────────────────────────────────────
function validateDate(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    return dateStr;
}

function todayIso(now = new Date()) {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// ─── Util: sha256 hash de un archivo ──────────────────────────────────────
function sha256File(filePath) {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

// ─── Carga del módulo PII (fail-safe) ─────────────────────────────────────
// CA-7.7 + CA-7.8: import explícito; cualquier ausencia/error → política NO
// disponible → NO promover. Nunca se acepta CLI/env override.
function loadPIIPolicy({ piiPolicyPath = PII_POLICY_PATH, requireFn = require } = {}) {
    if (!fs.existsSync(piiPolicyPath)) {
        return { available: false, reason: 'pii-policy module missing' };
    }
    try {
        // Bust de cache para que reload en tests funcione (delete del cache).
        try { delete requireFn.cache[piiPolicyPath]; } catch { /* noop */ }
        const mod = requireFn(piiPolicyPath);
        if (!mod || typeof mod.hasPII !== 'function') {
            return { available: false, reason: 'pii-policy module missing hasPII()' };
        }
        return { available: true, policy: mod };
    } catch (err) {
        return { available: false, reason: `pii-policy module failed to load: ${err.message}` };
    }
}

// ─── Lectura del qa-report.json ──────────────────────────────────────────
function readQaReport(reportPath) {
    if (!fs.existsSync(reportPath)) {
        return { ok: false, reason: `qa-report.json not found at ${reportPath}` };
    }
    let raw;
    try { raw = fs.readFileSync(reportPath, 'utf8'); }
    catch (err) { return { ok: false, reason: `qa-report.json unreadable: ${err.message}` }; }
    let json;
    try { json = JSON.parse(raw); }
    catch (err) { return { ok: false, reason: `qa-report.json invalid JSON: ${err.message}` }; }
    return { ok: true, report: json };
}

// ─── Listado de PNGs en evidence dir ─────────────────────────────────────
function listEvidencePngs(evidenceDir) {
    if (!fs.existsSync(evidenceDir)) return [];
    let entries;
    try { entries = fs.readdirSync(evidenceDir); }
    catch { return []; }
    return entries
        .filter((f) => f.toLowerCase().endsWith('.png'))
        .map((f) => path.join(evidenceDir, f))
        .sort();
}

// ─── Copia atómica (tmp + rename) ────────────────────────────────────────
function atomicCopy(src, dest) {
    const dir = path.dirname(dest);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
}

// ─── Verificación de estructura de librería (CA-7.9) ─────────────────────
function ensureLibraryPresent(libraryDir) {
    const readmePath = path.join(libraryDir, 'README.md');
    if (!fs.existsSync(libraryDir) || !fs.existsSync(readmePath)) {
        return {
            ok: false,
            error: 'screenshots-reference library missing — depends on #3407',
        };
    }
    return { ok: true };
}

// ─── Lógica principal (exportada para tests) ─────────────────────────────
function promoteScreenshots(opts) {
    const log = [];
    const errors = [];
    const stats = {
        promoted: 0,
        already_in_library: 0,
        skipped_pii: 0,
        skipped_unmapped: 0,
    };

    const issue = opts.issue;
    if (!issue) {
        errors.push('missing --issue');
        return { ok: false, exitCode: 2, log, errors, ...stats };
    }

    const repoRoot = opts.repoRoot || REPO_ROOT;
    const evidenceDir = opts.evidenceDir
        || path.join(repoRoot, 'qa', 'evidence', String(issue));
    const libraryDir = opts.libraryDir
        || path.join(repoRoot, 'docs', 'app-screenshots-reference');
    const reportPath = opts.report
        || path.join(evidenceDir, 'qa-report.json');
    const date = validateDate(opts.date || '') || todayIso(opts.now || new Date());
    const requireFn = opts.requireFn || require;
    const piiPolicyPath = opts.piiPolicyPath || PII_POLICY_PATH;

    // CA-7.9 — Librería debe existir (responsabilidad de #3407).
    const libCheck = ensureLibraryPresent(libraryDir);
    if (!libCheck.ok) {
        errors.push(libCheck.error);
        return { ok: false, exitCode: 1, log, errors, ...stats };
    }

    // Leer qa-report para verdict + metadata.
    const reportRead = readQaReport(reportPath);
    if (!reportRead.ok) {
        errors.push(reportRead.reason);
        return { ok: false, exitCode: 1, log, errors, ...stats };
    }
    const report = reportRead.report;

    if (report.verdict && String(report.verdict).toUpperCase() !== 'APROBADO') {
        log.push(`qa-report verdict is ${report.verdict} — promotion skipped`);
        return { ok: true, exitCode: 0, log, errors, ...stats };
    }

    // CA-7.7/7.8 — Fail-safe ante ausencia de política PII.
    const pii = loadPIIPolicy({ piiPolicyPath, requireFn });
    if (!pii.available) {
        log.push(`PII policy unavailable — promotion skipped (${pii.reason})`);
        return { ok: true, exitCode: 0, log, errors, ...stats };
    }

    // Flavor: CLI > qa-report.flavor > labels (si un solo app:*).
    const flavorCli = validateFlavor(opts.flavor);
    const flavor = flavorCli || inferFlavorFromReport(report);
    if (!flavor) {
        log.push('flavor not resolved (no --flavor, no qa-report.flavor, no single app:* label) — promotion skipped');
        return { ok: true, exitCode: 0, log, errors, ...stats };
    }

    // Listar PNGs.
    const pngs = listEvidencePngs(evidenceDir);
    if (pngs.length === 0) {
        log.push(`no PNGs found in ${evidenceDir} — nothing to promote`);
        log.push('promoted 0 screenshots to library');
        return { ok: true, exitCode: 0, log, errors, ...stats };
    }

    // Procesar cada PNG.
    for (const png of pngs) {
        const filename = path.basename(png);

        // Mapeo pantalla canónica.
        const screen = inferScreen(filename);
        if (!screen) {
            stats.skipped_unmapped++;
            log.push(`unmapped: ${filename} — no canonical screen matched, skipped`);
            continue;
        }

        // Consulta PII (import explícito ya validado arriba).
        let piiCheck;
        try {
            piiCheck = pii.policy.hasPII(png, { issue, flavor, screen });
        } catch (err) {
            // CA-7.7 refuerzo defensivo: si hasPII lanza, fail-safe.
            stats.skipped_pii++;
            log.push(`PII check threw on ${filename} — skipped (${err.message})`);
            continue;
        }
        if (piiCheck && piiCheck.flagged) {
            stats.skipped_pii++;
            const flagsDesc = Array.isArray(piiCheck.flags) && piiCheck.flags.length > 0
                ? ` [${piiCheck.flags.join(', ')}]`
                : '';
            log.push(`PII detected — promotion skipped: ${filename}${flagsDesc}`);
            continue;
        }

        // Path canónico destino.
        const targetName = `${screen}-${flavor}-${date}.png`;
        const targetPath = path.join(libraryDir, screen, targetName);

        // Idempotencia: si destino existe y tiene mismo hash → no-op.
        let isSameContent = false;
        if (fs.existsSync(targetPath)) {
            try {
                isSameContent = sha256File(png) === sha256File(targetPath);
            } catch { isSameContent = false; }
        }

        if (isSameContent) {
            stats.already_in_library++;
            log.push(`already in library: ${screen}/${targetName} (same content)`);
            continue;
        }

        // Sobreescritura misma fecha (último QA del día gana — CA-7.3).
        const willOverwrite = fs.existsSync(targetPath);

        if (opts.dryRun) {
            stats.promoted++;
            log.push(`[dry-run] would promote ${filename} → ${screen}/${targetName}`);
            if (willOverwrite) log.push(`[dry-run] overwritten same-day screenshot ${screen}/${flavor}`);
            continue;
        }

        try {
            atomicCopy(png, targetPath);
        } catch (err) {
            errors.push(`failed to promote ${filename}: ${err.message}`);
            continue;
        }
        stats.promoted++;
        log.push(`promoted ${filename} → ${screen}/${targetName}`);
        if (willOverwrite) {
            log.push(`overwritten same-day screenshot ${screen}/${flavor}`);
        }
    }

    // Resumen final accionable (CA-7.4 / CA-7.5).
    if (stats.promoted === 0 && stats.already_in_library > 0 && stats.skipped_pii === 0 && stats.skipped_unmapped === 0) {
        log.push(`promoted 0 screenshots (already in library)`);
    } else {
        log.push(`promoted ${stats.promoted} screenshots to library`);
    }

    return {
        ok: errors.length === 0,
        exitCode: errors.length === 0 ? 0 : 1,
        log,
        errors,
        ...stats,
    };
}

// ─── CLI entrypoint ──────────────────────────────────────────────────────
function main() {
    let args;
    try {
        args = parseArgs(process.argv);
    } catch (err) {
        process.stdout.write(JSON.stringify({
            ok: false,
            errors: [err.message],
            log: [],
            promoted: 0,
            already_in_library: 0,
            skipped_pii: 0,
            skipped_unmapped: 0,
        }, null, 2) + '\n');
        process.exit(2);
    }

    const result = promoteScreenshots({
        issue: args.issue,
        evidenceDir: args.evidenceDir,
        libraryDir: args.libraryDir,
        report: args.report,
        flavor: args.flavor,
        date: args.date,
        dryRun: args.dryRun,
    });

    process.stdout.write(JSON.stringify({
        ok: result.ok,
        promoted: result.promoted,
        already_in_library: result.already_in_library,
        skipped_pii: result.skipped_pii,
        skipped_unmapped: result.skipped_unmapped,
        log: result.log,
        errors: result.errors,
    }, null, 2) + '\n');

    process.exit(result.exitCode);
}

if (require.main === module) {
    main();
}

module.exports = {
    promoteScreenshots,
    inferScreen,
    inferFlavorFromReport,
    loadPIIPolicy,
    ensureLibraryPresent,
    todayIso,
    sha256File,
    SCREEN_HEURISTICS,
    VALID_FLAVORS,
    PII_POLICY_PATH,
};
