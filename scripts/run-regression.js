#!/usr/bin/env node
// run-regression.js — Gate de regresión QA E2E para cierre de sprint (#1806)
// Ejecuta la suite qa/regression-suite.json contra el emulador y genera reporte.
//
// Flujo:
//   1. Lee qa/regression-suite.json (graceful si no existe → skip)
//   2. Verifica emulador disponible via ADB
//   3. Para cada test case: ejecuta el flow Maestro correspondiente
//   4. Genera qa/regression/SPR-XXXX-regression.json con resultados
//   5. Si hay fallos: crea issues GitHub con label regression-fail
//   6. Notifica por Telegram con resumen
//
// Uso:
//   node scripts/run-regression.js                        # usa sprint_id del plan
//   node scripts/run-regression.js SPR-0051               # sprint_id explícito
//   node scripts/run-regression.js --dry-run              # sin emulador, todo skipped
//
// Timeout: QA_REGRESSION_TIMEOUT_MS (default: 900000 = 15 min)

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

// --- Config ---
const REPO_ROOT = path.resolve(__dirname, "..");
const SUITE_PATH = path.join(REPO_ROOT, "qa", "regression-suite.json");
const REGRESSION_DIR = path.join(REPO_ROOT, "qa", "regression");
const MAESTRO_FLOWS_DIR = path.join(REPO_ROOT, ".maestro", "flows");
const PLAN_PATH = path.join(__dirname, "sprint-plan.json");
const GH_PATH = "C:\\Workspaces\\gh-cli\\bin\\gh.exe";
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "run-regression.log");
const TIMEOUT_MS = parseInt(process.env.QA_REGRESSION_TIMEOUT_MS || "900000", 10);
const ADB_PATH = process.env.ANDROID_SDK
    ? path.join(process.env.ANDROID_SDK, "platform-tools", "adb")
    : path.join(process.env.HOME || "C:\\Users\\Administrator", "AppData", "Local", "Android", "Sdk", "platform-tools", "adb");

// --- Logging ---
function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
    ensureDir(LOG_DIR);
    const ts = new Date().toISOString();
    const line = `[${ts}] ${msg}`;
    try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) { /* ignore */ }
    console.log(line);
}

function execSafe(cmd, opts = {}) {
    try {
        return execSync(cmd, { encoding: "utf8", timeout: 30000, ...opts }).trim();
    } catch (e) {
        log(`execSafe failed: ${cmd.substring(0, 100)} → ${e.message.substring(0, 200)}`);
        return null;
    }
}

// --- Suite ---

/**
 * Lee y valida qa/regression-suite.json.
 * Retorna null si no existe o está vacía (graceful skip).
 */
function loadSuite(suitePath) {
    if (!fs.existsSync(suitePath)) {
        log(`Suite no encontrada en ${suitePath} — skip graceful`);
        return null;
    }
    try {
        const suite = JSON.parse(fs.readFileSync(suitePath, "utf8"));
        if (!suite || !Array.isArray(suite.test_cases) || suite.test_cases.length === 0) {
            log("Suite vacía o inválida — skip graceful");
            return null;
        }
        return suite;
    } catch (e) {
        log(`Error parseando suite: ${e.message} — skip graceful`);
        return null;
    }
}

// --- Emulador ---

/**
 * Verifica si hay un emulador Android accesible via ADB.
 * Retorna el device ID o null si no hay dispositivo.
 */
function checkEmulatorAvailable() {
    try {
        const result = spawnSync(ADB_PATH, ["devices"], { encoding: "utf8", timeout: 10000 });
        if (result.status !== 0) return null;
        const lines = (result.stdout || "").split("\n").filter(l => l.includes("emulator") && l.includes("device"));
        if (lines.length === 0) return null;
        return lines[0].split("\t")[0].trim();
    } catch (e) {
        log(`ADB no disponible: ${e.message}`);
        return null;
    }
}

// --- Ejecución de test cases ---

/**
 * Ejecuta un test case individual via Maestro.
 * Retorna { passed, skipped, error, durationMs }.
 */
function runTestCase(testCase, opts = {}) {
    const { dryRun = false, deviceId = null } = opts;
    const flowPath = path.join(MAESTRO_FLOWS_DIR, testCase.flow);
    const start = Date.now();

    if (dryRun) {
        log(`[DRY-RUN] ${testCase.id}: ${testCase.title} → skipped`);
        return { passed: false, skipped: true, error: null, durationMs: 0 };
    }

    if (!fs.existsSync(flowPath)) {
        log(`${testCase.id}: flow no encontrado: ${flowPath} → skip`);
        return { passed: false, skipped: true, error: `Flow no encontrado: ${testCase.flow}`, durationMs: 0 };
    }

    try {
        const maestroArgs = ["test", flowPath, "--format", "junit"];
        if (deviceId) maestroArgs.push("--device", deviceId);

        const result = spawnSync("maestro", maestroArgs, {
            encoding: "utf8",
            timeout: 120000,  // 2 min por test case
            cwd: REPO_ROOT
        });

        const durationMs = Date.now() - start;
        if (result.status === 0) {
            log(`${testCase.id}: PASS (${durationMs}ms)`);
            return { passed: true, skipped: false, error: null, durationMs };
        } else {
            const errOutput = (result.stderr || result.stdout || "").substring(0, 500);
            log(`${testCase.id}: FAIL (${durationMs}ms) — ${errOutput}`);
            return { passed: false, skipped: false, error: errOutput, durationMs };
        }
    } catch (e) {
        const durationMs = Date.now() - start;
        log(`${testCase.id}: ERROR — ${e.message}`);
        return { passed: false, skipped: false, error: e.message, durationMs };
    }
}

// --- Reporte ---

/**
 * Genera el archivo JSON de resultados de regresión.
 * Ruta: qa/regression/SPR-XXXX-regression.json
 */
function generateReport(sprintId, results, suite) {
    ensureDir(REGRESSION_DIR);
    const label = sprintId || new Date().toISOString().split("T")[0];
    const reportPath = path.join(REGRESSION_DIR, `${label}-regression.json`);

    const passed = results.filter(r => r.result.passed).length;
    const failed = results.filter(r => !r.result.passed && !r.result.skipped).length;
    const skipped = results.filter(r => r.result.skipped).length;
    const total = results.length;

    const report = {
        sprint_id: sprintId || null,
        suite: suite.suite,
        timestamp: new Date().toISOString(),
        summary: { total, passed, failed, skipped },
        passed: failed === 0 && skipped < total,
        results: results.map(r => ({
            id: r.testCase.id,
            title: r.testCase.title,
            app: r.testCase.app,
            flow: r.testCase.flow,
            passed: r.result.passed,
            skipped: r.result.skipped,
            error: r.result.error || null,
            durationMs: r.result.durationMs
        }))
    };

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    log(`Reporte generado: ${reportPath}`);
    return { report, reportPath };
}

/**
 * Lee el reporte de regresión de un sprint.
 * Retorna null si no existe.
 */
function loadRegressionReport(sprintId) {
    if (!sprintId) return null;
    const reportPath = path.join(REGRESSION_DIR, `${sprintId}-regression.json`);
    if (!fs.existsSync(reportPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(reportPath, "utf8"));
    } catch (e) {
        return null;
    }
}

// --- GitHub issues para fallos ---

/**
 * Crea un issue GitHub para un test case fallido.
 * Retorna el número del issue creado o null si falla.
 */
function createRegressionIssue(testCase, sprintId, error) {
    try {
        const title = `[regression-fail] ${testCase.id}: ${testCase.title} — ${sprintId || "sprint"}`;
        const body = [
            `## Fallo de Regresión`,
            ``,
            `**Sprint:** ${sprintId || "N/A"}`,
            `**Test:** ${testCase.id} — ${testCase.title}`,
            `**App:** ${testCase.app}`,
            `**Flow:** \`${testCase.flow}\``,
            `**Tags:** ${(testCase.tags || []).join(", ")}`,
            ``,
            `## Error`,
            `\`\`\``,
            (error || "Sin detalles del error").substring(0, 2000),
            `\`\`\``,
            ``,
            `## Acción requerida`,
            `- Investigar y corregir el fallo en la feature correspondiente`,
            `- Re-ejecutar la suite de regresión para confirmar fix`,
            `- Este issue es carry-over obligatorio del siguiente sprint`,
            ``,
            `> Generado automáticamente por el gate de regresión al cierre del sprint.`
        ].join("\n");

        const result = execSafe(
            `"${GH_PATH}" issue create --repo intrale/platform --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"').replace(/\n/g, "\\n")}" --label "regression-fail" --label "bug" --assignee leitolarreta`,
            { timeout: 30000 }
        );

        if (result) {
            // Extraer número del URL del issue
            const match = result.match(/\/issues\/(\d+)/);
            if (match) {
                log(`Issue creado para ${testCase.id}: #${match[1]}`);
                return parseInt(match[1], 10);
            }
        }
        return null;
    } catch (e) {
        log(`Error creando issue para ${testCase.id}: ${e.message}`);
        return null;
    }
}

// --- Notificación Telegram ---

/**
 * Envía notificación Telegram con resultado de la regresión.
 */
function notifyTelegram(report, createdIssues) {
    try {
        const telegramClientPath = path.join(HOOKS_DIR, "telegram-client.js");
        if (!fs.existsSync(telegramClientPath)) {
            log("telegram-client.js no encontrado — skip notificación");
            return;
        }

        const { sendMessage } = require(telegramClientPath);
        const { summary, sprint_id, passed } = report;
        const icon = passed ? "✅" : "⚠️";
        const sprintLabel = sprint_id || "sprint";

        let text;
        if (passed) {
            text = `${icon} <b>Regresión ${sprintLabel}</b>: ${summary.passed}/${summary.total} tests pasaron`;
            if (summary.skipped > 0) {
                text += ` (${summary.skipped} skipped — sin emulador)`;
            }
        } else {
            const issueRefs = createdIssues.length > 0
                ? ` → issues ${createdIssues.map(n => `#${n}`).join(", ")} creados`
                : "";
            text = `${icon} <b>Regresión ${sprintLabel}</b>: ${summary.failed}/${summary.total} tests fallaron${issueRefs}`;
        }

        sendMessage(text, { parse_mode: "HTML" })
            .then(() => log("Notificación Telegram enviada"))
            .catch(e => log(`Error enviando Telegram: ${e.message}`));
    } catch (e) {
        log(`Error en notifyTelegram: ${e.message}`);
    }
}

// --- Runner principal ---

/**
 * Ejecuta la suite de regresión completa.
 * Retorna el objeto report o null si se saltó (graceful).
 */
async function runRegressionSuite(opts = {}) {
    const { sprintId, dryRun = false } = opts;
    const start = Date.now();
    log(`=== run-regression.js iniciado (sprint=${sprintId || "N/A"}, dryRun=${dryRun}) ===`);

    // 1. Cargar suite (graceful skip si no existe)
    const suite = loadSuite(SUITE_PATH);
    if (!suite) {
        log("Suite vacía o inexistente — skip graceful sin error");
        return null;
    }

    log(`Suite cargada: ${suite.test_cases.length} test cases`);

    // 2. Verificar emulador
    let deviceId = null;
    if (!dryRun) {
        deviceId = checkEmulatorAvailable();
        if (!deviceId) {
            log("Emulador no disponible — todos los tests se marcan como skipped");
        } else {
            log(`Emulador disponible: ${deviceId}`);
        }
    }

    const effectiveDryRun = dryRun || !deviceId;

    // 3. Ejecutar cada test case
    const results = [];
    for (const testCase of suite.test_cases) {
        log(`Ejecutando ${testCase.id}: ${testCase.title}...`);
        const result = runTestCase(testCase, { dryRun: effectiveDryRun, deviceId });
        results.push({ testCase, result });
    }

    // 4. Generar reporte
    const { report, reportPath } = generateReport(sprintId, results, suite);

    const { summary } = report;
    log(`Regresión completada: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);

    // 5. Crear issues para fallos (solo si hubo fallos reales, no skipped)
    const failures = results.filter(r => !r.result.passed && !r.result.skipped);
    const createdIssues = [];

    if (failures.length > 0) {
        log(`Creando ${failures.length} issue(s) de regression-fail...`);
        for (const { testCase, result } of failures) {
            const issueNum = createRegressionIssue(testCase, sprintId, result.error);
            if (issueNum) createdIssues.push(issueNum);
        }
        log(`Issues creados: ${createdIssues.join(", ")}`);
    }

    // 6. Notificar Telegram
    notifyTelegram(report, createdIssues);

    const elapsed = Math.round((Date.now() - start) / 1000);
    log(`=== run-regression.js completado en ${elapsed}s ===`);

    return report;
}

// --- Entrada por CLI ---
if (require.main === module) {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const sprintId = args.find(a => !a.startsWith("--")) || (() => {
        try {
            const plan = JSON.parse(fs.readFileSync(PLAN_PATH, "utf8"));
            return plan.sprint_id || null;
        } catch (e) {
            return null;
        }
    })();

    runRegressionSuite({ sprintId, dryRun })
        .then(report => {
            if (!report) {
                log("Regresión saltada (suite vacía/inexistente o emulador no disponible).");
                process.exit(0);
            }
            const { summary } = report;
            if (summary.failed > 0) {
                log(`Regresión FALLIDA: ${summary.failed} test(s) fallaron. Issues creados.`);
                // Exit 0 para no interrumpir el pipeline (el sprint se cierra igual)
                process.exit(0);
            }
            log("Regresión PASADA.");
            process.exit(0);
        })
        .catch(e => {
            log(`ERROR FATAL: ${e.message}\n${e.stack}`);
            process.exit(0); // fail-open
        });
}

// --- Exports para testing y sprint-report.js ---
module.exports = {
    loadSuite,
    checkEmulatorAvailable,
    runTestCase,
    generateReport,
    loadRegressionReport,
    createRegressionIssue,
    runRegressionSuite,
    SUITE_PATH,
    REGRESSION_DIR
};
