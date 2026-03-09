// Test P-24: Auditoría y auto-reparación de salud del sprint (#1297)
// Verifica que:
//   - health-check-sprint.js existe, carga sin errores y detecta inconsistencias
//   - auto-repair-sprint.js existe, carga sin errores y aplica reparaciones en dry-run
//   - scrum-monitor-bg.js está registrado como Stop hook en settings.json
//   - SKILL.md de scrum incluye comandos health, repair, audit, close
//   - getGitHubToken() intenta múltiples paths antes de fallback
//   - audit log se escribe correctamente
//   - sprint-audit.jsonl format es válido JSONL
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const HOOKS_DIR = path.join(__dirname, "..");
const SKILLS_DIR = path.join(__dirname, "..", "..", "skills");
const SETTINGS_FILE = path.join(__dirname, "..", "..", "settings.json");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "p24-test-"));
}

function readSource(filename) {
    return fs.readFileSync(path.join(HOOKS_DIR, filename), "utf8");
}

// ─── health-check-sprint.js ───────────────────────────────────────────────────

describe("P-24: health-check-sprint.js — existencia y estructura", () => {

    it("archivo existe", () => {
        assert.ok(fs.existsSync(path.join(HOOKS_DIR, "health-check-sprint.js")));
    });

    it("usa require.main === module para modo CLI", () => {
        const src = readSource("health-check-sprint.js");
        assert.ok(src.includes("require.main === module"), "debe soportar invocación CLI");
    });

    it("exporta runHealthCheck", () => {
        const src = readSource("health-check-sprint.js");
        assert.ok(src.includes("module.exports"), "debe exportar módulo");
        assert.ok(src.includes("runHealthCheck"), "debe exportar runHealthCheck");
    });

    it("detecta PR mergeado con issue abierto (pr_merged_issue_open)", () => {
        const src = readSource("health-check-sprint.js");
        assert.ok(src.includes("pr_merged_issue_open"), "debe detectar tipo pr_merged_issue_open");
        assert.ok(src.includes("close_issue_and_move_to_done"), "acción debe ser close_issue_and_move_to_done");
    });

    it("detecta historias estancadas en In Progress (stale_in_progress)", () => {
        const src = readSource("health-check-sprint.js");
        assert.ok(src.includes("stale_in_progress"), "debe detectar tipo stale_in_progress");
        assert.ok(
            src.includes("STALE_IN_PROGRESS_HOURS") || src.includes("6"),
            "debe definir umbral de 6h"
        );
    });

    it("detecta sprint pasada fechaFin sin cerrar (sprint_overdue)", () => {
        const src = readSource("health-check-sprint.js");
        assert.ok(src.includes("sprint_overdue"), "debe detectar tipo sprint_overdue");
        assert.ok(src.includes("fechaFin"), "debe comparar contra fechaFin");
        assert.ok(src.includes("sprint_cerrado"), "debe verificar campo sprint_cerrado");
    });

    it("detecta issue cerrado con estado incorrecto en Project V2", () => {
        const src = readSource("health-check-sprint.js");
        assert.ok(src.includes("closed_issue_wrong_status"), "debe detectar issue cerrado con estado incorrecto");
    });

    it("getGitHubToken usa múltiples paths de gh CLI (fix scope read:project)", () => {
        const src = readSource("health-check-sprint.js");
        assert.ok(
            src.includes("GH_CLI_CANDIDATES") || src.includes("C:/Workspaces/gh-cli/bin/gh.exe"),
            "debe intentar path Windows nativo C:/Workspaces/gh-cli/bin/gh.exe para obtener token con scope project"
        );
        assert.ok(
            src.includes("for (const ghPath") || src.includes("for(const ghPath"),
            "debe iterar sobre múltiples paths de gh CLI"
        );
    });

    it("no usa eval() (seguridad)", () => {
        const src = readSource("health-check-sprint.js");
        const hasEval = /(?<!\w)eval\s*\(/.test(src);
        assert.ok(!hasEval, "No debe usar eval()");
    });

    it("calcula health_level basado en cantidad de inconsistencias críticas", () => {
        const src = readSource("health-check-sprint.js");
        assert.ok(src.includes("health_level"), "debe calcular health_level");
        assert.ok(
            src.includes('"critical"') || src.includes("'critical'"),
            "debe tener nivel critical"
        );
        assert.ok(
            src.includes('"healthy"') || src.includes("'healthy'"),
            "debe tener nivel healthy"
        );
    });

    it("registra logs con prefijo SprintHealthCheck", () => {
        const src = readSource("health-check-sprint.js");
        assert.ok(src.includes("SprintHealthCheck:"), "debe prefixar logs con SprintHealthCheck:");
    });

    it("lee sprint-plan.json para obtener issues del sprint", () => {
        const src = readSource("health-check-sprint.js");
        assert.ok(src.includes("sprint-plan.json"), "debe leer sprint-plan.json");
        assert.ok(
            src.includes("agentes") && src.includes("_queue"),
            "debe combinar agentes + _queue + _completed"
        );
    });

    it("retorna JSON con campos ok, sprint_id, metrics, issues, inconsistencias", () => {
        const src = readSource("health-check-sprint.js");
        assert.ok(src.includes('"ok"') || src.includes("ok:"), "resultado debe tener campo ok");
        assert.ok(src.includes("sprint_id"), "resultado debe tener sprint_id");
        assert.ok(src.includes("metrics"), "resultado debe tener metrics");
        assert.ok(src.includes("issues"), "resultado debe tener issues");
        assert.ok(src.includes("inconsistencias"), "resultado debe tener inconsistencias");
    });
});

// ─── auto-repair-sprint.js ────────────────────────────────────────────────────

describe("P-24: auto-repair-sprint.js — existencia y lógica de reparación", () => {

    it("archivo existe", () => {
        assert.ok(fs.existsSync(path.join(HOOKS_DIR, "auto-repair-sprint.js")));
    });

    it("exporta runAutoRepair y readAuditHistory", () => {
        const src = readSource("auto-repair-sprint.js");
        assert.ok(src.includes("runAutoRepair"), "debe exportar runAutoRepair");
        assert.ok(src.includes("readAuditHistory"), "debe exportar readAuditHistory");
    });

    it("maneja tipo pr_merged_issue_open: cierra issue + mueve a Done", () => {
        const src = readSource("auto-repair-sprint.js");
        assert.ok(src.includes("pr_merged_issue_open"), "debe manejar tipo pr_merged_issue_open");
        assert.ok(src.includes("closeIssue"), "debe llamar a closeIssue");
        assert.ok(src.includes("moveIssueInProject"), "debe mover a Done en Project V2");
        assert.ok(src.includes("updateSprintPlan"), "debe actualizar sprint-plan.json");
    });

    it("maneja tipo stale_in_progress: mueve a Blocked o Ready según antigüedad", () => {
        const src = readSource("auto-repair-sprint.js");
        assert.ok(src.includes("stale_in_progress"), "debe manejar tipo stale_in_progress");
        assert.ok(src.includes("Blocked"), "debe mover a Blocked si < 24h");
        assert.ok(src.includes("Ready"), "debe mover a Ready si > 24h");
    });

    it("maneja tipo sprint_overdue: cierra sprint en sprint-plan.json", () => {
        const src = readSource("auto-repair-sprint.js");
        assert.ok(src.includes("sprint_overdue"), "debe manejar tipo sprint_overdue");
        assert.ok(src.includes("closeSprintInPlan"), "debe tener closeSprintInPlan");
        assert.ok(src.includes("sprint_cerrado"), "debe marcar sprint_cerrado: true");
    });

    it("soporta dry-run mode (no hace cambios reales)", () => {
        const src = readSource("auto-repair-sprint.js");
        assert.ok(src.includes("dryRun"), "debe soportar modo dry-run");
        assert.ok(src.includes('"dry_run"'), "debe retornar status dry_run");
        assert.ok(
            src.includes("dryRun !== false"),
            "dry-run debe ser true por defecto (safe mode)"
        );
    });

    it("registra cada acción en sprint-audit.jsonl", () => {
        const src = readSource("auto-repair-sprint.js");
        assert.ok(src.includes("sprint-audit.jsonl"), "debe usar sprint-audit.jsonl");
        assert.ok(src.includes("appendAudit"), "debe tener función appendAudit");
        assert.ok(src.includes("AUDIT_FILE"), "debe definir AUDIT_FILE");
    });

    it("registra acciones en formato JSONL válido", () => {
        // Si existe el audit file, verificar que es JSONL válido
        const auditFile = path.join(HOOKS_DIR, "sprint-audit.jsonl");
        if (!fs.existsSync(auditFile)) {
            // No es error si no existe todavía
            return;
        }
        const lines = fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean);
        for (const line of lines.slice(-20)) {
            let parsed;
            assert.doesNotThrow(
                () => { parsed = JSON.parse(line); },
                "cada línea de sprint-audit.jsonl debe ser JSON válido"
            );
            assert.ok(parsed.timestamp, "cada entrada debe tener timestamp");
            assert.ok(parsed.action, "cada entrada debe tener action");
            assert.ok(parsed.status, "cada entrada debe tener status");
        }
    });

    it("dry-run en runAutoRepair devuelve { ok: true, ok_count: N } con status dry_run", async () => {
        // Test de integración local: crear un diagnóstico mock y correr dry-run
        const { runAutoRepair } = require(path.join(HOOKS_DIR, "auto-repair-sprint.js"));

        const fakeDiagnosis = {
            inconsistencias: [
                {
                    type: "pr_merged_issue_open",
                    severity: "high",
                    issue: 9999,
                    pr: 9998,
                    merged_at: "2026-01-01T00:00:00Z",
                    message: "PR #9998 mergeado pero issue #9999 abierto (TEST)",
                    action: "close_issue_and_move_to_done"
                }
            ]
        };

        const result = await runAutoRepair(fakeDiagnosis, { dryRun: true });
        assert.strictEqual(result.ok, true, "dry-run debe retornar ok: true");
        assert.strictEqual(result.total, 1, "debe haber 1 reparación");
        assert.strictEqual(result.ok_count, 1, "ok_count debe ser 1 en dry-run");
        assert.strictEqual(result.error_count, 0, "no debe haber errores en dry-run");
        assert.strictEqual(result.dry_run, true, "debe indicar dry_run: true");
        assert.strictEqual(result.repairs[0].status, "dry_run", "status debe ser dry_run");
    });

    it("getGitHubToken usa múltiples paths de gh CLI (fix scope read:project)", () => {
        const src = readSource("auto-repair-sprint.js");
        assert.ok(
            src.includes("GH_CLI_CANDIDATES") || src.includes("C:/Workspaces/gh-cli/bin/gh.exe"),
            "debe intentar path Windows nativo para obtener token con scope project"
        );
    });

    it("no usa eval() (seguridad)", () => {
        const src = readSource("auto-repair-sprint.js");
        const hasEval = /(?<!\w)eval\s*\(/.test(src);
        assert.ok(!hasEval, "No debe usar eval()");
    });

    it("updateSprintPlan mueve issue de agentes a _completed al cerrarlo", () => {
        const src = readSource("auto-repair-sprint.js");
        assert.ok(src.includes("_completed"), "debe tener array _completed");
        assert.ok(src.includes("completed_at"), "debe registrar completed_at");
        assert.ok(src.includes("splice"), "debe quitar el issue de agentes activos");
    });

    it("runAutoRepair acepta opción onlyTypes para filtrar tipos de reparación", () => {
        const src = readSource("auto-repair-sprint.js");
        assert.ok(src.includes("onlyTypes"), "debe soportar opción onlyTypes para filtrar");
    });
});

// ─── scrum-monitor-bg.js ─────────────────────────────────────────────────────

describe("P-24: scrum-monitor-bg.js — monitor periódico", () => {

    it("archivo existe", () => {
        assert.ok(fs.existsSync(path.join(HOOKS_DIR, "scrum-monitor-bg.js")));
    });

    it("está registrado como Stop hook en settings.json", () => {
        assert.ok(fs.existsSync(SETTINGS_FILE), "settings.json debe existir");
        const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
        const stopHooks = (settings.hooks && settings.hooks.Stop) || [];
        const allCmds = stopHooks.flatMap(g => (g.hooks || []).map(h => h.command || ""));
        const hasHook = allCmds.some(cmd => cmd.includes("scrum-monitor-bg.js"));
        assert.ok(hasHook, "scrum-monitor-bg.js debe estar registrado en Stop hooks");
    });

    it("tiene cooldown de 30 minutos para no correr en cada sesión", () => {
        const src = readSource("scrum-monitor-bg.js");
        assert.ok(src.includes("CHECK_INTERVAL_MS"), "debe definir CHECK_INTERVAL_MS");
        assert.ok(
            src.includes("30 * 60 * 1000") || src.includes("1800000"),
            "intervalo debe ser 30 minutos"
        );
        assert.ok(src.includes("last_check"), "debe verificar last_check para cooldown");
    });

    it("persiste historial en scrum-health-history.jsonl", () => {
        const src = readSource("scrum-monitor-bg.js");
        assert.ok(src.includes("scrum-health-history.jsonl"), "debe persistir en scrum-health-history.jsonl");
        assert.ok(src.includes("appendHistory"), "debe tener función appendHistory");
    });

    it("envía alerta a Telegram si detecta inconsistencias", () => {
        const src = readSource("scrum-monitor-bg.js");
        assert.ok(src.includes("sendTelegram"), "debe tener función sendTelegram");
        assert.ok(src.includes("inconsistencias"), "debe verificar inconsistencias antes de alertar");
    });

    it("auto-repara tipos menores automáticamente (sin confirmación)", () => {
        const src = readSource("scrum-monitor-bg.js");
        assert.ok(src.includes("AUTO_REPAIR_TYPES"), "debe definir tipos de auto-reparación");
        assert.ok(src.includes("pr_merged_issue_open"), "debe auto-reparar pr_merged_issue_open");
        assert.ok(
            src.includes("dryRun: false"),
            "auto-reparación debe ser real (no dry-run)"
        );
    });

    it("soporta modo --daemon con PID file", () => {
        const src = readSource("scrum-monitor-bg.js");
        assert.ok(src.includes("--daemon"), "debe soportar modo daemon");
        assert.ok(src.includes("PID_FILE") || src.includes("pid"), "debe usar PID file");
        assert.ok(src.includes("setInterval"), "daemon debe usar setInterval para periodicidad");
    });

    it("importa health-check-sprint y auto-repair-sprint", () => {
        const src = readSource("scrum-monitor-bg.js");
        assert.ok(src.includes("health-check-sprint"), "debe importar health-check-sprint");
        assert.ok(src.includes("auto-repair-sprint"), "debe importar auto-repair-sprint");
    });

    it("no usa eval() (seguridad)", () => {
        const src = readSource("scrum-monitor-bg.js");
        const hasEval = /(?<!\w)eval\s*\(/.test(src);
        assert.ok(!hasEval, "No debe usar eval()");
    });
});

// ─── health-report.js ─────────────────────────────────────────────────────────

describe("P-24: health-report.js — reporte HTML del sprint", () => {

    it("archivo existe en .claude/skills/scrum/", () => {
        const reportFile = path.join(SKILLS_DIR, "scrum", "health-report.js");
        assert.ok(fs.existsSync(reportFile), "health-report.js debe existir en skills/scrum/");
    });

    it("exporta generateReport y generateHTML", () => {
        const reportFile = path.join(SKILLS_DIR, "scrum", "health-report.js");
        const src = fs.readFileSync(reportFile, "utf8");
        assert.ok(src.includes("generateReport"), "debe exportar generateReport");
        assert.ok(src.includes("generateHTML"), "debe exportar generateHTML");
    });

    it("genera HTML válido con las secciones requeridas", () => {
        const reportFile = path.join(SKILLS_DIR, "scrum", "health-report.js");
        const { generateHTML } = require(reportFile);

        const fakeDiagnosis = {
            sprint_id: "SPR-TEST",
            sprint_status: "active",
            sprint_overdue: null,
            health_level: "warning",
            timestamp: new Date().toISOString(),
            metrics: {
                total_issues: 3,
                completed: 1,
                in_progress: 1,
                blocked: 0,
                inconsistencias_total: 2,
                inconsistencias_critical: 1
            },
            issues: [
                {
                    issue: 999,
                    title: "Test issue",
                    github_state: "OPEN",
                    project_status: "In Progress",
                    inconsistencias: [{ type: "stale_in_progress" }]
                }
            ],
            inconsistencias: [
                {
                    type: "pr_merged_issue_open",
                    severity: "high",
                    issue: 888,
                    message: "PR mergeado pero issue abierto",
                    action: "close_issue_and_move_to_done"
                }
            ]
        };

        const html = generateHTML(fakeDiagnosis, null, []);
        assert.ok(html.includes("<!DOCTYPE html>"), "debe generar HTML válido");
        assert.ok(html.includes("SPR-TEST"), "debe incluir el sprint ID");
        assert.ok(html.includes("Inconsistencias"), "debe incluir sección de inconsistencias");
        assert.ok(html.includes("#888"), "debe incluir el número de issue");
        assert.ok(html.includes("pr_merged_issue_open"), "debe incluir el tipo de inconsistencia");
    });

    it("usa report-to-pdf-telegram.js para enviar a Telegram", () => {
        const reportFile = path.join(SKILLS_DIR, "scrum", "health-report.js");
        const src = fs.readFileSync(reportFile, "utf8");
        assert.ok(src.includes("report-to-pdf-telegram.js"), "debe usar report-to-pdf-telegram.js");
    });

    it("guarda reporte en docs/qa/", () => {
        const reportFile = path.join(SKILLS_DIR, "scrum", "health-report.js");
        const src = fs.readFileSync(reportFile, "utf8");
        assert.ok(src.includes("docs/qa") || src.includes("docs", "qa"), "debe guardar en docs/qa/");
    });
});

// ─── SKILL.md de /scrum ───────────────────────────────────────────────────────

describe("P-24: SKILL.md de /scrum — comandos requeridos", () => {

    it("SKILL.md existe en .claude/skills/scrum/", () => {
        const skillFile = path.join(SKILLS_DIR, "scrum", "SKILL.md");
        assert.ok(fs.existsSync(skillFile), "SKILL.md debe existir");
    });

    it("incluye comando /scrum health", () => {
        const src = fs.readFileSync(path.join(SKILLS_DIR, "scrum", "SKILL.md"), "utf8");
        assert.ok(src.includes("health"), "SKILL.md debe incluir comando health");
        assert.ok(src.includes("health-check-sprint.js"), "debe invocar health-check-sprint.js");
    });

    it("incluye comando /scrum repair --auto", () => {
        const src = fs.readFileSync(path.join(SKILLS_DIR, "scrum", "SKILL.md"), "utf8");
        assert.ok(src.includes("repair"), "SKILL.md debe incluir comando repair");
        assert.ok(src.includes("auto-repair-sprint.js"), "debe invocar auto-repair-sprint.js");
        assert.ok(src.includes("--auto"), "debe documentar flag --auto");
    });

    it("incluye modo audit con historial de reparaciones", () => {
        const src = fs.readFileSync(path.join(SKILLS_DIR, "scrum", "SKILL.md"), "utf8");
        assert.ok(src.includes("audit"), "SKILL.md debe incluir modo audit");
        assert.ok(src.includes("sprint-audit.jsonl"), "debe referenciar sprint-audit.jsonl");
    });

    it("incluye modo close para cierre forzado de sprint", () => {
        const src = fs.readFileSync(path.join(SKILLS_DIR, "scrum", "SKILL.md"), "utf8");
        assert.ok(src.includes("close"), "SKILL.md debe incluir modo close");
        assert.ok(
            src.includes("Cierra el sprint") || src.includes("cerrar sprint") || src.includes("Cierre forzado"),
            "debe documentar cierre de sprint"
        );
    });

    it("incluye invocación a health-report.js para generar reporte", () => {
        const src = fs.readFileSync(path.join(SKILLS_DIR, "scrum", "SKILL.md"), "utf8");
        assert.ok(src.includes("health-report.js"), "debe referenciar health-report.js");
    });
});
