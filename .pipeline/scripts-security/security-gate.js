#!/usr/bin/env node
// security-gate.js [base-ref]
// Wrapper smart-skip para el modo `gate` de /security.
//
// Flujo:
//   1. Invoca classify-diff.js para clasificar archivos del diff por riesgo.
//   2. Si NO hay archivos sensibles (high/medium) -> emite el JSON de pass al
//      stdout y termina con exit 0 SIN invocar al LLM. Este es el "skip".
//   3. Si hay archivos sensibles -> emite un JSON con `needs_llm: true` y la
//      lista de archivos sensibles, y termina con exit 100 (codigo reservado
//      para "el caller debe invocar /security gate con LLM").
//
// Fail-safe: si classify-diff.js falla por cualquier motivo (git no disponible,
// repo corrupto, etc), emite `needs_llm: true` con `reason: classify-diff-error`
// para que el caller no se saltee la auditoria por error de infra.
//
// Uso:
//   node security-gate.js                 # diff vs origin/main
//   node security-gate.js origin/develop  # diff vs otra base
//
// Salida estandar (siempre JSON valido en una linea):
//   skip:    {"gate":"security","status":"pass","critical":0,"high":0,"blockers":[],"reason":"diff sin archivos sensibles - skip","mode":"deterministic","total_files":N}
//   needs LLM: {"gate":"security","status":"needs_llm","reason":"diff con archivos sensibles","mode":"llm","sensitive_files":[...],"total_files":N}
//
// Exit codes:
//   0   = skip determinista emitido (status=pass)
//   100 = el caller debe invocar al LLM (status=needs_llm)
//   2   = error de uso (no deberia pasar — fail-safe lo convierte en 100)

const path = require('path');
const { spawnSync } = require('child_process');

const EXIT_SKIP = 0;
const EXIT_NEEDS_LLM = 100;

const CLASSIFY_SCRIPT = path.join(__dirname, 'classify-diff.js');

function emit(obj, code) {
    process.stdout.write(JSON.stringify(obj) + '\n');
    process.exit(code);
}

function main() {
    const base = process.argv[2] || 'origin/main';

    const proc = spawnSync('node', [CLASSIFY_SCRIPT, base], { encoding: 'utf8' });

    if (proc.status !== 0) {
        // Fail-safe: si classify-diff falla, NO saltear -> exigir LLM.
        emit({
            gate: 'security',
            status: 'needs_llm',
            mode: 'llm',
            reason: 'classify-diff-error: fail-safe a flujo normal',
            error: (proc.stderr || '').trim().slice(0, 400),
        }, EXIT_NEEDS_LLM);
    }

    let parsed;
    try {
        parsed = JSON.parse(proc.stdout);
    } catch (e) {
        emit({
            gate: 'security',
            status: 'needs_llm',
            mode: 'llm',
            reason: 'classify-diff-output-invalid: fail-safe a flujo normal',
            error: e.message,
        }, EXIT_NEEDS_LLM);
    }

    const { sensitive, total_files, files = [], counts = {} } = parsed;

    if (!sensitive) {
        emit({
            gate: 'security',
            status: 'pass',
            critical: 0,
            high: 0,
            blockers: [],
            reason: total_files === 0
                ? 'diff vacio - skip'
                : 'diff sin archivos sensibles - skip',
            mode: 'deterministic',
            total_files,
            counts,
        }, EXIT_SKIP);
    }

    const sensitiveFiles = files.filter(f => f.risk === 'high' || f.risk === 'medium');

    emit({
        gate: 'security',
        status: 'needs_llm',
        mode: 'llm',
        reason: 'diff con archivos sensibles - se requiere auditoria LLM',
        total_files,
        counts,
        sensitive_files: sensitiveFiles,
    }, EXIT_NEEDS_LLM);
}

main();
