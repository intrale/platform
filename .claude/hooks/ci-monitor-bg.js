// ci-monitor-bg.js — Monitoreo CI en background (Pure Node.js)
// Lanzado por post-git-push.js tras detectar un git push exitoso.
// Polling: consulta GitHub Actions cada 30s hasta que el run concluya.
// Al finalizar: notifica resultado via Telegram.
//
// Uso: node ci-monitor-bg.js <sha> <branch> <project-dir>

const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

let registerMessage;
try {
    registerMessage = require("./telegram-message-registry").registerMessage;
} catch (e) {
    registerMessage = () => {}; // Fallback si el registry no existe
}

// P-09: Usar telegram-client.js compartido
let tgClient;
try { tgClient = require("./telegram-client"); } catch (e) { tgClient = null; }

// P-15: Ops learnings
let opsLearnings;
try { opsLearnings = require("./ops-learnings"); } catch (e) { opsLearnings = null; }

const SHA = process.argv[2];
const BRANCH = process.argv[3];
const PROJECT_DIR = process.argv[4] || process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
// Arg 5 opcional: session file path para actualizar waiting_state
const SESSION_FILE = process.argv[5] || null;

// Patrones de error conocidos y sus sugerencias de fix
const ERROR_PATTERNS = [
    {
        pattern: /e:\s.+\.kt:\d+:\d+[\s\S]{0,200}?unresolved reference[:\s]+(\w+)/i,
        category: "Referencia no resuelta",
        suggest: (m) => `Agregar import o definición de \`${m[1]}\``
    },
    {
        pattern: /e:\s.+\.kt:\d+:\d+[\s\S]{0,200}?type mismatch[:\s]+found[:\s]+(.+?)\s+required[:\s]+(.+?)(?:\n|$)/i,
        category: "Type mismatch",
        suggest: (m) => `Verificar conversión entre \`${m[1].trim()}\` y \`${m[2].trim()}\``
    },
    {
        pattern: /e:\s.+\.kt:\d+:\d+.+overload resolution ambiguity/i,
        category: "Ambigüedad de overload",
        suggest: () => "Especificar tipos explícitamente para resolver la ambigüedad"
    },
    {
        pattern: /task ':(.+?)' execution failed/i,
        category: "Task Gradle fallida",
        suggest: (m) => `Revisar la tarea Gradle \`${m[1]}\` en detalle`
    },
    {
        pattern: /compilation error|compil[ea]tion failed/i,
        category: "Error de compilación",
        suggest: () => "Revisar errores de compilación Kotlin en el log completo"
    },
    {
        pattern: /test[s]? failed|(\d+) test[s]? failed/i,
        category: "Tests fallidos",
        suggest: (m) => m[1] ? `${m[1]} test(s) fallaron — ejecutar \`./gradlew check\` localmente` : "Tests fallaron — ejecutar `./gradlew check` localmente"
    },
    {
        pattern: /out of memory|java\.lang\.outofmemoryerror/i,
        category: "Out of Memory",
        suggest: () => "Aumentar heap de Gradle en `gradle.properties`: `org.gradle.jvmargs=-Xmx4g`"
    },
    {
        pattern: /permission denied|access is denied/i,
        category: "Permiso denegado",
        suggest: () => "Verificar permisos de archivos o secretos de CI"
    },
    {
        pattern: /dependency resolution failed|could not resolve/i,
        category: "Dependencia no resuelta",
        suggest: () => "Verificar versiones en `libs.versions.toml` y conectividad a Maven Central"
    },
    {
        pattern: /forbidden strings|verifynolegacystrings/i,
        category: "Strings prohibidos",
        suggest: () => "Usar `resString(...)` en lugar de `stringResource(...)` o `Res.string.*`"
    },
    {
        pattern: /lint.*error|android lint/i,
        category: "Android Lint",
        suggest: () => "Ejecutar `./gradlew lint` localmente y corregir errores reportados"
    }
];

const LOG_FILE = path.join(PROJECT_DIR, ".claude", "hooks", "hook-debug.log");
const MAX_POLLS = 40;            // ~20 minutos maximo
const GH_REPO = "intrale/platform";

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] CI-Monitor: " + msg + "\n"); } catch(e) {}
}

function getGitHubToken() {
    // Intentar gh auth token primero
    try {
        const ghPath = "C:\\Workspaces\\gh-cli\\bin\\gh.exe";
        if (fs.existsSync(ghPath)) {
            return execSync(ghPath + " auth token", { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
        }
    } catch(e) {}
    // Fallback: git credential fill
    try {
        const credInput = "protocol=https\nhost=github.com\n\n";
        const result = execSync("git credential fill", { input: credInput, encoding: "utf8", cwd: PROJECT_DIR, timeout: 5000, windowsHide: true });
        const match = result.match(/password=(.+)/);
        if (match) return match[1].trim();
    } catch(e) {}
    return "";
}

function ghApiGet(apiPath, token) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: "api.github.com",
            path: apiPath,
            method: "GET",
            headers: {
                "Authorization": "token " + token,
                "User-Agent": "intrale-ci-monitor",
                "Accept": "application/vnd.github+json"
            },
            timeout: 10000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", (e) => reject(e));
        req.end();
    });
}

// GET con seguimiento de redirect (para logs de GitHub Actions que devuelven 302)
function ghApiGetText(url, token, maxRedirects) {
    maxRedirects = maxRedirects === undefined ? 3 : maxRedirects;
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: "GET",
            headers: {
                "Authorization": "token " + token,
                "User-Agent": "intrale-ci-monitor",
                "Accept": "application/vnd.github+json"
            },
            timeout: 15000
        };
        const req = https.request(options, (res) => {
            if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
                if (maxRedirects <= 0) return reject(new Error("Demasiados redirects"));
                // Seguir redirect sin Authorization header (S3 pre-signed URLs no lo admiten)
                const redirectUrl = res.headers.location;
                res.resume();
                ghApiGetTextRaw(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
                return;
            }
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => resolve(d));
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout logs")); });
        req.on("error", (e) => reject(e));
        req.end();
    });
}

// GET raw (sin Authorization) para seguir redirects S3
function ghApiGetTextRaw(url, maxRedirects) {
    maxRedirects = maxRedirects === undefined ? 2 : maxRedirects;
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: "GET",
            headers: { "User-Agent": "intrale-ci-monitor" },
            timeout: 20000
        };
        const req = https.request(options, (res) => {
            if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
                if (maxRedirects <= 0) return reject(new Error("Demasiados redirects raw"));
                res.resume();
                ghApiGetTextRaw(res.headers.location, maxRedirects - 1).then(resolve).catch(reject);
                return;
            }
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => resolve(d));
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout raw")); });
        req.on("error", (e) => reject(e));
        req.end();
    });
}

// POST a la API de GitHub (para comentarios en PRs)
function ghApiPost(apiPath, token, body) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(body);
        const req = https.request({
            hostname: "api.github.com",
            path: apiPath,
            method: "POST",
            headers: {
                "Authorization": "token " + token,
                "User-Agent": "intrale-ci-monitor",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData)
            },
            timeout: 10000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try { resolve(JSON.parse(d)); } catch(e) { resolve({}); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout post")); });
        req.on("error", (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

// Encuentra el PR abierto asociado a la rama
async function findPRForBranch(branch, token) {
    try {
        const data = await ghApiGet(
            "/repos/" + GH_REPO + "/pulls?head=intrale:" + encodeURIComponent(branch) + "&state=open&per_page=5",
            token
        );
        if (Array.isArray(data) && data.length > 0) {
            return data[0].number;
        }
    } catch (e) {
        log("Error buscando PR para " + branch + ": " + e.message);
    }
    return null;
}

// Descarga los logs de los jobs fallidos de un run
async function downloadFailedJobLogs(runId, token) {
    try {
        const jobsData = await ghApiGet(
            "/repos/" + GH_REPO + "/actions/runs/" + runId + "/jobs?per_page=20",
            token
        );
        const jobs = jobsData.jobs || [];
        const failedJobs = jobs.filter(j => j.conclusion === "failure" || j.conclusion === "cancelled");
        if (failedJobs.length === 0) {
            // Si no hay jobs específicamente fallidos, tomar todos
            const allFailed = jobs.filter(j => j.conclusion !== "success" && j.conclusion !== "skipped");
            if (allFailed.length === 0) return { logs: "", jobName: "CI" };
            failedJobs.push(...allFailed.slice(0, 2));
        }

        let combinedLog = "";
        for (const job of failedJobs.slice(0, 2)) {
            try {
                const logUrl = "https://api.github.com/repos/" + GH_REPO + "/actions/jobs/" + job.id + "/logs";
                const logText = await ghApiGetText(logUrl, token);
                combinedLog += "\n--- Job: " + job.name + " ---\n" + logText;
            } catch (e) {
                log("Error descargando log del job " + job.id + ": " + e.message);
            }
        }
        return { logs: combinedLog, jobName: failedJobs[0].name || "CI" };
    } catch (e) {
        log("Error descargando logs: " + e.message);
        return { logs: "", jobName: "CI" };
    }
}

// Analiza el log y extrae errores relevantes con sugerencias de fix
function analyzeLog(logText) {
    if (!logText || logText.length === 0) {
        return { errors: [], diagnosis: "No se pudo descargar el log del CI.", suggestions: [] };
    }

    // Truncar a las últimas 8000 chars (donde suelen estar los errores)
    const logTail = logText.length > 8000 ? logText.slice(-8000) : logText;

    const errors = [];
    const suggestions = [];
    const matched = new Set();

    for (const ep of ERROR_PATTERNS) {
        const match = logTail.match(ep.pattern);
        if (match && !matched.has(ep.category)) {
            matched.add(ep.category);
            errors.push(ep.category);
            suggestions.push(ep.suggest(match));
        }
    }

    // Extraer líneas de error Kotlin específicas (e: path.kt:line:col: mensaje)
    const kotlinErrors = [];
    const ktErrorPattern = /^(?:.*?)(e: .+\.kt:\d+:\d+.+)$/gm;
    let m;
    while ((m = ktErrorPattern.exec(logTail)) !== null && kotlinErrors.length < 5) {
        const line = m[1].trim();
        if (!kotlinErrors.includes(line)) kotlinErrors.push(line);
    }

    // Extraer líneas FAILED de Gradle
    const gradleErrors = [];
    const gradlePattern = /^(?:.*?)(FAILED|> Task .+ FAILED|BUILD FAILED.*)$/gm;
    while ((m = gradlePattern.exec(logTail)) !== null && gradleErrors.length < 3) {
        const line = m[1].trim();
        if (!gradleErrors.includes(line)) gradleErrors.push(line);
    }

    return {
        errors,
        kotlinErrors,
        gradleErrors,
        suggestions,
        diagnosis: errors.length > 0 ? errors.join(", ") : "Fallo sin patrón conocido"
    };
}

// Postea un comentario en el PR con el diagnóstico
async function postPRComment(prNumber, runId, runUrl, analysis) {
    const token = getGitHubToken();
    if (!token || !prNumber) return;

    const { errors, kotlinErrors, gradleErrors, suggestions, diagnosis } = analysis;

    let body = "## 🤖 Auto-builder: Diagnóstico de CI Failure\n\n";
    body += "**Diagnóstico:** " + diagnosis + "\n\n";

    if (gradleErrors.length > 0) {
        body += "### ❌ Errores Gradle\n```\n" + gradleErrors.join("\n") + "\n```\n\n";
    }

    if (kotlinErrors.length > 0) {
        body += "### 🔴 Errores Kotlin\n```\n" + kotlinErrors.join("\n") + "\n```\n\n";
    }

    if (suggestions.length > 0) {
        body += "### 💡 Sugerencias de Fix\n";
        for (const s of suggestions) {
            body += "- " + s + "\n";
        }
        body += "\n";
    }

    body += "### 📋 Próximos pasos\n";
    body += "1. Revisar el [log completo en GitHub Actions](" + runUrl + ")\n";
    body += "2. Corregir los errores indicados y hacer push\n";
    body += "3. CI se re-ejecutará automáticamente\n\n";
    body += "_Generado automáticamente por `ci-monitor-bg.js` · Run ID: " + runId + "_";

    try {
        await ghApiPost(
            "/repos/" + GH_REPO + "/issues/" + prNumber + "/comments",
            token,
            { body }
        );
        log("Comentario de diagnóstico posteado en PR #" + prNumber);
    } catch (e) {
        log("Error posteando comentario en PR #" + prNumber + ": " + e.message);
    }
}

// P-09: Envío via telegram-client.js con fallback inline
async function sendTelegram(text) {
    try {
        if (tgClient) {
            const result = await tgClient.sendMessage(text);
            if (result && result.message_id) registerMessage(result.message_id, "ci");
            return result;
        }
    } catch (e) { log("sendTelegram via client error: " + e.message); }
    return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Actualizar waiting_state en el session file del agente
function updateSessionWaitingState(patch) {
    // Intentar desde SESSION_FILE (arg directo) o buscar en sessions/ del worktree
    const candidates = [];
    if (SESSION_FILE) candidates.push(SESSION_FILE);

    // Buscar en el worktree que coincide con la rama
    try {
        const branchSlug = BRANCH.replace(/\//g, "-");
        const parentDir = path.resolve(PROJECT_DIR, "..");
        const dirEntries = fs.readdirSync(parentDir);
        for (const d of dirEntries) {
            if (d.includes(branchSlug) || d.startsWith("platform.agent-")) {
                const sessDir = path.join(parentDir, d, ".claude", "sessions");
                if (fs.existsSync(sessDir)) {
                    const files = fs.readdirSync(sessDir).filter(f => f.endsWith(".json"));
                    for (const f of files) {
                        candidates.push(path.join(sessDir, f));
                    }
                }
            }
        }
    } catch (e) { /* no bloquear */ }

    // También buscar en el repo principal
    try {
        const mainSessDir = path.join(PROJECT_DIR, ".claude", "sessions");
        if (fs.existsSync(mainSessDir)) {
            const files = fs.readdirSync(mainSessDir).filter(f => f.endsWith(".json"));
            for (const f of files) {
                candidates.push(path.join(mainSessDir, f));
            }
        }
    } catch (e) {}

    // Actualizar sesiones cuya rama coincide con BRANCH
    let updated = 0;
    for (const filePath of candidates) {
        try {
            const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
            if ((session.branch || "") !== BRANCH) continue;
            if (!session.waiting_state) session.waiting_state = {};
            Object.assign(session.waiting_state, patch);
            fs.writeFileSync(filePath, JSON.stringify(session, null, 2) + "\n", "utf8");
            updated++;
        } catch (e) {}
    }

    if (updated > 0) {
        log("waiting_state actualizado en " + updated + " session(s): " + JSON.stringify(patch));
    }
}

// P-11: Backoff progresivo según tiempo transcurrido
function getPollInterval(elapsedMs) {
    if (elapsedMs < 120000) return 60000;   // 0-2min: 60s (workflow registrándose)
    if (elapsedMs < 480000) return 30000;   // 2-8min: 30s (fase activa)
    return 60000;                            // >8min: 60s (anormal, reducir carga)
}

async function main() {
    if (!SHA || !BRANCH) {
        log("Faltan argumentos: sha=" + SHA + " branch=" + BRANCH);
        process.exit(1);
    }

    log("Iniciando monitoreo CI para " + SHA.substring(0, 7) + " en " + BRANCH);

    const token = getGitHubToken();
    if (!token) {
        log("No se pudo obtener GitHub token, abortando");
        process.exit(1);
    }

    // Esperar un poco para que GitHub registre el workflow run
    await sleep(10000);

    const startMs = Date.now();
    let lastRunId = null;

    for (let poll = 0; poll < MAX_POLLS; poll++) {
        const elapsedMs = Date.now() - startMs;
        const interval = getPollInterval(elapsedMs);

        try {
            // Buscar workflow runs para este SHA
            const data = await ghApiGet(
                "/repos/" + GH_REPO + "/actions/runs?head_sha=" + SHA + "&per_page=5",
                token
            );

            const runs = data.workflow_runs || [];
            if (runs.length === 0) {
                log("Poll " + (poll + 1) + ": sin runs para " + SHA.substring(0, 7) + " (interval=" + (interval/1000) + "s)");
                if (poll > 5) {
                    log("Sin runs despues de " + (poll + 1) + " intentos, abortando");
                    // Limpiar waiting_state si no hay runs
                    updateSessionWaitingState({ status: "no_runs", detail: "Sin workflow runs en GitHub Actions" });
                    break;
                }
                await sleep(interval);
                continue;
            }

            const run = runs[0];
            const status = run.status;
            const conclusion = run.conclusion;
            const runUrl = run.html_url || "";
            const runId = run.id;
            const runName = run.name || "CI";

            log("Poll " + (poll + 1) + ": status=" + status + " conclusion=" + (conclusion || "pending") + " (interval=" + (interval/1000) + "s)");

            // Actualizar session con estado de CI en progreso
            if (status !== "completed") {
                const detail = runName + " (" + status + ")";
                updateSessionWaitingState({
                    reason: "ci",
                    detail: "GitHub Actions: " + detail,
                    status: "in_progress",
                    run_id: runId,
                    run_url: runUrl,
                    run_name: runName
                });
                lastRunId = runId;
            }

            if (status === "completed") {
                const emoji = conclusion === "success" ? "\u2705" : "\u274C";
                const label = conclusion === "success" ? "exitoso" : "fallido (" + conclusion + ")";
                const url = runUrl;

                const msg = emoji + " <b>CI " + label + "</b>\n\n"
                    + "Branch: <code>" + BRANCH + "</code>\n"
                    + "Commit: <code>" + SHA.substring(0, 7) + "</code>\n"
                    + (url ? '<a href="' + url + '">Ver en GitHub</a>' : "");

                // Actualizar session con resultado final
                updateSessionWaitingState({
                    reason: "ci",
                    detail: "GitHub Actions: " + runName + " (" + (conclusion || "completed") + ")",
                    status: conclusion === "success" ? "success" : "failure",
                    run_id: runId,
                    run_url: runUrl,
                    run_name: runName,
                    finished_at: new Date().toISOString()
                });

                log("CI completado: " + conclusion + " — notificando");

                // Auto-builder: analizar y comentar en PR cuando CI falla (#1517)
                if (conclusion !== "success") {
                    try {
                        log("Auto-builder: descargando logs de CI fallido...");
                        const { logs, jobName } = await downloadFailedJobLogs(runId, token);
                        const analysis = analyzeLog(logs);
                        log("Auto-builder: diagnóstico: " + analysis.diagnosis);

                        const prNumber = await findPRForBranch(BRANCH, token);
                        if (prNumber) {
                            log("Auto-builder: PR #" + prNumber + " encontrado — posteando diagnóstico");
                            await postPRComment(prNumber, runId, runUrl, analysis);

                            // Agregar diagnóstico al mensaje de Telegram
                            if (analysis.errors.length > 0) {
                                msg += "\n\n<b>Diagnóstico:</b> " + analysis.errors.join(", ");
                            }
                            if (analysis.suggestions.length > 0) {
                                msg += "\n<b>Sugerencia:</b> " + analysis.suggestions[0];
                            }
                            msg += "\n<i>Diagnóstico completo en PR #" + prNumber + "</i>";
                        } else {
                            log("Auto-builder: no se encontró PR abierto para " + BRANCH);
                            if (analysis.errors.length > 0) {
                                msg += "\n\n<b>Diagnóstico:</b> " + analysis.errors.join(", ");
                            }
                            if (analysis.suggestions.length > 0) {
                                msg += "\n<b>Sugerencia:</b> " + analysis.suggestions[0];
                            }
                        }
                    } catch (e) {
                        log("Auto-builder: error en análisis: " + e.message);
                    }

                    // P-15: Registrar CI fallido en ops-learnings
                    if (opsLearnings) {
                        try {
                            opsLearnings.recordLearning({
                                source: "ci-monitor",
                                category: "ci_failure",
                                severity: "high",
                                symptom: "CI fallido: " + conclusion + " en " + BRANCH,
                                root_cause: "Workflow conclusion: " + conclusion,
                                affected: ["ci-monitor-bg.js"],
                                auto_detected: true
                            });
                        } catch (e) {}
                    }
                }

                await sendTelegram(msg);
                process.exit(0);
            }

            // Aun corriendo, esperar
            await sleep(interval);
        } catch(e) {
            log("Error en poll " + (poll + 1) + ": " + e.message);
            await sleep(interval);
        }
    }

    log("Timeout: CI no completo despues de " + MAX_POLLS + " polls");
    updateSessionWaitingState({ status: "timeout", detail: "CI timeout: workflow no completó en tiempo esperado", finished_at: new Date().toISOString() });
    // P-15: Registrar timeout en ops-learnings
    if (opsLearnings) {
        try {
            opsLearnings.recordLearning({
                source: "ci-monitor",
                category: "ci_timeout",
                severity: "high",
                symptom: "CI timeout: workflow no completó en tiempo esperado",
                root_cause: "Workflow para " + BRANCH + " (" + SHA.substring(0, 7) + ") excedió " + MAX_POLLS + " polls",
                affected: ["ci-monitor-bg.js"],
                auto_detected: true
            });
        } catch (e) {}
    }
    await sendTelegram("\u23F1 <b>CI timeout</b>\n\nEl workflow para <code>" + SHA.substring(0, 7) + "</code> en <code>" + BRANCH + "</code> no completo en el tiempo esperado.");
    process.exit(0);
}

main().catch((e) => {
    log("Error fatal: " + e.message);
    process.exit(1);
});
