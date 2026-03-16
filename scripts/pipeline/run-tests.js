#!/usr/bin/env node
// run-tests.js — Ejecutar tests y parsear resultados (reemplaza parte mecanica de /tester)
// Ejecuta ./gradlew check, parsea JUnit XML, emite transicion "Tester" al dashboard.
// Exit 0 = todos pasan, Exit 1 = fallos detectados

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { emitTransition, emitSkillInvoked, emitGateResult, REPO_ROOT } = require("./emit-transition");

const JAVA_HOME = "/c/Users/Administrator/.jdks/temurin-21.0.7";
const TEST_TIMEOUT = 10 * 60 * 1000; // 10 min
const LOGS_DIR = path.join(REPO_ROOT, "scripts", "logs");

function parseJUnitXml(xmlPath) {
    try {
        const content = fs.readFileSync(xmlPath, "utf8");
        const tests = parseInt((content.match(/tests="(\d+)"/) || [])[1]) || 0;
        const failures = parseInt((content.match(/failures="(\d+)"/) || [])[1]) || 0;
        const errors = parseInt((content.match(/errors="(\d+)"/) || [])[1]) || 0;
        const skipped = parseInt((content.match(/skipped="(\d+)"/) || [])[1]) || 0;
        const time = parseFloat((content.match(/time="([\d.]+)"/) || [])[1]) || 0;

        // Extraer nombres de tests fallidos
        const failureDetails = [];
        const failureRegex = /<testcase\s[^>]*name="([^"]*)"[^>]*classname="([^"]*)"[^>]*>[\s\S]*?<failure[^>]*(?:message="([^"]*)")?[\s\S]*?<\/testcase>/g;
        let m;
        while ((m = failureRegex.exec(content)) !== null) {
            failureDetails.push({ test: m[1], class: m[2], message: (m[3] || "").substring(0, 200) });
        }

        return { tests, failures: failures + errors, skipped, time, failureDetails };
    } catch (e) {
        return null;
    }
}

function findTestResults(baseDir) {
    const results = [];
    const searchDirs = [
        path.join(baseDir, "backend", "build", "test-results", "test"),
        path.join(baseDir, "users", "build", "test-results", "test"),
        path.join(baseDir, "app", "composeApp", "build", "test-results"),
        path.join(baseDir, "tools", "build", "test-results", "test"),
        path.join(baseDir, "buildSrc", "build", "test-results", "test"),
    ];

    for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;
        const walk = (d) => {
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
                const full = path.join(d, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith(".xml")) results.push(full);
            }
        };
        walk(dir);
    }
    return results;
}

function main() {
    const prevRole = process.argv[2] || "Claude";
    const nextRole = process.argv[3] || "Security";
    const workDir = process.argv[4] || REPO_ROOT;

    // Emitir transicion
    emitTransition(prevRole, "Tester");
    emitSkillInvoked("tester");

    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

    // Skip tests si el diff no toca codigo fuente
    try {
        const diff = execSync("git diff origin/main...HEAD --name-only", {
            cwd: workDir, encoding: "utf8", timeout: 10000, windowsHide: true,
        }).trim();
        const codeFiles = diff.split("\n").filter(f =>
            /\.(kt|kts|java|gradle)$/.test(f) && !f.startsWith(".claude/"));
        if (codeFiles.length === 0) {
            console.log("[run-tests] Skip: diff no contiene codigo fuente (" + diff.split("\n").length + " archivos, solo docs/config)");
            const skipResult = { status: "pass", total: 0, passed: 0, failed: 0, skipped: 0, time: 0, failures: [], xmlFiles: 0, buildExitCode: 0, skippedReason: "no source code in diff" };
            fs.writeFileSync(path.join(LOGS_DIR, "test-result.json"), JSON.stringify(skipResult, null, 2), "utf8");
            emitGateResult("tester", "pass", skipResult);
            emitTransition("Tester", nextRole);
            process.exit(0);
        }
    } catch (e) { /* continuar con tests si falla la deteccion */ }

    console.log("[run-tests] Ejecutando ./gradlew check...");

    // Ejecutar tests
    let buildOutput = "";
    let buildExitCode = 0;
    try {
        buildOutput = execSync("./gradlew check", {
            cwd: workDir,
            encoding: "utf8",
            timeout: TEST_TIMEOUT,
            env: { ...process.env, JAVA_HOME },
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
    } catch (e) {
        buildOutput = (e.stdout || "") + "\n" + (e.stderr || "");
        buildExitCode = e.status || 1;
    }

    // Parsear resultados JUnit
    const xmlFiles = findTestResults(workDir);
    let totalTests = 0, totalFailed = 0, totalSkipped = 0, totalTime = 0;
    const allFailures = [];

    for (const xmlFile of xmlFiles) {
        const parsed = parseJUnitXml(xmlFile);
        if (!parsed) continue;
        totalTests += parsed.tests;
        totalFailed += parsed.failures;
        totalSkipped += parsed.skipped;
        totalTime += parsed.time;
        allFailures.push(...parsed.failureDetails);
    }

    const passed = totalTests - totalFailed - totalSkipped;
    const status = (totalFailed === 0 && buildExitCode === 0) ? "pass" : "fail";

    // Resultado estructurado
    const result = {
        status,
        total: totalTests,
        passed,
        failed: totalFailed,
        skipped: totalSkipped,
        time: Math.round(totalTime * 10) / 10,
        failures: allFailures.slice(0, 20), // Max 20 failures
        xmlFiles: xmlFiles.length,
        buildExitCode,
    };

    // Guardar resultado
    fs.writeFileSync(path.join(LOGS_DIR, "test-result.json"), JSON.stringify(result, null, 2), "utf8");
    emitGateResult("tester", status, result);

    // Mostrar resumen
    console.log("[run-tests] Resultado: " + passed + "/" + totalTests + " pasaron" +
        (totalFailed > 0 ? ", " + totalFailed + " fallaron" : "") +
        (totalSkipped > 0 ? ", " + totalSkipped + " skipped" : "") +
        " (" + result.time + "s)");

    if (allFailures.length > 0) {
        console.log("[run-tests] Tests fallidos:");
        for (const f of allFailures.slice(0, 10)) {
            console.log("  - " + f.class + "." + f.test + ": " + f.message);
        }
    }

    // Emitir transicion de salida
    emitTransition("Tester", nextRole);

    process.exit(status === "pass" ? 0 : 1);
}

main();
