// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

/**
 * #7113 · CA-7 — RATCHET de lecturas directas de credenciales.
 *
 * Los cuatro canales externos (Telegram, GitHub, proveedores, vault) se
 * resuelven desde el perfil de canales (`lib/credenciales-ambiente.js`); ningún
 * punto del pipeline lee la credencial "por su cuenta" con
 * `process.env.<SECRETO>`. Este test recorre `lib/**\/*.js` + los entrypoints
 * de raíz y falla si aparece una lectura directa NUEVA. Las que ya existían al
 * merge están en `LEGACY_ALLOWLIST` con su conteo EXACTO: bajar es gratis,
 * subir rompe (referencia: #7416 / #3060).
 *
 * Patrones vigilados:
 *   - directo:        process.env.VAR · process.env['VAR'] · process.env["VAR"]
 *   - destructuring:  const { ..., VAR, ... } = process.env
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PIPELINE_ROOT = path.resolve(__dirname, '..', '..');
const LIB_ROOT = path.join(PIPELINE_ROOT, 'lib');

const SECRETOS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

const RE_DIRECTO = new RegExp(`process\\.env(?:\\.|\\[['"])(${SECRETOS.join('|')})\\b`, 'g');
const RE_DESTRUCTURING = /\{([^{}]*)\}\s*=\s*process\.env\b/g;

/** Lecturas directas legítimas al momento del merge de #7113 (conteo exacto por archivo). */
const LEGACY_ALLOWLIST = Object.freeze({
    'lib/secrets-manifest.js': 1,
    'lib/ux-mockup-generator.js': 2,
});

const ENTRYPOINTS_RAIZ = ['pulpo.js', 'restart.js', 'servicio-telegram.js', 'servicio-github.js'];

function listarJs(dir, out = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
            listarJs(p, out);
        } else if (ent.isFile() && ent.name.endsWith('.js') && !ent.name.endsWith('.test.js')) {
            out.push(p);
        }
    }
    return out;
}

function archivosVigilados() {
    const libs = listarJs(LIB_ROOT);
    const raiz = ENTRYPOINTS_RAIZ.map((f) => path.join(PIPELINE_ROOT, f)).filter((p) => fs.existsSync(p));
    return [...libs, ...raiz];
}

function contarLecturas(src) {
    const hallazgos = [];
    for (const m of src.matchAll(RE_DIRECTO)) hallazgos.push({ tipo: 'directo', variable: m[1], indice: m.index });
    for (const m of src.matchAll(RE_DESTRUCTURING)) {
        for (const v of SECRETOS) {
            if (new RegExp(`(^|[\\s,{])${v}(\\s*[,:}]|\\s*=)`).test(m[1])) {
                hallazgos.push({ tipo: 'destructuring', variable: v, indice: m.index });
            }
        }
    }
    return hallazgos;
}

function lineaDe(src, indice) {
    return src.slice(0, indice).split('\n').length;
}

function relativo(p) {
    return path.relative(PIPELINE_ROOT, p).split(path.sep).join('/');
}

test('#7113 CA-7 · ninguna lectura directa NUEVA de credenciales fuera del perfil de canales (ratchet)', () => {
    const excesos = [];
    const vistos = new Set();
    for (const archivo of archivosVigilados()) {
        const rel = relativo(archivo);
        const src = fs.readFileSync(archivo, 'utf8');
        const hallazgos = contarLecturas(src);
        if (!hallazgos.length) continue;
        vistos.add(rel);
        const permitido = LEGACY_ALLOWLIST[rel] || 0;
        if (hallazgos.length > permitido) {
            const detalle = hallazgos.map((h) => `    ${rel}:${lineaDe(src, h.indice)}  ${h.tipo}  ${h.variable}`).join('\n');
            excesos.push(`  ${rel}: ${hallazgos.length} lectura/s directa/s (permitidas: ${permitido})\n${detalle}`);
        }
    }
    assert.equal(excesos.length, 0, [
        '',
        'RATCHET #7113 · lectura directa de credenciales fuera del perfil de canales.',
        'Causa: un archivo lee TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / GH_TOKEN / GITHUB_TOKEN /',
        '       ANTHROPIC_API_KEY / OPENAI_API_KEY con `process.env.<VAR>` en vez de resolverlo desde',
        '       `lib/credenciales-ambiente.js` (aplicar / transporteTelegram / VARIABLES) o',
        '       `lib/telegram-secrets.js` ({ env, ambiente }).',
        'Impacto: en el ambiente de pruebas ese punto puede alcanzar el chat del operador, el repo',
        '       real o la cuota productiva (#7102: 180 avisos el 08/09/2026).',
        'Próximo paso: pasar el env por parámetro y resolver por perfil. No sumar a LEGACY_ALLOWLIST',
        '       salvo deuda documentada (#7416 / #3060).',
        '',
        ...excesos,
    ].join('\n'));
});

test('#7113 CA-7 · la allowlist legacy no tiene entradas muertas (si bajaron, bajar el número)', () => {
    const sobrantes = [];
    for (const [rel, permitido] of Object.entries(LEGACY_ALLOWLIST)) {
        const abs = path.join(PIPELINE_ROOT, ...rel.split('/'));
        if (!fs.existsSync(abs)) { sobrantes.push(`${rel}: el archivo ya no existe`); continue; }
        const reales = contarLecturas(fs.readFileSync(abs, 'utf8')).length;
        if (reales < permitido) sobrantes.push(`${rel}: hay ${reales} lectura/s, la allowlist permite ${permitido} — bajar el número`);
    }
    assert.deepEqual(sobrantes, [], sobrantes.join('\n'));
});

test('#7113 CA-7 · el propio detector reconoce los dos patrones vigilados', () => {
    const src = [
        "const a = process.env.TELEGRAM_BOT_TOKEN;",
        "const b = process.env['GH_TOKEN'];",
        'const { PATH, OPENAI_API_KEY, HOME } = process.env;',
        'const { GITHUB_TOKEN: tok } = process.env;',
        "const ok = env.TELEGRAM_BOT_TOKEN; // env por parámetro: NO cuenta",
        "const ok2 = process.env.TELEGRAM_BOT_TOKEN_PRUEBAS; // variable de pruebas: NO cuenta",
    ].join('\n');
    const h = contarLecturas(src);
    assert.deepEqual(h.map((x) => `${x.tipo}:${x.variable}`).sort(), [
        'destructuring:GITHUB_TOKEN', 'destructuring:OPENAI_API_KEY', 'directo:GH_TOKEN', 'directo:TELEGRAM_BOT_TOKEN',
    ]);
});
