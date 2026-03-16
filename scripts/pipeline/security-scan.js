#!/usr/bin/env node
// security-scan.js — Scan mecanico de seguridad del diff (reemplaza parte mecanica de /security)
// Busca secrets, .env, tokens hardcoded, patrones OWASP basicos en el diff.
// Exit 0 = clean, Exit 1 = bloqueantes encontrados

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { emitTransition, emitSkillInvoked, emitGateResult, REPO_ROOT } = require("./emit-transition");

const LOGS_DIR = path.join(REPO_ROOT, "scripts", "logs");

// Patrones de secrets (regex)
const SECRET_PATTERNS = [
    { name: "AWS Key", pattern: /AKIA[0-9A-Z]{16}/g },
    { name: "Private Key", pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g },
    { name: "Generic Secret", pattern: /(?:secret|password|token|api_key|apikey)\s*[:=]\s*["'][^"']{8,}/gi },
    { name: "JWT Token", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
    { name: "Connection String", pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+/gi },
    { name: "Hardcoded IP+Port", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}:\d{4,5}\b/g },
];

// Archivos que nunca deben estar en el diff
const FORBIDDEN_FILES = [
    ".env", ".env.local", ".env.production",
    "credentials.json", "service-account.json",
    "application.conf", // Solo si contiene secrets
    "*.pem", "*.key", "*.p12", "*.pfx",
];

// Archivos de alto riesgo (warning, no bloqueante)
const HIGH_RISK_PATHS = [
    /auth/i, /cognito/i, /security/i, /token/i, /session/i,
    /password/i, /credential/i, /secret/i,
];

function getDiffFiles(workDir) {
    try {
        const output = execSync("git diff origin/main...HEAD --name-only", {
            cwd: workDir, encoding: "utf8", timeout: 10000, windowsHide: true,
        });
        return output.trim().split("\n").filter(f => f.trim());
    } catch (e) {
        // Fallback: staged + unstaged
        try {
            const output = execSync("git diff --name-only HEAD", {
                cwd: workDir, encoding: "utf8", timeout: 10000, windowsHide: true,
            });
            return output.trim().split("\n").filter(f => f.trim());
        } catch (e2) {
            return [];
        }
    }
}

function getDiffContent(workDir) {
    try {
        return execSync("git diff origin/main...HEAD", {
            cwd: workDir, encoding: "utf8", timeout: 30000, windowsHide: true,
            maxBuffer: 10 * 1024 * 1024,
        });
    } catch (e) {
        return "";
    }
}

function main() {
    const prevRole = process.argv[2] || "Tester";
    const nextRole = process.argv[3] || "DeliveryManager";
    const workDir = process.argv[4] || REPO_ROOT;

    emitTransition(prevRole, "Security");
    emitSkillInvoked("security");

    // Verificar que el workDir es un repo git valido
    try {
        execSync("git status", { cwd: workDir, timeout: 5000, windowsHide: true, stdio: "pipe" });
    } catch (e) {
        console.log("[security-scan] Skip: workDir no es un repo git valido");
        if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
        emitGateResult("security", "pass", { skippedReason: "not a git repo" });
        emitTransition("Security", nextRole);
        process.exit(0);
    }

    console.log("[security-scan] Escaneando diff por vulnerabilidades...");

    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

    const files = getDiffFiles(workDir);
    const diffContent = getDiffContent(workDir);

    const findings = { critical: [], high: [], medium: [], info: [] };

    // Check 1: Archivos prohibidos
    for (const file of files) {
        const basename = path.basename(file).toLowerCase();
        for (const forbidden of FORBIDDEN_FILES) {
            if (forbidden.startsWith("*")) {
                const ext = forbidden.substring(1);
                if (basename.endsWith(ext)) {
                    findings.critical.push({
                        type: "forbidden_file",
                        file,
                        message: "Archivo prohibido en el diff: " + file,
                    });
                }
            } else if (basename === forbidden.toLowerCase()) {
                findings.critical.push({
                    type: "forbidden_file",
                    file,
                    message: "Archivo prohibido en el diff: " + file,
                });
            }
        }
    }

    // Check 2: Secrets en el contenido del diff (solo lineas agregadas)
    const addedLines = diffContent.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++"));
    const addedContent = addedLines.join("\n");

    for (const { name, pattern } of SECRET_PATTERNS) {
        const matches = addedContent.match(pattern);
        if (matches) {
            findings.critical.push({
                type: "secret_detected",
                pattern: name,
                count: matches.length,
                message: name + " detectado en " + matches.length + " lugar(es)",
                preview: matches[0].substring(0, 30) + "...",
            });
        }
    }

    // Check 3: Archivos de alto riesgo modificados (warning)
    for (const file of files) {
        for (const riskPattern of HIGH_RISK_PATHS) {
            if (riskPattern.test(file)) {
                findings.high.push({
                    type: "high_risk_file",
                    file,
                    message: "Archivo de alto riesgo modificado: " + file,
                });
                break;
            }
        }
    }

    // Check 4: SQL injection patterns en codigo nuevo
    const sqlPatterns = /["'`]\s*\+\s*(?:user|input|req|param|query)/gi;
    const sqlMatches = addedContent.match(sqlPatterns);
    if (sqlMatches) {
        findings.medium.push({
            type: "sql_injection_risk",
            count: sqlMatches.length,
            message: "Posible concatenacion SQL insegura (" + sqlMatches.length + " ocurrencias)",
        });
    }

    // Resultado
    const hasCritical = findings.critical.length > 0;
    const status = hasCritical ? "fail" : "pass";

    const result = {
        status,
        filesScanned: files.length,
        critical: findings.critical.length,
        high: findings.high.length,
        medium: findings.medium.length,
        info: findings.info.length,
        findings,
        blockers: findings.critical.map(f => f.message),
    };

    // Guardar resultado
    fs.writeFileSync(path.join(LOGS_DIR, "security-result.json"), JSON.stringify(result, null, 2), "utf8");
    emitGateResult("security", status, result);

    // Mostrar resumen
    console.log("[security-scan] " + files.length + " archivos escaneados: " +
        findings.critical.length + " criticos, " +
        findings.high.length + " altos, " +
        findings.medium.length + " medios");

    if (hasCritical) {
        console.log("[security-scan] BLOQUEANTES:");
        for (const f of findings.critical) {
            console.log("  [CRITICAL] " + f.message);
        }
    }

    emitTransition("Security", nextRole);

    process.exit(status === "pass" ? 0 : 1);
}

main();
