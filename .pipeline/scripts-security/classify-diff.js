#!/usr/bin/env node
// classify-diff.js [base-ref]
// Clasifica los archivos del diff actual (vs origin/main por default) en
// niveles de riesgo de seguridad: high, medium, low. Reemplaza el paso S2 del
// SKILL.md de /security y habilita el smart-skip del modo gate.
//
// Uso:
//   node classify-diff.js                 # diff vs origin/main
//   node classify-diff.js origin/develop  # diff vs otra base
//
// Exit codes:
//   0 = clasificacion exitosa (independiente del riesgo)
//   2 = error de IO o git no disponible

const { spawnSync } = require('child_process');

const HIGH_RISK_PATTERNS = [
    /\/auth\//i,
    /Auth[A-Z]/,
    /Security[A-Z]/,
    /Token/i,
    /Password/i,
    /Secret/i,
    /Credentials?/i,
    /\/config\//,
    /\.conf$/,
    /\.properties$/,
    /Function\.kt$/,
    /SecuredFunction/,
    /Cognito/i,
    /Lambda/i,
    /Jwt/i,
    /Crypto/i,
];

const MEDIUM_RISK_PATTERNS = [
    /ViewModel\.kt$/,
    /Service\.kt$/,
    /Client\.kt$/,
    /\/di\//,
    /Validator\.kt$/,
    /build\.gradle\.kts$/,
    /dependency/i,
    /libs\.versions\.toml$/,
];

function classify(file) {
    for (const p of HIGH_RISK_PATTERNS) if (p.test(file)) return 'high';
    for (const p of MEDIUM_RISK_PATTERNS) if (p.test(file)) return 'medium';
    return 'low';
}

function main() {
    const base = process.argv[2] || 'origin/main';
    const proc = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' });
    if (proc.status !== 0) {
        console.error(JSON.stringify({ error: 'git diff fallo', stderr: proc.stderr }));
        process.exit(2);
    }
    const files = proc.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    const classified = files.map(f => ({ file: f, risk: classify(f) }));

    const counts = { high: 0, medium: 0, low: 0 };
    for (const c of classified) counts[c.risk]++;

    const result = {
        base_ref: base,
        total_files: files.length,
        counts,
        sensitive: counts.high + counts.medium > 0,
        files: classified,
    };
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
}

main();
