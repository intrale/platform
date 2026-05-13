#!/usr/bin/env node
// =============================================================================
// override-permission.js — CLI atómico para crear overrides de permisos.
//
// Issue: #3082 (S4 multi-provider) — CA-16, CA-17.
//
// Operación atómica: en una sola invocación
//   (a) valida argumentos
//   (b) escribe entry en `.pipeline/audit/permission-overrides.jsonl` con
//       hash chain SHA-256
//   (c) encola notificación Telegram natural en `servicios/telegram/pendiente/`
//
// Si cualquier paso falla → exit code != 0 y NO se escribe entry parcial.
//
// Uso:
//   node .pipeline/scripts/override-permission.js \
//     --skill <X> \
//     --provider <Y> \
//     --mode-requerido <mode-original> \
//     --mode-otorgado <mode-efectivo> \
//     --capabilities-diff <cap1,cap2,...> \
//     --justify '<motivo libre, mín 30 chars>' \
//     --ttl-horas <N>            (default 24, max 168)
//     [--autor <git-user>]       (default: leer de `git config user.email`)
//     [--no-telegram]            (suprime notificación, solo writes JSONL)
//
// Validaciones (delegadas a permission-validator.recordOverride):
//   - skill NO en NON_DEGRADABLE_SKILLS
//   - ttl_horas ∈ [1, 168]
//   - justificacion ≥ 30 chars
//   - capabilities_diff array
//   - autor presente
//
// Salida en stdout: JSON con `{hash_self, hash_prev, expires_at, telegram_queued}`
// =============================================================================
'use strict';

const path = require('node:path');
const { execSync } = require('node:child_process');

const permissionValidator = require('../lib/permission-validator');
const telegramHelper = require('../lib/permission-override-telegram');

// -----------------------------------------------------------------------------
// parseArgs — parser minimalista de --key value y --flag.
// Devuelve { args: {...}, flags: Set<string> }.
// -----------------------------------------------------------------------------
function parseArgs(argv) {
    const args = {};
    const flags = new Set();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (typeof next === 'undefined' || next.startsWith('--')) {
            flags.add(key);
        } else {
            args[key] = next;
            i++;
        }
    }
    return { args, flags };
}

// -----------------------------------------------------------------------------
// resolveAutor — intenta leer `git config user.email`. Si falla devuelve null
// y el caller decide si abortar.
// -----------------------------------------------------------------------------
function resolveAutor() {
    try {
        const out = execSync('git config user.email', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return out.trim();
    } catch {
        return null;
    }
}

function usage() {
    return [
        'Uso: node .pipeline/scripts/override-permission.js \\',
        '       --skill <X> --provider <Y> --mode-requerido <M1> --mode-otorgado <M2> \\',
        '       --capabilities-diff <cap1,cap2,...> \\',
        '       --justify \'<motivo libre, mín 30 chars>\' \\',
        '       --ttl-horas <N>            (default 24, max 168)',
        '       [--autor <git-user>]       (default: leer git config user.email)',
        '       [--no-telegram]            (suprime notificación)',
        '',
        'Ver docs/pipeline-multi-provider/permission-mapping.md para detalles.',
    ].join('\n');
}

function main(argv) {
    const { args, flags } = parseArgs(argv);

    if (flags.has('help') || flags.has('h')) {
        console.log(usage());
        return 0;
    }

    const skill = args['skill'];
    const provider = args['provider'];
    const mode_requerido = args['mode-requerido'] || null;
    const mode_otorgado = args['mode-otorgado'] || null;
    const capabilities_diff = (args['capabilities-diff'] || '')
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
    const justificacion = args['justify'];
    const ttl_horas = Number(args['ttl-horas'] || 24);
    const autor = args['autor'] || resolveAutor();

    // Validaciones de CLI (fast feedback antes de delegar a recordOverride)
    if (!skill || !provider || !justificacion) {
        process.stderr.write('[override-permission] Faltan parámetros obligatorios: --skill, --provider, --justify.\n');
        process.stderr.write(usage() + '\n');
        return 1;
    }
    if (!autor) {
        process.stderr.write('[override-permission] No pude resolver autor (--autor o git config user.email).\n');
        return 1;
    }

    let entry;
    try {
        entry = permissionValidator.recordOverride({
            skill,
            provider,
            mode_requerido,
            mode_otorgado,
            capabilities_diff,
            justificacion,
            autor,
            ttl_horas,
        });
    } catch (e) {
        process.stderr.write(`[override-permission] FAIL: ${e.message}\n`);
        return 2;
    }

    let telegramQueued = null;
    if (!flags.has('no-telegram')) {
        try {
            telegramQueued = telegramHelper.notifyOverrideCreated(entry);
        } catch (e) {
            // El JSONL ya está escrito. No abortamos el override por un fallo de notificación.
            process.stderr.write(`[override-permission] WARN: notificación Telegram falló: ${e.message}\n`);
            process.stderr.write(`[override-permission] El override está activo (hash ${entry.hash_self.slice(0, 16)}). Notificá manualmente al chat.\n`);
        }
    }

    const out = {
        ok: true,
        hash_self: entry.hash_self,
        hash_prev: entry.hash_prev,
        skill: entry.skill,
        provider: entry.provider,
        ttl_horas: entry.ttl_horas,
        expires_at: entry.created_at + entry.ttl_horas * 3600 * 1000,
        telegram_queued: telegramQueued,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
}

if (require.main === module) {
    const code = main(process.argv.slice(2));
    process.exit(code);
}

module.exports = { main, parseArgs, resolveAutor };
