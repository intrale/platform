// Hook PreToolUse[Bash]: corte transitorio de recomendaciones (#7673)
//
// Mientras `recomendaciones.crear_issues` no sea el booleano `true` en
// `.pipeline/config.yaml`, bloquea los comandos `gh` que crean o etiquetan un
// issue de recomendación (`tipo:recomendacion` / `source:recommendation`):
//   - `gh issue create` con `--label X`, `--label=X`, `-l X` (varios, comillas, cualquier orden);
//   - `gh issue edit … --add-label …`;
//   - `gh api …/issues … -f/-F labels[]=…`.
// La oportunidad va como una línea en "Otras oportunidades observadas" del
// comentario del issue origen. El corte es transitorio hasta la Ola Propuestas (#7361).
//
// Contrato de salida:
//   - bloqueo ⇒ exit 2 + mensaje en stderr (Claude Code se lo muestra al agente);
//   - cualquier otro caso ⇒ exit 0.
// Fail-closed ACOTADO (SEC-3): una excepción interna NO bloquea Bash (dejaría sin
// servicio a todos los agentes). La única excepción: si el comando ya coincidió,
// una falla leyendo la config vale `false` y bloquea (SEC-1).
// Límite conocido: los fallbacks de otros proveedores (Codex/Antigravity) no
// ejecutan hooks; ahí la barrera es el rol + el guardrail de la cola de GitHub.
// SEC-3: el comando sólo se COMPARA con patrones; nunca se ejecuta ni se interpola.
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_READ = 2 * 1024 * 1024; // un `--body` largo no puede truncar el JSON y saltear el corte
let input = '';
let done = false;

function finish(code) {
    try { process.exit(code); } catch (_) { /* nada */ }
}

function auditDir(env) {
    // Misma resolución que `label-guardrail.defaultAuditDir()` (write-target), en
    // su variante que NUNCA lanza: sin destino declarado, se omite la auditoría
    // pero el bloqueo se aplica igual.
    try {
        const writeTarget = require(path.join(__dirname, '..', '..', '.pipeline', 'lib', 'write-target'));
        return writeTarget.safeWritePath(env, {
            canal: 'logs',
            destino: 'audit/recommendation-guard*.jsonl',
            stderr: { write() {} },
        }, 'audit');
    } catch (_) {
        return null;
    }
}

/**
 * Escribe la línea de auditoría. SEC-4: timestamp, skill, issue, labels, motivo
 * y título (≤120). Nunca el comando completo ni el `--body`. Nunca tira.
 */
function writeAudit(match, { env = process.env, now = new Date(), dir } = {}) {
    try {
        const d = dir || auditDir(env);
        if (!d) return false;
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        const ts = now.toISOString();
        const file = path.join(d, `recommendation-guard-${ts.slice(0, 10)}.jsonl`);
        const entry = {
            timestamp: ts,
            skill: env.PIPELINE_SKILL || null,
            issue: env.PIPELINE_ISSUE ? (Number(env.PIPELINE_ISSUE) || env.PIPELINE_ISSUE) : null,
            accion: match.kind,
            labels: match.labels,
            motivo: 'recomendaciones-corte-transitorio',
            title: match.title,
        };
        fs.appendFileSync(file, JSON.stringify(entry) + '\n');
        return true;
    } catch (_) {
        return false;
    }
}

function handleInput() {
    let cut;
    let match;
    try {
        const data = JSON.parse(input || '{}');
        if (!data || data.tool_name !== 'Bash') return finish(0);
        const command = (data.tool_input && data.tool_input.command) || '';
        cut = require(path.join(__dirname, '..', '..', '.pipeline', 'lib', 'recommendations-cut'));
        match = cut.matchBashCommand(command);
        if (!match) return finish(0);
    } catch (_) {
        return finish(0); // SEC-3 — una excepción antes de coincidir no bloquea Bash.
    }

    // El comando coincidió: a partir de acá, cualquier falla vale "corte activo".
    let enabled = false;
    try {
        enabled = cut.isCreationEnabled() === true;
    } catch (_) {
        enabled = false;
    }
    if (enabled) return finish(0);

    writeAudit(match);
    let msg;
    try { msg = cut.BLOCK_MESSAGE; } catch (_) { msg = null; }
    try {
        process.stderr.write((msg || 'Creación de recomendaciones pausada (#7673).') + '\n');
    } catch (_) { /* stderr cerrado: el exit 2 sigue siendo la señal */ }
    return finish(2);
}

if (require.main === module) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        if (done) return;
        input += chunk;
        if (input.length >= MAX_READ) { done = true; try { process.stdin.destroy(); } catch (_) {} handleInput(); }
    });
    process.stdin.on('end', () => { if (!done) { done = true; handleInput(); } });
    process.stdin.on('error', () => { if (!done) { done = true; handleInput(); } });
    setTimeout(() => {
        if (!done) { done = true; try { process.stdin.destroy(); } catch (_) {} handleInput(); }
    }, 3000);
}

module.exports = { writeAudit };
