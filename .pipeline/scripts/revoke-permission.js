#!/usr/bin/env node
// =============================================================================
// revoke-permission.js — Revoca un override antes del TTL.
//
// Issue: #3082 (S4 multi-provider) — CA-17 (apertura de revocación).
//
// Escribe una entry `permission_override_revocation` apuntando al hash_self
// del override original. Append-only, hash chain conservada — la entry
// original NO se mutaa.
//
// Uso:
//   node .pipeline/scripts/revoke-permission.js \
//     --hash <hash_self_o_prefix> \
//     --motivo '<motivo de revocación, mín 10 chars>' \
//     [--autor <git-user>]
//
// El --hash acepta un prefijo (los primeros 16+ chars) — el script resuelve
// el hash completo leyendo el JSONL y matcheando prefijo.
// =============================================================================
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const auditLog = require('../lib/audit-log');
const permissionValidator = require('../lib/permission-validator');

const { parseArgs, resolveAutor } = require('./override-permission');

function usage() {
    return [
        'Uso: node .pipeline/scripts/revoke-permission.js \\',
        '       --hash <hash_self_o_prefix> \\',
        '       --motivo \'<motivo de revocación, mín 10 chars>\' \\',
        '       [--autor <git-user>]',
    ].join('\n');
}

function findFullHashByPrefix(prefix, overridesPath) {
    if (typeof prefix !== 'string' || prefix.length < 4) {
        throw new Error('[revoke-permission] --hash debe tener al menos 4 chars.');
    }
    const entries = auditLog.readAll(overridesPath);
    const matches = entries.filter(e => typeof e.hash_self === 'string' && e.hash_self.startsWith(prefix));
    if (matches.length === 0) {
        throw new Error(`[revoke-permission] No encontré override con hash que arranque con '${prefix}'.`);
    }
    if (matches.length > 1 && prefix.length < 16) {
        throw new Error(`[revoke-permission] El prefijo '${prefix}' matchea ${matches.length} entries. Usá más caracteres (mín 16).`);
    }
    // Si hay match exacto preferirlo; si no, devolver el más reciente.
    const exact = matches.find(e => e.hash_self === prefix);
    if (exact) return exact.hash_self;
    return matches[matches.length - 1].hash_self;
}

function main(argv) {
    const { args, flags } = parseArgs(argv);
    if (flags.has('help') || flags.has('h')) {
        console.log(usage());
        return 0;
    }
    const hashOrPrefix = args['hash'];
    const motivo = args['motivo'];
    const autor = args['autor'] || resolveAutor();

    if (!hashOrPrefix || !motivo) {
        process.stderr.write('[revoke-permission] Faltan parámetros obligatorios: --hash, --motivo.\n');
        process.stderr.write(usage() + '\n');
        return 1;
    }
    if (!autor) {
        process.stderr.write('[revoke-permission] No pude resolver autor (--autor o git config user.email).\n');
        return 1;
    }

    let targetHash;
    try {
        targetHash = findFullHashByPrefix(hashOrPrefix, permissionValidator.DEFAULT_OVERRIDES_PATH);
    } catch (e) {
        process.stderr.write(`[revoke-permission] FAIL: ${e.message}\n`);
        return 2;
    }

    let entry;
    try {
        entry = permissionValidator.revokeOverride({
            targetHash,
            motivo,
            autor,
        });
    } catch (e) {
        process.stderr.write(`[revoke-permission] FAIL: ${e.message}\n`);
        return 2;
    }

    const out = {
        ok: true,
        revocation_hash: entry.hash_self,
        target_hash: entry.target_hash,
        motivo: entry.motivo,
        autor: entry.autor,
        created_at: entry.created_at,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
}

if (require.main === module) {
    const code = main(process.argv.slice(2));
    process.exit(code);
}

module.exports = { main, findFullHashByPrefix };
