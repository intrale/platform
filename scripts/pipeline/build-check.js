#!/usr/bin/env node
// build-check.js — Verificar build del proyecto (reemplaza parte mecanica de /builder)
// Usa smart-build.sh para compilar solo módulos afectados por el branch actual.
// Exit 0 = build OK, Exit 1 = build fallo

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { emitTransition, emitSkillInvoked, emitGateResult, REPO_ROOT } = require("./emit-transition");

const JAVA_HOME = "/c/Users/Administrator/.jdks/temurin-21.0.7";
const BUILD_TIMEOUT = 15 * 60 * 1000; // 15 min
const LOGS_DIR = path.join(REPO_ROOT, "scripts", "logs");

function runGradleTask(task, workDir) {
    try {
        const output = execSync("./gradlew " + task, {
            cwd: workDir,
            encoding: "utf8",
            timeout: BUILD_TIMEOUT,
            env: { ...process.env, JAVA_HOME },
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        return { ok: true, output };
    } catch (e) {
        return {
            ok: false,
            output: (e.stdout || "") + "\n" + (e.stderr || ""),
            exitCode: e.status || 1,
        };
    }
}

// Detecta qué módulos Gradle hay que compilar según los archivos modificados vs main.
// Replica la lógica de scripts/smart-build.sh para uso programático.
function detectAffectedTasks(workDir) {
    let changed = "";
    try {
        try {
            changed = execSync("git diff --name-only origin/main...HEAD", {
                cwd: workDir, encoding: "utf8", timeout: 15000, windowsHide: true,
            }).trim();
        } catch (_) {
            changed = execSync("git diff --name-only HEAD", {
                cwd: workDir, encoding: "utf8", timeout: 15000, windowsHide: true,
            }).trim();
        }
    } catch (_) { /* sin git — build completo */ }

    if (!changed) return { tasks: null, reason: "sin cambios detectados" };

    let backend = false, app = false, users = false, tools = false, shared = false;
    for (const file of changed.split("\n").filter(Boolean)) {
        if (file.startsWith("backend/")) backend = true;
        else if (file.startsWith("app/")) app = true;
        else if (file.startsWith("users/")) users = true;
        else if (file.startsWith("tools/")) tools = true;
        else if (
            file === "build.gradle.kts" || file === "settings.gradle.kts" ||
            file === "gradle.properties" || file.startsWith("gradle/") ||
            file.startsWith("buildSrc/")
        ) shared = true;
    }

    if (shared) return { tasks: null, reason: "archivos compartidos (gradle/buildSrc) — build completo" };

    const tasks = [];
    if (backend) tasks.push(":backend:check");
    if (users || backend) tasks.push(":users:check");  // transitividad
    if (app) tasks.push(":app:composeApp:check");
    if (tools) tasks.push(":tools:forbidden-strings-processor:check");

    if (tasks.length === 0) return { tasks: [], reason: "cambios solo en docs/scripts/.claude — sin módulos compilables" };

    return { tasks, reason: "módulos afectados: " + tasks.join(", ") };
}

function extractErrors(output) {
    const lines = output.split("\n");
    const errors = [];
    for (const line of lines) {
        if (line.includes("error:") || line.includes("FAILED") || line.includes("Error:")) {
            const clean = line.trim().substring(0, 200);
            if (clean && !errors.includes(clean)) {
                errors.push(clean);
            }
        }
    }
    return errors.slice(0, 20);
}

function main() {
    const prevRole = process.argv[2] || "Security";
    const nextRole = process.argv[3] || "DeliveryManager";
    const workDir = process.argv[4] || REPO_ROOT;
    const verifyExtra = process.argv.includes("--verify");
    const forceAll = process.argv.includes("--all");

    emitTransition(prevRole, "Builder");
    emitSkillInvoked("builder");

    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

    // Determinar tasks a ejecutar (smart build)
    let taskList;
    if (forceAll) {
        taskList = null;
        console.log("[build-check] Modo --all: build completo");
    } else {
        const detected = detectAffectedTasks(workDir);
        console.log("[build-check] Smart build — " + detected.reason);
        taskList = detected.tasks;
    }

    // taskList === null → build completo; taskList === [] → skip; taskList → tareas específicas
    if (taskList !== null && taskList.length === 0) {
        console.log("[build-check] Sin módulos compilables — skip build");
        const result = { status: "pass", checks: [], errors: [], skipped: true };
        fs.writeFileSync(path.join(LOGS_DIR, "build-result.json"), JSON.stringify(result, null, 2), "utf8");
        emitGateResult("builder", "pass", result);
        emitTransition("Builder", nextRole);
        process.exit(0);
    }

    const gradleArgs = taskList ? taskList.join(" ") : "build";
    console.log("[build-check] Ejecutando ./gradlew " + gradleArgs + "...");

    // Build principal
    const buildResult = runGradleTask(gradleArgs, workDir);
    const errors = buildResult.ok ? [] : extractErrors(buildResult.output);

    const checks = [{ task: gradleArgs, ok: buildResult.ok, errors }];

    // Verificaciones adicionales (solo con --verify)
    if (verifyExtra) {
        const extraTasks = [
            "verifyNoLegacyStrings",
            ":app:composeApp:validateComposeResources",
            ":app:composeApp:scanNonAsciiFallbacks",
        ];
        for (const task of extraTasks) {
            console.log("[build-check] Ejecutando " + task + "...");
            const result = runGradleTask(task, workDir);
            checks.push({
                task,
                ok: result.ok,
                errors: result.ok ? [] : extractErrors(result.output),
            });
        }
    }

    const allOk = checks.every(c => c.ok);
    const status = allOk ? "pass" : "fail";

    const result = {
        status,
        checks: checks.map(c => ({ task: c.task, ok: c.ok, errorCount: c.errors.length })),
        errors: checks.flatMap(c => c.errors),
    };

    // Guardar resultado
    fs.writeFileSync(path.join(LOGS_DIR, "build-result.json"), JSON.stringify(result, null, 2), "utf8");
    emitGateResult("builder", status, result);

    // Mostrar resumen
    console.log("[build-check] " + checks.length + " task(s): " +
        checks.filter(c => c.ok).length + " OK, " +
        checks.filter(c => !c.ok).length + " FAILED");

    if (!allOk) {
        for (const c of checks.filter(c => !c.ok)) {
            console.log("  [FAIL] " + c.task + ":");
            for (const e of c.errors.slice(0, 5)) {
                console.log("    " + e);
            }
        }
    }

    emitTransition("Builder", nextRole);

    process.exit(allOk ? 0 : 1);
}

main();
