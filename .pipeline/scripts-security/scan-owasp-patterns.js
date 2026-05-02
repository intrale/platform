#!/usr/bin/env node
// scan-owasp-patterns.js [<path>]
// Escanea el codigo en busca de patrones asociados a OWASP Top 10 (A01-A09)
// que el agente /security verificaba con grep ad-hoc en el paso S3.
//
// Uso:
//   node scan-owasp-patterns.js               # cwd
//   node scan-owasp-patterns.js backend/src
//
// Exit codes:
//   0 = sin findings
//   1 = findings detectados
//   2 = error de uso

const fs = require('fs');
const path = require('path');

const SCAN_EXTS = new Set(['.kt', '.kts']);
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'build', '.gradle', '.idea', 'dist', 'out', '.kotlin']);

const PATTERNS = [
    {
        id: 'function_handles_sensitive_data',
        owasp: 'A01',
        severity: 'high',
        regex: /class\s+\w+\s*\([^)]*\)\s*:\s*Function\b/,
        description: 'Endpoint Function (no Secured) — verificar si maneja datos sensibles',
    },
    {
        id: 'debug_user_header',
        owasp: 'A05',
        severity: 'high',
        regex: /X-Debug-User/i,
        description: 'Header X-Debug-User presente — debe estar deshabilitado en prod',
    },
    {
        id: 'cors_wildcard',
        owasp: 'A05',
        severity: 'medium',
        regex: /allowHost\s*\(\s*"\*"|allowAnyHost\s*\(\)/,
        description: 'CORS con wildcard o anyHost — restringir origenes',
    },
    {
        id: 'todo_enable_auth',
        owasp: 'A01',
        severity: 'medium',
        regex: /\/\/\s*TODO[:\s].*(?:auth|secur)/i,
        description: 'TODO de habilitar auth/security — pendiente de cierre',
    },
    {
        id: 'logger_with_password',
        owasp: 'A09',
        severity: 'high',
        regex: /logger\.(info|debug|warn|error|trace)\s*\(.*\b(password|passwd|pwd|secret|token)\b/i,
        description: 'Logger con dato sensible (password/token/secret) — riesgo de logging failure',
    },
    {
        id: 'println_with_sensitive',
        owasp: 'A09',
        severity: 'medium',
        regex: /println\s*\(.*\b(password|passwd|pwd|secret|token|jwt)\b/i,
        description: 'println con dato sensible — riesgo de logging failure',
    },
    {
        id: 'string_concat_in_query',
        owasp: 'A03',
        severity: 'medium',
        regex: /(query|sql|cmd)\s*=?\s*"[^"]*"\s*\+\s*\w+/i,
        description: 'Concatenacion de strings en query — posible injection',
    },
    {
        id: 'md5_or_sha1_for_password',
        owasp: 'A02',
        severity: 'high',
        regex: /MessageDigest\.getInstance\s*\(\s*"(MD5|SHA-?1)"\s*\)/i,
        description: 'Hash debil (MD5/SHA1) — no usar para passwords',
    },
    {
        id: 'base64_as_encryption',
        owasp: 'A02',
        severity: 'medium',
        regex: /\/\/[^\n]*(?:encrypt|cifr).*Base64|Base64.*(?:encrypt|cifr)/i,
        description: 'Base64 referenciado como cifrado — Base64 es encoding, no cifrado',
    },
    {
        id: 'jwt_decode_without_verify',
        owasp: 'A07',
        severity: 'high',
        regex: /JWT\.decode\s*\(/,
        description: 'JWT.decode() sin verify — debe usarse JWT.require + verify',
    },
];

function walk(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (IGNORE_DIRS.has(e.name)) continue;
            walk(full, out);
        } else if (SCAN_EXTS.has(path.extname(e.name).toLowerCase())) {
            out.push(full);
        }
    }
}

function scanFile(file) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const lines = content.split(/\r?\n/);
    const findings = [];
    for (let i = 0; i < lines.length; i++) {
        for (const p of PATTERNS) {
            if (p.regex.test(lines[i])) {
                findings.push({
                    file,
                    line: i + 1,
                    pattern_id: p.id,
                    owasp: p.owasp,
                    severity: p.severity,
                    description: p.description,
                    excerpt: lines[i].length > 200 ? lines[i].slice(0, 200) + '…' : lines[i],
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

    const all = [];
    for (const f of files) all.push(...scanFile(f));

    const result = {
        scanned_files: files.length,
        findings_count: all.length,
        critical: all.filter(f => f.severity === 'critical').length,
        high: all.filter(f => f.severity === 'high').length,
        medium: all.filter(f => f.severity === 'medium').length,
        low: all.filter(f => f.severity === 'low').length,
        findings: all,
    };
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.critical + result.high > 0 ? 1 : 0);
}

main();
