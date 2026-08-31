#!/usr/bin/env node
// =============================================================================
// vault-cut-breakglass.js — CLI del corte fuera de banda (#5460 · CA-28).
//
// Camino de emergencia cuando Telegram no está disponible. Toda la lógica vive
// en `lib/vault-cut-breakglass.js` (testeable); acá sólo hay parseo de argv,
// lectura de stdin y códigos de salida.
//
//   Uso:
//     echo "CORTAR FALLBACK" | node .pipeline/vault-cut-breakglass.js --operator <id>
//
//   El id de operador también sale de `PIPELINE_OPERATOR_ID` si no se pasa
//   `--operator`. Es un identificador PÚBLICO (está en CODEOWNERS): no es la
//   prueba de identidad por sí solo, la autoridad la da estar en la allowlist
//   cerrada en código (`lib/operator-allowlist.js`) con rol `primary`.
//
//   La frase de confirmación va SIEMPRE por stdin, nunca por argv: argv lo lee
//   cualquier proceso del host y queda en el historial del shell.
//
//   Códigos de salida (estables, documentados en el runbook):
//     0  cortado / ya cortado     12 cobertura insuficiente
//     10 no autorizado            13 precondicion incumplida
//     11 frase no confirmada      14 indeterminado
//
// Ver: docs/operacion-pipeline.md#corte-fallback-vault
// =============================================================================
'use strict';

const path = require('node:path');

const breakGlass = require('./lib/vault-cut-breakglass');

/** Lee argv sin dependencias. Sólo `--operator <id>` (y `--help`). */
function parseArgs(argv) {
    const out = { operatorId: process.env.PIPELINE_OPERATOR_ID || '', help: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
        else if (argv[i] === '--operator' && argv[i + 1]) { out.operatorId = argv[i + 1]; i++; }
        else if (argv[i].startsWith('--operator=')) out.operatorId = argv[i].slice('--operator='.length);
    }
    return out;
}

/** Lee stdin completo. Si no hay stdin (TTY), devuelve '' — nunca cuelga. */
function readStdin() {
    return new Promise((resolve) => {
        if (process.stdin.isTTY) { resolve(''); return; }
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            data += chunk;
            // Cota defensiva: la frase son 15 bytes. Un stdin gigante es un error
            // de uso (o un pipe equivocado), no una confirmación.
            if (data.length > 4096) { data = data.slice(0, 4096); process.stdin.pause(); resolve(data); }
        });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(''));
    });
}

const HELP = [
    'Corte fuera de banda del fallback del vault (break-glass).',
    '',
    'Uso:',
    `  echo "${breakGlass.CONFIRM_PHRASE}" | node .pipeline/vault-cut-breakglass.js --operator <id>`,
    '',
    'La frase de confirmacion va por STDIN, nunca por argv.',
    'La identidad local debe ser un operador `primary` de lib/operator-allowlist.js.',
    'La cobertura positiva del vault se revalida igual: el break-glass NO la saltea.',
    '',
    'Runbook: docs/operacion-pipeline.md#corte-fallback-vault',
].join('\n');

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { process.stdout.write(`${HELP}\n`); return 0; }

    const confirmation = await readStdin();
    const pipelineDir = __dirname;

    // El evaluador de cobertura es el REAL: mismo módulo, mismos descriptores,
    // misma config. No se acepta ninguna forma de saltearlo desde la CLI.
    const evaluateCoverage = () => {
        // eslint-disable-next-line global-require
        const metrics = require('./lib/vault-shadow-metrics');
        // eslint-disable-next-line global-require
        const { ENV_DESCRIPTORS } = require('./lib/credentials');
        // eslint-disable-next-line global-require
        const configResolver = require('./lib/config-resolver');
        const cfg = configResolver.resolve() || {};
        const vault = (cfg && cfg.vault) || {};
        const win = (vault.shadow_window && typeof vault.shadow_window === 'object') ? vault.shadow_window : {};
        return metrics.getVaultShadowMetrics().evaluate({
            descriptors: ENV_DESCRIPTORS,
            hostsActivos: win.hosts_activos,
            durationHours: win.duration_hours,
            retentionDays: win.retention_days,
        });
    };

    let runbook;
    try {
        // eslint-disable-next-line global-require
        const cfg = require('./lib/config-resolver').resolve() || {};
        runbook = ((cfg.vault || {}).cut_fallback || {}).runbook;
    } catch { runbook = undefined; }

    const outcome = await breakGlass.runBreakGlass({
        operatorId: args.operatorId,
        confirmation,
        evaluateCoverage,
        configPath: path.join(pipelineDir, 'config.yaml'),
        runbook,
    });

    process.stdout.write(`${breakGlass.formatBreakGlassOutcome(outcome)}\n`);
    if (!outcome.audited) {
        process.stdout.write('AVISO · el registro de auditoria del break-glass no se pudo escribir.\n');
    }
    return outcome.exitCode;
}

if (require.main === module) {
    main()
        .then((code) => { process.exitCode = code; })
        .catch(() => {
            // Nunca se imprime el error: puede traer paths o contexto del host.
            process.stdout.write('VAULT · break-glass: fallo inesperado; el fallback se conserva.\n');
            process.exitCode = breakGlass.EXIT_CODE[breakGlass.RESULT.UNAVAILABLE];
        });
}

module.exports = { parseArgs, readStdin, HELP };
