#!/usr/bin/env node
// build-check.js — Verificar build del proyecto (reemplaza parte mecanica de /builder)
// Ejecuta ./gradlew build + verificaciones adicionales.
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

    emitTransition(prevRole, "Builder");
    emitSkillInvoked("builder");

    console.log("[build-check] Ejecutando ./gradlew build...");

    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

    // Build principal
    const buildResult = runGradleTask("build", workDir);
    const errors = buildResult.ok ? [] : extractErrors(buildResult.output);

    const checks = [{ task: "build", ok: buildResult.ok, errors }];

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
