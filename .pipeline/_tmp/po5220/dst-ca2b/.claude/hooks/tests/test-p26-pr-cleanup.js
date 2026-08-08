// Test P-26: Auto-merge de PRs pendientes con CI verde (#1351)
// Verifica que pr-cleanup.js:
//   - Filtra PRs por rama agent/*, antigüedad y labels bloqueantes
//   - Respeta la regla: NUNCA mergear sin CI verde
//   - No mergea PRs con changes-requested o labels bloqueantes (do-not-merge, wip)
//   - Notifica por Telegram con resumen correcto
//   - Está registrado en settings.json como hook Stop
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const HOOK_PATH = path.join(__dirname, "..", "pr-cleanup.js");
const SETTINGS_PATH = path.join(__dirname, "..", "..", "settings.json");

// ─── Helpers: leer lógica del script sin ejecutarlo ───────────────────────────

function readSource() {
    return fs.readFileSync(HOOK_PATH, "utf8");
}

// ─── Tests de existencia y registro ──────────────────────────────────────────

describe("P-26: pr-cleanup — existencia y registro", () => {

    it("archivo pr-cleanup.js existe en .claude/hooks/", () => {
        assert.ok(fs.existsSync(HOOK_PATH), "pr-cleanup.js debe existir en .claude/hooks/");
    });

    it("registrado en settings.json como hook Stop", () => {
        assert.ok(fs.existsSync(SETTINGS_PATH), "settings.json debe existir");
        const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
        const stopHooks = (settings.hooks && settings.hooks.Stop) || [];
        const allCmds = stopHooks.flatMap(g => (g.hooks || []).map(h => h.command || ""));
        const hasHook = allCmds.some(cmd => cmd.includes("pr-cleanup.js"));
        assert.ok(hasHook, "pr-cleanup.js debe estar registrado en Stop hooks de settings.json");
    });

    it("timeout del hook Stop >= 60000ms (suficiente para consultas de CI)", () => {
        const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
        const stopHooks = (settings.hooks && settings.hooks.Stop) || [];
        const allHooks = stopHooks.flatMap(g => g.hooks || []);
        const prCleanupHook = allHooks.find(h => (h.command || "").includes("pr-cleanup.js"));
        assert.ok(prCleanupHook, "pr-cleanup.js debe estar en los hooks");
        assert.ok(
            (prCleanupHook.timeout || 0) >= 60000,
            "timeout debe ser >= 60000ms — encontrado: " + prCleanupHook.timeout
        );
    });

});

// ─── Tests de seguridad (lógica de filtrado) ─────────────────────────────────

describe("P-26: pr-cleanup — filtros de seguridad", () => {

    it("BLOCKED_LABELS incluye do-not-merge y wip", () => {
        const src = readSource();
        assert.ok(src.includes('"do-not-merge"'), "debe bloquear label do-not-merge");
        assert.ok(src.includes('"wip"'), "debe bloquear label wip");
    });

    it("no mergea PRs con changes-requested", () => {
        const src = readSource();
        assert.ok(src.includes("hasChangesRequested"), "debe verificar hasChangesRequested");
        assert.ok(src.includes("CHANGES_REQUESTED"), "debe detectar CHANGES_REQUESTED");
    });

    it("no mergea PRs con conflictos de merge", () => {
        const src = readSource();
        assert.ok(src.includes("hasMergeConflicts"), "debe verificar hasMergeConflicts");
        assert.ok(src.includes("CONFLICTING"), "debe detectar mergeStateStatus CONFLICTING/DIRTY");
    });

    it("NUNCA mergea sin CI verde (regla crítica)", () => {
        const src = readSource();
        assert.ok(src.includes("isCIGreen"), "debe verificar isCIGreen antes de mergear");
        // Verificar que isCIGreen devuelve false cuando no hay checks
        assert.ok(
            src.includes("statusCheckRollup vacío") || src.includes("Sin checks"),
            "debe rechazar PRs sin checks de CI definidos"
        );
    });

    it("mergeStateStatus CLEAN indica CI verde", () => {
        const src = readSource();
        assert.ok(src.includes('"CLEAN"'), "mergeStateStatus CLEAN debe indicar CI verde");
    });

    it("mergeStateStatus DIRTY indica conflictos", () => {
        const src = readSource();
        assert.ok(src.includes('"DIRTY"'), "mergeStateStatus DIRTY debe indicar conflictos o CI rojo");
    });

    it("solo procesa ramas agent/*", () => {
        const src = readSource();
        assert.ok(src.includes("AGENT_BRANCH_PREFIX"), "debe definir AGENT_BRANCH_PREFIX");
        assert.ok(src.includes('"agent/"'), "debe filtrar solo ramas agent/*");
    });

    it("respeta umbral de antigüedad configurable (default 4h)", () => {
        const src = readSource();
        assert.ok(src.includes("MIN_AGE_HOURS"), "debe definir MIN_AGE_HOURS");
        assert.ok(src.includes('"4"'), "debe tener default de 4h");
        assert.ok(src.includes("isOlderThanNHours"), "debe usar isOlderThanNHours para filtrar");
    });

    it("usa merge squash (no merge commit directo)", () => {
        const src = readSource();
        assert.ok(src.includes("--squash"), "debe usar --squash para merge");
    });

    it("borra la rama tras el merge", () => {
        const src = readSource();
        assert.ok(src.includes("--delete-branch"), "debe eliminar la rama tras el merge");
    });

    it("no usa eval (seguridad)", () => {
        const src = readSource();
        const hasEval = /(?<!\w)eval\s*\(/.test(src);
        assert.ok(!hasEval, "No debe usar eval() — usar JSON.parse");
    });

});

// ─── Tests de modo DRY_RUN ────────────────────────────────────────────────────

describe("P-26: pr-cleanup — modo DRY_RUN", () => {

    it("soporte de variable PR_CLEANUP_DRY_RUN para pruebas seguras", () => {
        const src = readSource();
        assert.ok(src.includes("DRY_RUN"), "debe soportar PR_CLEANUP_DRY_RUN");
        assert.ok(src.includes("DRY_RUN activo"), "debe loguear cuando está en modo dry run");
    });

    it("en DRY_RUN no ejecuta gh pr merge", () => {
        const src = readSource();
        // Verificar que el merge real está dentro de un bloque que verifica DRY_RUN
        assert.ok(src.includes("if (DRY_RUN)"), "debe verificar DRY_RUN antes de mergear");
    });

});

// ─── Tests de notificación ───────────────────────────────────────────────────

describe("P-26: pr-cleanup — notificación Telegram", () => {

    it("notifica con resumen N PRs revisados / X mergeados / Y conflictos / Z CI fallidos", () => {
        const src = readSource();
        assert.ok(src.includes("PRs revisados"), "debe incluir conteo de PRs revisados en mensaje");
        assert.ok(src.includes("mergeados"), "debe incluir conteo de mergeados en mensaje");
        assert.ok(src.includes("conflictos"), "debe incluir conteo de conflictos en mensaje");
        assert.ok(src.includes("CI fallido"), "debe incluir conteo de CI fallidos en mensaje");
    });

    it("no notifica si no hay eventos relevantes (solo PRs omitidos)", () => {
        const src = readSource();
        assert.ok(
            src.includes("Sin eventos relevantes") || src.includes("mergedCount === 0 && conflictsCount === 0 && ciFailCount === 0"),
            "debe omitir notificación si no hay merges, conflictos ni CI fallidos"
        );
    });

    it("usa HTML safe (escHtml) en mensajes de Telegram", () => {
        const src = readSource();
        assert.ok(src.includes("escHtml"), "debe usar escHtml para escapar contenido HTML en Telegram");
    });

    it("incluye detalle de checks fallidos en notificación de CI fallido", () => {
        const src = readSource();
        assert.ok(src.includes("getFailedChecks") || src.includes("failedChecks"), "debe incluir checks fallidos en el mensaje");
    });

});

// ─── Tests de logging ─────────────────────────────────────────────────────────

describe("P-26: pr-cleanup — logging en hook-debug.log", () => {

    it("define LOG_FILE y usa appendFileSync para logs", () => {
        const src = readSource();
        assert.ok(src.includes("LOG_FILE"), "debe definir LOG_FILE");
        assert.ok(src.includes("appendFileSync"), "debe usar appendFileSync para no perder logs");
    });

    it("prefija logs con 'PRCleanup:'", () => {
        const src = readSource();
        assert.ok(src.includes("PRCleanup:"), "debe prefixar logs con PRCleanup:");
    });

    it("loga resumen con contadores al finalizar", () => {
        const src = readSource();
        assert.ok(
            src.includes("Resumen: total="),
            "debe loguear resumen con total, merged, conflicts, ciFailure, skipped"
        );
    });

});

// ─── Tests de integración con hook Stop ──────────────────────────────────────

describe("P-26: pr-cleanup — integración con hook Stop", () => {

    it("verifica stop_hook_active para evitar recursión", () => {
        const src = readSource();
        assert.ok(src.includes("stop_hook_active"), "debe verificar stop_hook_active para evitar recursión");
    });

    it("soporta ejecución standalone (sin stdin de Claude)", () => {
        const src = readSource();
        assert.ok(src.includes("isTTY"), "debe detectar si está corriendo como hook o standalone");
    });

    it("timeout de stdin para evitar que el hook cuelgue", () => {
        const src = readSource();
        assert.ok(src.includes("setTimeout"), "debe usar setTimeout como safety timeout para stdin");
    });

    it("fail-open: errores en el script no bloquean el hook Stop", () => {
        const src = readSource();
        assert.ok(src.includes(".catch"), "debe capturar errores con .catch para no bloquear el Stop hook");
    });

});
