// =============================================================================
// validate-copy.js — Validador del copy del aviso por episodio (#6179, UX)
//
// Recorre la matriz COMPLETA de avisos (evento × tier × causa) y valida sobre
// el TEXTO RENDERIZADO — no sobre el JSON — los criterios de copy del issue:
//
//   CA-4 · las cuatro preguntas (qué cambió · por qué · desde cuándo · consecuencia)
//   CA-5 · ningún id de proveedor ni de modelo
//   CA-7 · sólo pide acción cuando existe una
//   CA-8 · sin jerga interna + sin patrones de secreto
//   CA-9 · sin texto de origen externo (se prueba con episodios hostiles)
//
// Uso:  node .pipeline/assets/copy/fallback-episode/validate-copy.js
// Exit: 0 copy válido · 1 copy inválido (lista los incumplimientos)
//
// Este archivo es el espejo ejecutable de `forbidden-copy-patterns.js` que el
// dev crea en `.pipeline/lib/__tests__/helpers/`. Si divergen, manda el helper
// del repo: acá vive el criterio de UX, allá vive el control de la suite.
// =============================================================================

'use strict';

const { formatEpisodeNotice, TIERS, CAUSAS, EVENTOS } = require('./render');

// --- Patrones prohibidos (CA-8) --------------------------------------------
const JERGA = [
    /skill=/i, /primary=/i, /fallback=/i, /\bgated\b/i, /índice/i, /\bindice\b/i,
    /deepseek|gpt-\d|claude-[a-z0-9-]+|gemini-|llama-/i,
    /anthropic|openai|codex|cerebras|nvidia|kimi|moonshot|groq/i,
    /quota_exhausted|rate_limit|errorCode|raw_excerpt|5xx/i,
    /\[object Object\]/, /function Object\(\)/,
];
const SECRETOS = [/sk-/, /Bearer /, /api[_-]?key/i, /AKIA/, /eyJ/];

// --- Acción pedida (CA-7): sólo válida si la causa la justifica -------------
// La negación explícita ("No hace falta que hagas nada") se descuenta antes de
// buscar el pedido de acción: es lo contrario de pedir algo.
const NEGACION_ACCION = /No hace falta que hagas nada\.?/gi;
const PIDE_ACCION = /hace falta que|conviene que lo mires|revises/i;
const pideAccion = (texto) => PIDE_ACCION.test(texto.replace(NEGACION_ACCION, ''));

const MAX_CHARS = 600;
const now = Date.UTC(2026, 7, 19, 17, 45, 0);
const HORA = 3600 * 1000;

const fallas = [];
const muestras = [];

function chequear(nombre, texto, { esperaAccion }) {
    const push = (m) => fallas.push(`${nombre}: ${m}`);

    for (const re of JERGA) if (re.test(texto)) push(`jerga/id prohibido ${re}`);
    for (const re of SECRETOS) if (re.test(texto)) push(`patrón de secreto ${re}`);
    if (texto.length > MAX_CHARS) push(`${texto.length} chars > ${MAX_CHARS}`);
    if (/[*_`\[\]]/.test(texto)) push('carácter de Markdown en copy plain');
    if (/\{[A-Z]+\}/.test(texto)) push('placeholder sin resolver');
    if (/undefined|null|NaN/.test(texto)) push('valor no formateado filtrado al texto');

    const pide = pideAccion(texto);
    if (pide && !esperaAccion) push('pide acción cuando no hay ninguna (CA-7)');
    if (!pide && esperaAccion) push('no pide la acción que sí existe (CA-7)');

    muestras.push({ nombre, texto });
}

// --- Matriz completa de degradación ----------------------------------------
for (const evento of EVENTOS.filter((e) => e !== 'vuelve_principal')) {
    for (const tier of TIERS) {
        for (const cause of CAUSAS) {
            const texto = formatEpisodeNotice(
                { evento, tier, cause, since: now - 3 * HORA - 12 * 60000, heartbeatMs: 6 * HORA },
                { now },
            );
            // El heartbeat nunca pide acción: su cierre explica la repetición.
            const esperaAccion = evento !== 'sostenido' && (cause === 'auth' || cause === 'desconocida');
            chequear(`${evento}/${tier}/${cause}`, texto, { esperaAccion });

            // CA-4: las cuatro preguntas, sobre el texto renderizado.
            if (!/^.{1,3}\s?\S/.test(texto)) fallas.push(`${evento}/${tier}/${cause}: sin titular`);
            if (!/\nMotivo: /.test(texto)) fallas.push(`${evento}/${tier}/${cause}: falta "por qué"`);
            if (!/\nDesde las \d{2}:\d{2} \(/.test(texto)) fallas.push(`${evento}/${tier}/${cause}: falta "desde cuándo"`);
            if (texto.split('\n').length !== 5) fallas.push(`${evento}/${tier}/${cause}: no tiene los 5 bloques`);
        }
    }
}

// --- Vuelta a la normalidad -------------------------------------------------
chequear(
    'vuelve_principal',
    formatEpisodeNotice({ evento: 'vuelve_principal', since: now - 4 * HORA }, { now }),
    { esperaAccion: false },
);

// --- Episodios hostiles (CA-5 / CA-9 / D8) ---------------------------------
const HOSTILES = [
    { evento: 'constructor', tier: '__proto__', cause: 'constructor', since: now - 60000 },
    { evento: 'entra_respaldo', tier: 'toString', cause: '__proto__', since: now - 60000 },
    { evento: 'entra_respaldo', tier: 'respaldo_pago', cause: 'sk-live-AKIA-eyJhbGciOi', since: now - 60000 },
    { evento: 'entra_respaldo', tier: 'respaldo_pago', cause: 'quota_exhausted en claude-opus-4', since: now - 60000 },
    {},
];
HOSTILES.forEach((ep, i) => {
    const texto = formatEpisodeNotice(ep, { now });
    // Los hostiles caen a `desconocida` ⇒ su cierre SÍ pide mirar.
    chequear(`hostil#${i}`, texto, { esperaAccion: true });
});

// --- Salida -----------------------------------------------------------------
const ancho = Math.max(...muestras.map((m) => m.nombre.length));
for (const m of muestras) {
    console.log(`${m.nombre.padEnd(ancho)} | ${String(m.texto.length).padStart(3)} chars`);
}
console.log('');
console.log('--- Muestras representativas ---');
for (const clave of [
    'entra_respaldo/respaldo_pago/cuota',
    'entra_respaldo/gratuito_con_herramientas/reposo',
    'baja_escalon/gratuito_sin_herramientas/cuota',
    'entra_respaldo/respaldo_pago/auth',
    'entra_respaldo/gratuito_con_herramientas/desconocida',
    'sostenido/gratuito_sin_herramientas/cuota',
    'vuelve_principal',
    'hostil#0',
]) {
    const m = muestras.find((x) => x.nombre === clave);
    if (m) console.log(`\n[${clave}]\n${m.texto}`);
}
console.log('');
if (fallas.length) {
    console.log(`RESULTADO: FALLA — ${fallas.length} incumplimiento(s)`);
    fallas.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
}
console.log(`RESULTADO: OK — ${muestras.length} variantes válidas, ninguna supera ${MAX_CHARS} chars`);
