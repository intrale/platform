#!/usr/bin/env node
// scan-secrets.js [<path>]
// Escanea recursivamente un path en busca de patrones de secrets hardcodeados:
// API keys, tokens, passwords, private keys. Reemplaza el grep manual del paso S4
// del SKILL.md de /security.
//
// Uso:
//   node scan-secrets.js                  # escanea cwd
//   node scan-secrets.js backend/src      # escanea path especifico
//
// Exit codes:
//   0 = sin findings
//   1 = al menos un finding (potencial secret)
//   2 = error de uso o IO

const fs = require('fs');
const path = require('path');

const SCAN_EXTS = new Set(['.kt', '.kts', '.java', '.js', '.ts', '.json', '.conf', '.properties', '.yml', '.yaml', '.env']);
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'build', '.gradle', '.idea', 'dist', 'out', '.kotlin', 'kotlin-js-store']);

const PATTERNS = [
    {
        id: 'aws_access_key',
        owasp: 'A02',
        severity: 'critical',
        regex: /\bAKIA[0-9A-Z]{16}\b/,
        description: 'AWS Access Key ID',
    },
    {
        id: 'aws_secret_key',
        owasp: 'A02',
        severity: 'critical',
        regex: /aws[_-]?secret[_-]?(access[_-]?)?key\s*[=:]\s*['"][A-Za-z0-9/+=]{40}['"]/i,
        description: 'AWS Secret Access Key',
    },
    {
        id: 'private_key_block',
        owasp: 'A02',
        severity: 'critical',
        regex: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
        description: 'Bloque de clave privada',
    },
    {
        id: 'generic_secret',
        owasp: 'A02',
        severity: 'high',
        regex: /\b(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[=:]\s*['"][^'"\s$]{8,}['"]/i,
        description: 'Posible secret hardcodeado (password/secret/api_key/token)',
    },
    {
        id: 'jwt_token',
        owasp: 'A02',
        severity: 'high',
        regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
        description: 'Token JWT hardcodeado',
    },
    {
        id: 'github_token',
        owasp: 'A02',
        severity: 'critical',
        regex: /\b(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,}\b/,
        description: 'Token de GitHub',
    },
    {
        id: 'slack_token',
        owasp: 'A02',
        severity: 'high',
        regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
        description: 'Token de Slack',
    },
];

function isLikelyTestFixture(file) {
    const norm = file.replace(/\\/g, '/').toLowerCase();
    return /\/(test|tests|fixtures|__mocks__|sample|samples|examples?)\//.test(norm)
        || /test\.[a-z]+$/.test(norm)
        || /spec\.[a-z]+$/.test(norm);
}

function walk(dir, out) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        if (e.name.startsWith('.') && IGNORE_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (IGNORE_DIRS.has(e.name)) continue;
            walk(full, out);
        } else if (e.isFile()) {
            const ext = path.extname(e.name).toLowerCase();
            if (SCAN_EXTS.has(ext) || e.name === '.env') out.push(full);
        }
    }
}

function scanFile(file) {
    let content;
    try {
        content = fs.readFileSync(file, 'utf8');
    } catch {
        return [];
    }
    const findings = [];
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const p of PATTERNS) {
            const m = p.regex.exec(line);
            if (m) {
                findings.push({
                    file,
                    line: i + 1,
                    pattern_id: p.id,
                    owasp: p.owasp,
                    severity: isLikelyTestFixture(file) ? 'low' : p.severity,
                    description: p.description,
                    excerpt: line.length > 200 ? line.slice(0, 200) + '…' : line,
                    in_test_fixture: isLikelyTestFixture(file),
                });
            }
        }
    }
    return findings;
}

function main() {
    const target = process.argv[2] || process.cwd();
    if (!fs.existsSync(target)) {
        console.error(JSON.stringify({ error: 'path no existe', path: target }));
        process.exit(2);
    }
    const files = [];
    if (fs.statSync(target).isDirectory()) walk(target, files);
    else files.push(target);

    const allFindings = [];
    for (const f of files) allFindings.push(...scanFile(f));

    const summary = {
        scanned_files: files.length,
        findings_count: allFindings.length,
        critical: allFindings.filter(f => f.severity === 'critical').length,
        high: allFindings.filter(f => f.severity === 'high').length,
        medium: allFindings.filter(f => f.severity === 'medium').length,
        low: allFindings.filter(f => f.severity === 'low').length,
        findings: allFindings,
    };
    console.log(JSON.stringify(summary, null, 2));

    const blocking = summary.critical + summary.high;
    process.exit(blocking > 0 ? 1 : 0);
}

main();
