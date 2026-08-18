#!/usr/bin/env node
'use strict';

// =============================================================================
// migrate-operational-state-namespace.js — #5110 (Ola 9.4 · E2)
//
// Mueve el estado operativo del layout PLANO al layout NAMESPACEADO por
// `projectId`:
//
//   .pipeline/waves.json                  →  .pipeline/projects/<id>/waves.json
//   .pipeline/.partial-pause.json         →  .pipeline/projects/<id>/.partial-pause.json
//   .pipeline/archived/                   →  .pipeline/projects/<id>/archived/
//   .pipeline/audit/partial-pause-...jsonl→  .pipeline/projects/<id>/audit/...
//   .pipeline/wave-promote.*.json         →  .pipeline/projects/<id>/wave-promote.*.json
//   .pipeline/wave-archive.*.json         →  .pipeline/projects/<id>/wave-archive.*.json
//
// NO se mueve (por diseño):
//   .pipeline/.paused          — halt TOTAL, global (D4 · SEC-6).
//   .pipeline/waves.json.template — artefacto versionado del repo.
//   .pipeline/state/**         — queda para #5113.
//
// Uso:
//   node .pipeline/scripts/migrate-operational-state-namespace.js [--dry-run]
//   node .pipeline/scripts/migrate-operational-state-namespace.js --rollback [--dry-run]
//   node .pipeline/scripts/migrate-operational-state-namespace.js --status
//
// Seguridad operativa
// -------------------
// SEC-8 / R6 — TOCTOU contra un pulpo vivo: si el pipeline está despachando
// mientras movemos archivos, un `waves.json` puede escribirse en el layout
// viejo justo después de copiarlo y el cambio se pierde en silencio. Por eso el
// migrador EXIGE halt total verificado (`.pipeline/.paused` presente en disco)
// o un lock global explícito vía `--lock`.
//
// La verificación es sobre el ARCHIVO físico, no sobre `isFullPauseActive()`:
// ese helper está diseñado para fallar cerrado devolviendo `true` ("nunca
// afirmes que está en marcha"), que para el migrador sería fallar ABIERTO
// (arrancaría creyendo que hay halt cuando en realidad no pudo leer el estado).
// Se lo consulta igual, pero como señal secundaria.
//
// R2 / SEC-7 — todo lo que produce este script (backup y destino) debe caer
// bajo rutas gitignoreadas. Se verifica con `git check-ignore` ANTES de escribir
// y se aborta si alguna ruta quedara trackeable.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectContext = require('../lib/project-context');

const SCHEMA_VERSION = 1;

// ─── Paths físicos ──────────────────────────────────────────────────────────

function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function repoRoot() {
    return path.resolve(__dirname, '..', '..');
}

function pauseFile() { return path.join(pipelineDir(), '.paused'); }
function lockFile() { return path.join(pipelineDir(), '.opstate-migration.lock'); }
function migratedMarker(stateDir) { return path.join(stateDir, '.migrated'); }

// ─── Inventario de lo que se mueve ──────────────────────────────────────────
//
// `kind` distingue archivo suelto de directorio y de patrón (los markers de
// transacción llevan pid/timestamp en el nombre).

const MIGRATION_ITEMS = Object.freeze([
    { kind: 'file', rel: 'waves.json' },
    { kind: 'file', rel: '.partial-pause.json' },
    { kind: 'dir', rel: 'archived' },
    { kind: 'file', rel: path.join('audit', 'partial-pause-mutations.jsonl') },
    { kind: 'glob', dir: '.', re: /^wave-promote\.(in-progress|recovering\..+|failed\..+)\.json$/ },
    { kind: 'glob', dir: '.', re: /^wave-archive\.(in-progress|recovering\..+|failed\..+)\.json$/ },
]);

/** Expande el inventario a rutas relativas concretas presentes en `root`. */
function resolveItems(root) {
    const out = [];
    for (const item of MIGRATION_ITEMS) {
        if (item.kind === 'glob') {
            let entries = [];
            try { entries = fs.readdirSync(path.join(root, item.dir)); } catch { entries = []; }
            for (const f of entries) {
                if (item.re.test(f)) out.push({ kind: 'file', rel: path.join(item.dir === '.' ? '' : item.dir, f) });
            }
            continue;
        }
        out.push(item);
    }
    return out.filter((i) => fs.existsSync(path.join(root, i.rel)));
}

// ─── Gitignore guard (R2 · SEC-7) ───────────────────────────────────────────

/**
 * `git check-ignore -q <path>` → exit 0 si está ignorado. Se corre desde la
 * raíz del repo con rutas relativas a ella.
 */
function isGitIgnored(absPath) {
    const rel = path.relative(repoRoot(), absPath).split(path.sep).join('/');
    // Fuera del repo: no hay riesgo de que git lo levante.
    if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
    try {
        execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: repoRoot(), stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function assertIgnored(paths, label) {
    const leaked = paths.filter((p) => !isGitIgnored(p));
    if (leaked.length) {
        throw new Error(
            `[R2/SEC-7] ${label} produciría rutas TRACKEABLES en un repo público:\n` +
            leaked.map((p) => `  - ${path.relative(repoRoot(), p)}`).join('\n') +
            '\nAgregá el patrón a .gitignore antes de migrar (esto es bloqueante a propósito).',
        );
    }
}

// ─── Halt guard (SEC-8 · R6) ────────────────────────────────────────────────

function assertHalted({ useLock }) {
    if (useLock) {
        // Lock global explícito: exclusivo, y con el pid adentro para forensia.
        try {
            const fd = fs.openSync(lockFile(), 'wx');
            fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
            fs.closeSync(fd);
        } catch (err) {
            if (err && err.code === 'EEXIST') {
                throw new Error(
                    `[SEC-8] ya hay un lock de migración en ${lockFile()} — otra corrida está en curso. ` +
                    'Si sabés que quedó huérfano, borralo a mano.',
                );
            }
            throw err;
        }
        return { lockTaken: true };
    }

    if (!fs.existsSync(pauseFile())) {
        throw new Error(
            `[SEC-8/R6] el migrador exige halt total verificado: no existe ${pauseFile()}.\n` +
            'Pausá el pipeline (`.paused`) o corré con --lock para tomar un lock global explícito.\n' +
            'Migrar con el pulpo vivo pierde escrituras en silencio (TOCTOU).',
        );
    }

    // Señal secundaria: si la fachada además lo confirma, mejor. Que devuelva
    // false con `.paused` presente sería raro (config rota) — lo avisamos pero
    // no bloqueamos: la autoridad acá es el archivo.
    try {
        const { isFullPauseActive } = require('../lib/full-pause-state');
        if (!isFullPauseActive()) {
            console.warn('[warn] .paused existe pero isFullPauseActive() dio false — revisá la config antes de seguir.');
        }
    } catch { /* no-fatal */ }

    return { lockTaken: false };
}

function releaseLock(taken) {
    if (!taken) return;
    try { fs.unlinkSync(lockFile()); } catch { /* idempotente */ }
}

// ─── Copia / movimiento ─────────────────────────────────────────────────────

function copyRecursive(src, dst) {
    const st = fs.statSync(src);
    if (st.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dst, entry));
        return;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
}

function removeRecursive(target) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* idempotente */ }
}

/** Lista de archivos hoja bajo `root` (para el backup verificado y el diff). */
function listFilesRecursive(root, acc = []) {
    let st;
    try { st = fs.statSync(root); } catch { return acc; }
    if (!st.isDirectory()) { acc.push(root); return acc; }
    for (const entry of fs.readdirSync(root)) listFilesRecursive(path.join(root, entry), acc);
    return acc;
}

// ─── Backup ─────────────────────────────────────────────────────────────────

function makeBackup(root, items, { dryRun }) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(pipelineDir(), 'backup', `opstate-${stamp}`);

    // Verificar ANTES de escribir un solo byte.
    assertIgnored([dir], 'el backup del migrador');

    if (dryRun) return { dir, files: 0, dryRun: true };

    fs.mkdirSync(dir, { recursive: true });
    let files = 0;
    for (const item of items) {
        const src = path.join(root, item.rel);
        const dst = path.join(dir, item.rel);
        copyRecursive(src, dst);
        files += listFilesRecursive(dst).length;
    }
    // Backup VERIFICADO: se relee lo copiado y se compara byte a byte con el
    // origen. Un backup que no se verifica no es un backup.
    for (const item of items) {
        const src = path.join(root, item.rel);
        for (const srcFile of listFilesRecursive(src)) {
            const rel = path.relative(root, srcFile);
            const dstFile = path.join(dir, rel);
            if (!fs.existsSync(dstFile) || !fs.readFileSync(srcFile).equals(fs.readFileSync(dstFile))) {
                throw new Error(`[backup] verificación falló para ${rel}: el backup no es fiel al origen. Abortado sin tocar el estado.`);
            }
        }
    }
    fs.writeFileSync(
        path.join(dir, 'MANIFEST.json'),
        `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, createdAt: new Date().toISOString(), items: items.map((i) => i.rel), files }, null, 2)}\n`,
        'utf8',
    );
    return { dir, files, dryRun: false };
}

// ─── Comandos ───────────────────────────────────────────────────────────────

function resolveStateDir() {
    // El migrador resuelve el namespace del HOST explícitamente: no depende de
    // que el contexto ambiente esté bien configurado en la máquina que migra.
    return projectContext.stateDirFor(projectContext.HOST_PROJECT_ID);
}

function cmdStatus() {
    const root = pipelineDir();
    const stateDir = resolveStateDir();
    const marker = migratedMarker(stateDir);
    const flat = resolveItems(root);
    const nested = resolveItems(stateDir);
    console.log(JSON.stringify({
        projectId: projectContext.HOST_PROJECT_ID,
        pipelineDir: root,
        stateDir,
        migrated: fs.existsSync(marker),
        marker: fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null,
        flatLayoutItems: flat.map((i) => i.rel),
        namespacedItems: nested.map((i) => i.rel),
    }, null, 2));
    return 0;
}

function cmdMigrate({ dryRun, useLock }) {
    const root = pipelineDir();
    const stateDir = resolveStateDir();
    const marker = migratedMarker(stateDir);

    if (fs.existsSync(marker)) {
        console.log(`[ok] ya migrado (marker en ${marker}) — idempotente, nada que hacer.`);
        return 0;
    }

    const items = resolveItems(root);
    if (!items.length) {
        // Instalación nueva: no hay layout plano que migrar. Se deja el marker
        // igual para que el estado quede declarado.
        if (!dryRun) {
            fs.mkdirSync(stateDir, { recursive: true });
            writeMarker(marker, { items: [], backup: null, note: 'sin layout plano previo' });
        }
        console.log('[ok] no hay estado plano que migrar — marker escrito, layout namespaceado listo.');
        return 0;
    }

    const { lockTaken } = assertHalted({ useLock });
    try {
        // Destino ignorado (R2) — antes de crear nada.
        assertIgnored([stateDir, ...items.map((i) => path.join(stateDir, i.rel))], 'el estado namespaceado');

        const backup = makeBackup(root, items, { dryRun });
        console.log(`[backup] ${backup.dryRun ? '(dry-run) ' : ''}${backup.dir} — ${backup.files} archivo(s)`);

        for (const item of items) {
            const src = path.join(root, item.rel);
            const dst = path.join(stateDir, item.rel);
            console.log(`[move] ${path.relative(root, src)} → ${path.relative(root, dst)}${dryRun ? ' (dry-run)' : ''}`);
            if (dryRun) continue;
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            copyRecursive(src, dst);
            removeRecursive(src);
        }

        if (!dryRun) writeMarker(marker, { items: items.map((i) => i.rel), backup: backup.dir });
        console.log(`[ok] migración ${dryRun ? 'simulada' : 'completa'} → ${stateDir}`);
        return 0;
    } finally {
        releaseLock(lockTaken);
    }
}

function writeMarker(marker, extra) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        projectId: projectContext.HOST_PROJECT_ID,
        migratedAt: new Date().toISOString(),
        issue: 5110,
        ...extra,
    }, null, 2)}\n`, 'utf8');
}

/**
 * R8 — vuelta al layout plano en minutos. Mueve de vuelta lo que esté en el
 * namespace del host y borra el marker. Idempotente.
 */
function cmdRollback({ dryRun, useLock }) {
    const root = pipelineDir();
    const stateDir = resolveStateDir();
    const marker = migratedMarker(stateDir);

    const items = resolveItems(stateDir);
    if (!items.length && !fs.existsSync(marker)) {
        console.log('[ok] no hay estado namespaceado — ya estás en layout plano.');
        return 0;
    }

    const { lockTaken } = assertHalted({ useLock });
    try {
        const backup = makeBackup(stateDir, items, { dryRun });
        console.log(`[backup] ${backup.dryRun ? '(dry-run) ' : ''}${backup.dir} — ${backup.files} archivo(s)`);

        for (const item of items) {
            const src = path.join(stateDir, item.rel);
            const dst = path.join(root, item.rel);
            console.log(`[move] ${path.relative(root, src)} → ${path.relative(root, dst)}${dryRun ? ' (dry-run)' : ''}`);
            if (dryRun) continue;
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            copyRecursive(src, dst);
            removeRecursive(src);
        }

        if (!dryRun) {
            try { fs.unlinkSync(marker); } catch { /* idempotente */ }
        }
        console.log(`[ok] rollback ${dryRun ? 'simulado' : 'completo'} → layout plano en ${root}`);
        return 0;
    } finally {
        releaseLock(lockTaken);
    }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main(argv) {
    const args = new Set(argv);
    const dryRun = args.has('--dry-run');
    const useLock = args.has('--lock');

    if (args.has('--help') || args.has('-h')) {
        console.log([
            'migrate-operational-state-namespace.js (#5110)',
            '',
            '  --status     inspecciona el layout actual y sale',
            '  --rollback   vuelve al layout plano (R8)',
            '  --dry-run    muestra qué haría sin tocar el FS',
            '  --lock       toma un lock global en vez de exigir .paused',
        ].join('\n'));
        return 0;
    }
    if (args.has('--status')) return cmdStatus();
    if (args.has('--rollback')) return cmdRollback({ dryRun, useLock });
    return cmdMigrate({ dryRun, useLock });
}

if (require.main === module) {
    try {
        process.exit(main(process.argv.slice(2)));
    } catch (err) {
        console.error(`[error] ${err && err.message ? err.message : err}`);
        process.exit(1);
    }
}

module.exports = {
    main,
    MIGRATION_ITEMS,
    SCHEMA_VERSION,
    _internal: { resolveItems, isGitIgnored, assertIgnored, assertHalted, makeBackup, resolveStateDir, pipelineDir },
};
