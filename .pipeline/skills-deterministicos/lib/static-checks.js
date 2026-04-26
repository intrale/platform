'use strict';

/**
 * static-checks.js — Chequeos mecánicos reutilizables para el linter determinístico.
 *
 * Cada check es una función pura: recibe texto/metadata y devuelve findings con
 * forma { rule, severity, file?, line?, message }. El linter.js compone los
 * chequeos y agrega el reporte final.
 *
 * Convenciones:
 *   - rule: identificador corto estable (ej. 'secret:aws-access-key')
 *   - severity: 'error' | 'warn' | 'info'
 *   - Sólo los 'error' bloquean el flujo (exit 1 + rebote a dev).
 */

// ── Detección de secretos ────────────────────────────────────────────
// Patrones conservadores: preferimos false-negatives a false-positives en
// strings comunes del código. Los tokens/keys bien formados son muy largos
// y con charset específico, lo que reduce el ruido.
const SECRET_PATTERNS = [
    {
        rule: 'secret:aws-access-key',
        rx: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
        message: 'Posible AWS Access Key ID hardcodeada',
    },
    {
        rule: 'secret:aws-secret-key',
        // Heurística: asignación a variable con nombre típico + valor base64-ish largo
        rx: /(?:aws_?secret(?:_?access)?_?key|secret_access_key)\s*[:=]\s*["'][A-Za-z0-9/+=]{40}["']/i,
        message: 'Posible AWS Secret Access Key hardcodeada',
    },
    {
        rule: 'secret:github-token',
        rx: /\bghp_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
        message: 'Posible GitHub Personal Access Token',
    },
    {
        rule: 'secret:openai-key',
        rx: /\bsk-[A-Za-z0-9]{20,}\b/,
        message: 'Posible OpenAI API key',
    },
    {
        rule: 'secret:telegram-bot-token',
        rx: /\b\d{9,10}:[A-Za-z0-9_-]{35}\b/,
        message: 'Posible Telegram bot token',
    },
    {
        rule: 'secret:private-key',
        rx: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
        message: 'Bloque de clave privada detectado',
    },
    {
        rule: 'secret:generic-api-key',
        // Variables que se llaman *_api_key, *_secret, password = ... con valor > 16 chars
        rx: /\b(?:api_?key|secret|password|passwd|pwd)\s*[:=]\s*["'][A-Za-z0-9_\-+/=!@#$%^&*.]{16,}["']/i,
        message: 'Asignación sospechosa a variable tipo api_key/secret/password',
    },
];

// Allowlist para secretos: archivos/paths donde NO reportar (docs, ejemplos, tests).
const SECRETS_ALLOWLIST = [
    /^docs\//,
    /\.md$/,
    /\.test\.(js|ts|kt)$/,
    /__tests__\//,
    /\/fixtures\//,
    /\/testdata\//,
    /\.example$/,
    /\.example\./,
    /\.sample$/,
];

function isSecretAllowed(filePath) {
    if (!filePath) return false;
    return SECRETS_ALLOWLIST.some((rx) => rx.test(filePath));
}

/**
 * Analiza un diff unificado y detecta secretos en las líneas agregadas (+).
 * @param {string} unifiedDiff — output de `git diff`
 * @returns {Array<{rule,severity,file,line,message}>}
 */
function checkSecretsInDiff(unifiedDiff) {
    const findings = [];
    if (!unifiedDiff) return findings;
    const lines = unifiedDiff.split(/\r?\n/);
    let currentFile = null;
    let newLineNum = 0;

    for (const ln of lines) {
        const fileMatch = ln.match(/^\+\+\+ b\/(.+)$/);
        if (fileMatch) {
            currentFile = fileMatch[1];
            newLineNum = 0;
            continue;
        }
        const hunkMatch = ln.match(/^@@ .*\+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
            newLineNum = parseInt(hunkMatch[1], 10) - 1;
            continue;
        }
        if (ln.startsWith('+') && !ln.startsWith('+++')) {
            newLineNum += 1;
            if (!currentFile || isSecretAllowed(currentFile)) continue;
            const content = ln.slice(1);
            for (const p of SECRET_PATTERNS) {
                if (p.rx.test(content)) {
                    findings.push({
                        rule: p.rule,
                        severity: 'error',
                        file: currentFile,
                        line: newLineNum,
                        message: p.message,
                    });
                }
            }
        } else if (!ln.startsWith('-') && !ln.startsWith('---')) {
            newLineNum += 1;
        }
    }
    return findings;
}

// ── Strings prohibidos en capa UI ────────────────────────────────────
// Replican las reglas del KSP forbidden-strings-processor, pero para que
// el linter las detecte ANTES de compilar Gradle. Sólo aplica a archivos
// de la app Compose (app/composeApp/src/).
const FORBIDDEN_STRINGS_RULES = [
    {
        rule: 'strings:direct-string-resource',
        rx: /\bstringResource\s*\(/,
        message: 'Uso directo de stringResource() fuera de ui/util/ResStrings — usar resString(...)',
    },
    {
        rule: 'strings:res-string-access',
        rx: /\bRes\.string\.[A-Za-z_][A-Za-z0-9_]*/,
        message: 'Acceso directo a Res.string.* — usar resString(...)',
    },
    {
        rule: 'strings:r-string-access',
        rx: /\bR\.string\.[A-Za-z_][A-Za-z0-9_]*/,
        message: 'Acceso directo a R.string.* — usar resString(...)',
    },
    {
        rule: 'strings:context-get-string',
        rx: /\bcontext\.getString\s*\(|\bgetString\s*\(\s*R\.string\./,
        message: 'Uso de getString(...) directo — usar resString(...)',
    },
    {
        rule: 'strings:base64-ui-import',
        rx: /^\s*import\s+kotlin\.io\.encoding\.Base64/,
        message: 'Import de kotlin.io.encoding.Base64 prohibido en capa UI',
    },
];

const UI_PATH_PATTERN = /^app\/composeApp\/src\/.*\.kt$/;
const RESSTRINGS_ALLOWLIST = /ui\/util\/ResStrings/;

function checkForbiddenStringsInDiff(unifiedDiff) {
    const findings = [];
    if (!unifiedDiff) return findings;
    const lines = unifiedDiff.split(/\r?\n/);
    let currentFile = null;
    let newLineNum = 0;

    for (const ln of lines) {
        const fileMatch = ln.match(/^\+\+\+ b\/(.+)$/);
        if (fileMatch) {
            currentFile = fileMatch[1];
            newLineNum = 0;
            continue;
        }
        const hunkMatch = ln.match(/^@@ .*\+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
            newLineNum = parseInt(hunkMatch[1], 10) - 1;
            continue;
        }
        if (ln.startsWith('+') && !ln.startsWith('+++')) {
            newLineNum += 1;
            if (!currentFile) continue;
            if (!UI_PATH_PATTERN.test(currentFile)) continue;
            if (RESSTRINGS_ALLOWLIST.test(currentFile)) continue;
            const content = ln.slice(1);
            for (const r of FORBIDDEN_STRINGS_RULES) {
                if (r.rx.test(content)) {
                    findings.push({
                        rule: r.rule,
                        severity: 'error',
                        file: currentFile,
                        line: newLineNum,
                        message: r.message,
                    });
                }
            }
        } else if (!ln.startsWith('-') && !ln.startsWith('---')) {
            newLineNum += 1;
        }
    }
    return findings;
}

// ── Naming de ramas ──────────────────────────────────────────────────
/**
 * Valida el nombre de rama según convenciones del repo.
 * - Agentes IA: agent/<issue>-<slug> (obligatorio para el pipeline)
 * - Feature/bugfix/docs/refactor manuales: <prefix>/<slug>
 */
function checkBranchName(branch, { issue = null } = {}) {
    const findings = [];
    if (!branch) {
        findings.push({
            rule: 'branch:missing', severity: 'error',
            message: 'No se pudo determinar la rama actual',
        });
        return findings;
    }
    if (branch === 'main' || branch === 'develop' || branch === 'HEAD') {
        findings.push({
            rule: 'branch:protected', severity: 'error',
            message: `Trabajando directamente sobre "${branch}" — usar agent/feature/bugfix/...`,
        });
        return findings;
    }
    const agentRx = /^agent\/(\d+)-[a-z0-9-]+$/;
    const manualRx = /^(feature|bugfix|docs|refactor|test|chore|fix)\/[a-z0-9][a-z0-9-]*$/i;
    const m = branch.match(agentRx);
    if (m) {
        if (issue && parseInt(m[1], 10) !== Number(issue)) {
            findings.push({
                rule: 'branch:issue-mismatch', severity: 'warn',
                message: `Rama agent/${m[1]}-... no coincide con issue #${issue}`,
            });
        }
        return findings;
    }
    if (manualRx.test(branch)) return findings;
    findings.push({
        rule: 'branch:naming', severity: 'warn',
        message: `Rama "${branch}" no sigue convención agent/<issue>-<slug> ni feature/bugfix/...`,
    });
    return findings;
}

// ── Archivos sensibles ───────────────────────────────────────────────
const SENSITIVE_FILE_PATTERNS = [
    { rx: /(^|\/)\.env(\..*)?$/, message: 'Archivo .env agregado al repo' },
    { rx: /\.pem$/, message: 'Archivo .pem (certificado/clave)' },
    { rx: /\.p12$/, message: 'Archivo .p12 (keystore)' },
    { rx: /(^|\/)id_rsa(\.pub)?$/, message: 'Clave SSH id_rsa' },
    { rx: /\.keystore$/, message: 'Android keystore' },
    { rx: /credentials(\.json|\.yaml|\.yml)?$/i, message: 'Archivo credentials' },
    { rx: /(^|\/)application\.conf$/, message: 'application.conf (podría contener secrets de AWS)' },
];

function checkSensitiveFiles(filePaths) {
    const findings = [];
    for (const p of filePaths || []) {
        for (const pat of SENSITIVE_FILE_PATTERNS) {
            if (pat.rx.test(p)) {
                findings.push({
                    rule: 'files:sensitive', severity: 'error',
                    file: p, message: pat.message,
                });
            }
        }
    }
    return findings;
}

// ── Tamaño del diff ──────────────────────────────────────────────────
function checkDiffSize({ files_changed = 0, additions = 0, deletions = 0 } = {}, thresholds = {}) {
    const { warn_lines = 1000, warn_files = 40 } = thresholds;
    const findings = [];
    const totalLines = additions + deletions;
    if (totalLines > warn_lines) {
        findings.push({
            rule: 'size:diff-large', severity: 'warn',
            message: `PR grande: ${totalLines} líneas (+${additions} -${deletions}) — considerar split`,
        });
    }
    if (files_changed > warn_files) {
        findings.push({
            rule: 'size:many-files', severity: 'warn',
            message: `PR toca ${files_changed} archivos — considerar split`,
        });
    }
    return findings;
}

// ── Reglas de PR / commits ───────────────────────────────────────────
/**
 * Verifica que al menos un commit en la rama referencie el issue con "Closes #N".
 * Acepta variantes: Closes, Fixes, Resolves (case-insensitive).
 */
function checkClosesIssue(commitMessages, issue) {
    const findings = [];
    if (!issue) return findings;
    if (!commitMessages || !commitMessages.length) {
        findings.push({
            rule: 'pr:no-commits', severity: 'error',
            message: 'No se encontraron commits en la rama',
        });
        return findings;
    }
    const rx = new RegExp(`\\b(?:closes|fixes|resolves)\\s+#${issue}\\b`, 'i');
    const hasClose = commitMessages.some((m) => rx.test(m));
    if (!hasClose) {
        findings.push({
            rule: 'pr:missing-closes', severity: 'warn',
            message: `Ningún commit referencia "Closes #${issue}" — el PR no cerrará el issue automáticamente`,
        });
    }
    return findings;
}

function checkCommitSubjects(commitMessages) {
    const findings = [];
    if (!commitMessages) return findings;
    // Reglas conservadoras: subject ≤ 100 chars, no terminar con punto.
    for (const msg of commitMessages) {
        const subject = (msg || '').split(/\r?\n/)[0] || '';
        if (!subject) continue;
        if (subject.length > 100) {
            findings.push({
                rule: 'commit:subject-long', severity: 'info',
                message: `Subject de commit > 100 chars: "${subject.slice(0, 60)}..."`,
            });
        }
        if (/[.!]$/.test(subject)) {
            findings.push({
                rule: 'commit:subject-punctuation', severity: 'info',
                message: `Subject termina con puntuación: "${subject.slice(0, 60)}"`,
            });
        }
    }
    return findings;
}

// ── Reporte ──────────────────────────────────────────────────────────
function aggregate(findings) {
    const bySeverity = { error: 0, warn: 0, info: 0 };
    for (const f of findings || []) {
        if (bySeverity[f.severity] !== undefined) bySeverity[f.severity] += 1;
    }
    const passed = bySeverity.error === 0;
    return { passed, counts: bySeverity, total: findings.length };
}

function renderMarkdownReport(findings, { issue, duration_ms = 0, branch = null, stats = null } = {}) {
    const agg = aggregate(findings);
    const status = agg.passed ? 'APROBADO ✅' : 'RECHAZADO ❌';
    const lines = [
        `## Linter: ${status}`,
        '',
        `- Issue: #${issue}  ·  Rama: \`${branch || '(desconocida)'}\`  ·  Duración: ${(duration_ms / 1000).toFixed(2)}s`,
        `- Findings: ${agg.total}  (errores: ${agg.counts.error}, warnings: ${agg.counts.warn}, info: ${agg.counts.info})`,
    ];
    if (stats) {
        lines.push(`- Diff: ${stats.files_changed} archivos · +${stats.additions} -${stats.deletions}`);
    }
    lines.push('');

    if (!findings.length) {
        lines.push('Sin findings — chequeos mecánicos OK.');
        return lines.join('\n');
    }

    const groups = {};
    for (const f of findings) {
        const key = f.severity;
        if (!groups[key]) groups[key] = [];
        groups[key].push(f);
    }

    for (const sev of ['error', 'warn', 'info']) {
        if (!groups[sev]) continue;
        const title = sev === 'error' ? 'Errores' : sev === 'warn' ? 'Warnings' : 'Info';
        lines.push(`### ${title} (${groups[sev].length})`);
        for (const f of groups[sev]) {
            const loc = f.file ? ` — \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
            lines.push(`- **${f.rule}**${loc}: ${f.message}`);
        }
        lines.push('');
    }

    lines.push('### Veredicto');
    lines.push(agg.passed
        ? 'Linter no bloquea — pasan a reviewer LLM (solo warnings/info).'
        : 'Linter bloquea entrega — rebote a dev para corregir errores listados.');
    return lines.join('\n');
}

module.exports = {
    SECRET_PATTERNS,
    SECRETS_ALLOWLIST,
    isSecretAllowed,
    checkSecretsInDiff,
    FORBIDDEN_STRINGS_RULES,
    checkForbiddenStringsInDiff,
    checkBranchName,
    SENSITIVE_FILE_PATTERNS,
    checkSensitiveFiles,
    checkDiffSize,
    checkClosesIssue,
    checkCommitSubjects,
    aggregate,
    renderMarkdownReport,
};
