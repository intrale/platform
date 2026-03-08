#!/usr/bin/env node
// detect-tech-debt.js — Detecta deuda técnica en el codebase
// Analiza: TODOs/FIXMEs, tests faltantes, strings legacy, imports innecesarios, QA logs
// Uso: node detect-tech-debt.js [--json] [--limit N]
// Salida: lista de items de deuda técnica, cada uno con título, descripción y severidad

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "detect-tech-debt.log");
const QA_DIR = path.join(REPO_ROOT, "docs", "qa");
const GH_PATH = "C:\\Workspaces\\gh-cli\\bin\\gh.exe";

const OUTPUT_JSON = process.argv.includes("--json");
const LIMIT = (() => {
    const idx = process.argv.indexOf("--limit");
    return idx !== -1 ? parseInt(process.argv[idx + 1], 10) || 20 : 20;
})();

// ─── Logging ─────────────────────────────────────────────────────────────────

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
    ensureDir(LOG_DIR);
    const ts = new Date().toISOString();
    try { fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`); } catch (e) { /* ignore */ }
}

function execSafe(cmd, opts = {}) {
    try {
        return execSync(cmd, { encoding: "utf8", timeout: 15000, ...opts }).trim();
    } catch (e) {
        log(`execSafe failed: ${cmd.substring(0, 80)} → ${e.message}`);
        return null;
    }
}

// ─── Análisis: TODOs y FIXMEs ────────────────────────────────────────────────

function detectTodoFixme() {
    const items = [];
    const extensions = ["kt", "kts", "js", "ts", "json"];
    const extPattern = extensions.map(e => `*.${e}`).join(" -o -name ");
    const grepCmd = `grep -rn "TODO\\|FIXME\\|HACK\\|XXX" "${REPO_ROOT}" --include="*.kt" --include="*.kts" --include="*.js" 2>/dev/null | head -50`;

    const raw = execSafe(grepCmd);
    if (!raw) return items;

    const lines = raw.split("\n").filter(Boolean);
    for (const line of lines) {
        // Ignorar archivos de test, build outputs, node_modules
        if (line.includes("node_modules") || line.includes("build/") ||
            line.includes(".gradle") || line.includes("detect-tech-debt")) continue;

        const match = line.match(/^(.+?):(\d+):\s*(.*)$/);
        if (!match) continue;

        const [, filePath, lineNum, content] = match;
        const relPath = filePath.replace(REPO_ROOT, "").replace(/^[/\\]/, "");
        const todoMatch = content.match(/(TODO|FIXME|HACK|XXX)[:\s]*(.*)/i);
        const tag = todoMatch ? todoMatch[1].toUpperCase() : "TODO";
        const description = todoMatch ? todoMatch[2].trim() : content.trim();

        items.push({
            type: "todo",
            severity: tag === "FIXME" ? "high" : "medium",
            title: `Resolver ${tag} en ${path.basename(filePath)}`,
            description: description || `${tag} sin descripción`,
            file: relPath,
            line: parseInt(lineNum, 10),
            effort: "S",
            labels: ["backlog-tecnico", "enhancement"],
            stream: detectStream(relPath)
        });
    }

    return items;
}

// ─── Análisis: Tests faltantes ───────────────────────────────────────────────

function detectMissingTests() {
    const items = [];

    // Buscar archivos en src/main (backend) sin test correspondiente
    const backendSrcCmd = `find "${REPO_ROOT}/backend/src/main" -name "*.kt" 2>/dev/null | head -30`;
    const backendFiles = execSafe(backendSrcCmd);
    if (backendFiles) {
        const files = backendFiles.split("\n").filter(Boolean);
        for (const file of files) {
            const baseName = path.basename(file, ".kt").replace(/[^\w.-]/g, "");
            if (!baseName) continue; // ignorar nombres inválidos tras sanitización
            // Verificar si existe test correspondiente
            const testPattern = `${REPO_ROOT}/backend/src/test`;
            const testExists = execSafe(`find "${testPattern}" -name "${baseName}Test.kt" -o -name "${baseName}Tests.kt" 2>/dev/null | head -1`);
            if (!testExists) {
                const relPath = file.replace(REPO_ROOT, "").replace(/^[/\\]/, "");
                items.push({
                    type: "missing_test",
                    severity: "medium",
                    title: `Agregar tests para ${baseName}`,
                    description: `La clase ${baseName} no tiene test unitario correspondiente`,
                    file: relPath,
                    effort: "S",
                    labels: ["backlog-tecnico", "testing"],
                    stream: "Stream A — Backend"
                });
            }
        }
    }

    // Buscar ViewModels en app sin tests
    const vmCmd = `find "${REPO_ROOT}/app" -name "*ViewModel.kt" -not -path "*/test/*" 2>/dev/null | head -20`;
    const vmFiles = execSafe(vmCmd);
    if (vmFiles) {
        const files = vmFiles.split("\n").filter(Boolean);
        for (const file of files) {
            const baseName = path.basename(file, ".kt").replace(/[^\w.-]/g, "");
            if (!baseName) continue; // ignorar nombres inválidos tras sanitización
            const testExists = execSafe(`find "${REPO_ROOT}/app" -name "${baseName}Test.kt" 2>/dev/null | head -1`);
            if (!testExists) {
                const relPath = file.replace(REPO_ROOT, "").replace(/^[/\\]/, "");
                items.push({
                    type: "missing_test",
                    severity: "medium",
                    title: `Agregar tests para ${baseName}`,
                    description: `El ViewModel ${baseName} no tiene test correspondiente`,
                    file: relPath,
                    effort: "S",
                    labels: ["backlog-tecnico", "testing"],
                    stream: detectStream(relPath)
                });
            }
        }
    }

    return items;
}

// ─── Análisis: Strings legacy ─────────────────────────────────────────────────

function detectLegacyStrings() {
    const items = [];

    const patterns = [
        { pattern: "stringResource(", label: "stringResource directo" },
        { pattern: "Res.string.", label: "Res.string directo" },
        { pattern: "R.string.", label: "R.string directo" }
    ];

    for (const { pattern, label } of patterns) {
        const cmd = `grep -rn "${pattern}" "${REPO_ROOT}/app/composeApp/src" --include="*.kt" 2>/dev/null | grep -v "ResStrings\\|util/Res" | head -10`;
        const raw = execSafe(cmd);
        if (!raw) continue;

        const lines = raw.split("\n").filter(Boolean);
        for (const line of lines) {
            const match = line.match(/^(.+?):(\d+):/);
            if (!match) continue;
            const [, filePath, lineNum] = match;
            const relPath = filePath.replace(REPO_ROOT, "").replace(/^[/\\]/, "");
            items.push({
                type: "legacy_string",
                severity: "high",
                title: `Migrar ${label} en ${path.basename(filePath)}`,
                description: `Uso de ${label} fuera de ResStrings — viola regla de strings del proyecto`,
                file: relPath,
                line: parseInt(lineNum, 10),
                effort: "S",
                labels: ["backlog-tecnico", "bug"],
                stream: detectStream(relPath)
            });
        }
    }

    return items;
}

// ─── Análisis: Fallos QA en logs anteriores ──────────────────────────────────

function detectQaFailures() {
    const items = [];

    if (!fs.existsSync(QA_DIR)) return items;

    try {
        const qaFiles = fs.readdirSync(QA_DIR)
            .filter(f => f.endsWith(".html") || f.endsWith(".md"))
            .sort()
            .reverse()
            .slice(0, 3); // Últimos 3 reportes

        for (const qaFile of qaFiles) {
            const content = fs.readFileSync(path.join(QA_DIR, qaFile), "utf8");

            // Buscar patrones de fallos en reportes HTML/MD
            const failPatterns = [
                /FALLO[:\s]+([^\n<]{10,80})/gi,
                /FAILED[:\s]+([^\n<]{10,80})/gi,
                /❌[:\s]*([^\n<]{10,80})/g,
                /ERROR[:\s]+([^\n<]{10,80})/gi
            ];

            for (const pattern of failPatterns) {
                let match;
                while ((match = pattern.exec(content)) !== null) {
                    const failDescription = match[1].trim().replace(/<[^>]+>/g, "");
                    if (failDescription.length < 10) continue;

                    items.push({
                        type: "qa_failure",
                        severity: "high",
                        title: `Resolver fallo QA: ${failDescription.substring(0, 60)}`,
                        description: `Fallo detectado en reporte QA ${qaFile}: ${failDescription}`,
                        file: `docs/qa/${qaFile}`,
                        effort: "M",
                        labels: ["backlog-tecnico", "bug", "qa"],
                        stream: "Stream A — Backend"
                    });
                }
            }
        }
    } catch (e) {
        log(`Error analizando logs QA: ${e.message}`);
    }

    // Deduplicar por título similar
    const seen = new Set();
    return items.filter(item => {
        const key = item.title.substring(0, 40);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ─── Análisis: Refactors incompletos via git log ─────────────────────────────

function detectIncompleteRefactors() {
    const items = [];

    // Buscar commits con "WIP", "temporal", "draft" en el mensaje
    const cmd = `git -C "${REPO_ROOT}" log --oneline -20 2>/dev/null`;
    const raw = execSafe(cmd);
    if (!raw) return items;

    const wipPatterns = /wip|temporal|draft|incompleto|pendiente|borrador/i;
    const lines = raw.split("\n").filter(Boolean);

    for (const line of lines) {
        const [hash, ...msgParts] = line.split(" ");
        const msg = msgParts.join(" ");
        if (wipPatterns.test(msg)) {
            items.push({
                type: "incomplete_refactor",
                severity: "medium",
                title: `Completar cambio WIP: ${msg.substring(0, 50)}`,
                description: `Commit marcado como incompleto/temporal: "${msg}"`,
                file: null,
                effort: "M",
                labels: ["backlog-tecnico", "enhancement"],
                stream: "Stream E — Cross-cutting"
            });
        }
    }

    return items;
}

// ─── Análisis: Imports no usados (básico) ─────────────────────────────────────

function detectUnusedDependencies() {
    const items = [];

    // Verificar si hay libs en gradle que puedan estar obsoletas
    const buildGradleFiles = [
        path.join(REPO_ROOT, "buildSrc", "src", "main", "kotlin", "Dependencies.kt"),
        path.join(REPO_ROOT, "app", "composeApp", "build.gradle.kts"),
        path.join(REPO_ROOT, "backend", "build.gradle.kts")
    ];

    for (const file of buildGradleFiles) {
        if (!fs.existsSync(file)) continue;
        const content = fs.readFileSync(file, "utf8");

        // Buscar versiones hardcodeadas fuera de Dependencies.kt (patrón de deuda)
        const hardcoded = content.match(/version\s*=\s*["']\d+\.\d+[\.\d]*["']/g);
        if (hardcoded && hardcoded.length > 3) {
            const relPath = file.replace(REPO_ROOT, "").replace(/^[/\\]/, "");
            items.push({
                type: "hardcoded_versions",
                severity: "low",
                title: `Centralizar versiones en ${path.basename(file)}`,
                description: `${hardcoded.length} versiones hardcodeadas fuera del catálogo de dependencias`,
                file: relPath,
                effort: "S",
                labels: ["backlog-tecnico", "enhancement"],
                stream: "Stream E — Cross-cutting"
            });
        }
    }

    return items;
}

// ─── Helper: detectar stream según path ─────────────────────────────────────

function detectStream(filePath) {
    if (!filePath) return "Stream E — Cross-cutting";
    if (filePath.includes("backend/") || filePath.includes("users/")) return "Stream A — Backend";
    if (filePath.includes("/client/")) return "Stream B — Cliente";
    if (filePath.includes("/business/")) return "Stream C — Negocio";
    if (filePath.includes("/delivery/")) return "Stream D — Delivery";
    return "Stream E — Cross-cutting";
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    log("Iniciando análisis de deuda técnica...");

    const allItems = [];

    // Ejecutar todos los análisis
    log("1/5 Buscando TODOs/FIXMEs...");
    allItems.push(...detectTodoFixme());

    log("2/5 Verificando tests faltantes...");
    allItems.push(...detectMissingTests());

    log("3/5 Detectando strings legacy...");
    allItems.push(...detectLegacyStrings());

    log("4/5 Analizando logs QA...");
    allItems.push(...detectQaFailures());

    log("5/5 Detectando refactors incompletos...");
    allItems.push(...detectIncompleteRefactors());
    allItems.push(...detectUnusedDependencies());

    // Ordenar por severidad: high > medium > low
    const severityOrder = { high: 0, medium: 1, low: 2 };
    allItems.sort((a, b) => (severityOrder[a.severity] || 1) - (severityOrder[b.severity] || 1));

    // Limitar cantidad
    const limited = allItems.slice(0, LIMIT);

    log(`Análisis completo: ${allItems.length} items detectados, mostrando ${limited.length}`);

    if (OUTPUT_JSON) {
        console.log(JSON.stringify({ items: limited, total: allItems.length }, null, 2));
    } else {
        console.log(`\n=== Deuda Técnica Detectada (${limited.length}/${allItems.length} items) ===\n`);
        for (const item of limited) {
            const sev = item.severity === "high" ? "🔴" : item.severity === "medium" ? "🟡" : "🟢";
            console.log(`${sev} [${item.type}] ${item.title}`);
            console.log(`   ${item.description}`);
            if (item.file) console.log(`   Archivo: ${item.file}${item.line ? ":" + item.line : ""}`);
            console.log(`   Esfuerzo: ${item.effort} | Stream: ${item.stream}`);
            console.log();
        }
    }

    return { items: limited, total: allItems.length };
}

main().catch(e => {
    log(`Error fatal: ${e.message}`);
    if (OUTPUT_JSON) {
        console.log(JSON.stringify({ items: [], total: 0, error: e.message }));
    }
    process.exit(1);
});
