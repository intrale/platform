// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

/**
 * #7635 (parte 2 de #7598) — EXCEPCIONES DECLARADAS AL ENTORNO MÍNIMO DE UN HIJO.
 *
 * Lee y valida `.pipeline/env-exceptions.yaml`. Cada entrada declara, con
 * fundamento, aprobador y fecha de revisión, una variable (o un scope) que un
 * rol puede recibir por fuera de su scope efectivo.
 *
 * Reglas (todas fail-closed — un archivo o una entrada dudosa NUNCA abre nada):
 *
 *   - SEC-1: la ruta sale de `__dirname` (la `lib/` que ejecuta el Pulpo, en el
 *     repo principal). Nunca de `process.cwd()` ni de una variable de entorno:
 *     un agente que edita el YAML en su worktree no se otorga nada sin merge.
 *     `opts.file` existe SÓLO para los tests.
 *   - SEC-4: `js-yaml` con `JSON_SCHEMA` (las fechas llegan como texto, no como
 *     `Date`), tope de 64 KB, claves duplicadas o raíz que no es lista ⇒ cero
 *     excepciones + `error`.
 *   - Entrada válida: `tipo` ∈ {agente, servicio}, `rol`, exactamente UNO de
 *     `scope` | `variable`, `fundamento` no vacío, `aprobador` que cumple
 *     `^@?[A-Za-z0-9-]{1,39}$`, `revisar_el` ISO real y a no más de 180 días
 *     (SEC-3). Claves desconocidas ⇒ descartada (un typo no se lee como válido).
 *   - SEC-6: una entrada que resuelve a un nombre reservado (AWS, GitHub, keys de
 *     providers, Telegram) se descarta EN LA CARGA.
 *   - `revisar_el >= hoy` ⇒ vigente; `< hoy` ⇒ vencida. "Hoy" en zona fija
 *     `America/Argentina/Buenos_Aires`.
 *   - SEC-7: `forAgent` sólo mira `tipo: agente`; `forService` sólo `tipo:
 *     servicio`. Un skill que se llame igual que un servicio no hereda nada.
 *   - SEC-5: el `fundamento` nunca sale de este módulo hacia errores ni logs:
 *     `vencidas` y `descartadas` sólo llevan nombre, fecha, aprobador y un
 *     motivo de un enum cerrado.
 *
 * Módulo HOJA: no importa `build-child-env.js` (lee los scopes del JSON de
 * datos) y NUNCA tira: cualquier falla vuelve como `error` con cero vigentes.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILE = path.join(__dirname, '..', 'env-exceptions.yaml');
const SCOPES_FILE = path.join(__dirname, 'child-env-scopes.json');

const MAX_BYTES = 64 * 1024;
const MAX_DIAS = 180;
const TZ = 'America/Argentina/Buenos_Aires';
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const APROBADOR = /^@?[A-Za-z0-9-]{1,39}$/;
const ROL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const TIPOS = Object.freeze(['agente', 'servicio']);
const CLAVES = Object.freeze(['tipo', 'rol', 'scope', 'variable', 'fundamento', 'aprobador', 'revisar_el']);

// Piso propio de reservadas (defensa en profundidad: aunque el caller no pase
// `reservedNames`, ninguna excepción da AWS, GitHub, keys de providers ni Telegram).
const RESERVADAS_BASE = Object.freeze([
    'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_PROFILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
    'TELEGRAM_BOT_TOKEN',
]);

/** Motivos de descarte: enum cerrado (nunca texto del YAML). */
const MOTIVOS_DESCARTE = Object.freeze({
    NO_OBJETO: 'no-es-objeto',
    CLAVE_DESCONOCIDA: 'clave-desconocida',
    TIPO: 'tipo-invalido',
    ROL: 'rol-invalido',
    SCOPE_Y_VARIABLE: 'scope-y-variable',
    SIN_SCOPE_NI_VARIABLE: 'sin-scope-ni-variable',
    SCOPE: 'scope-desconocido',
    VARIABLE: 'variable-invalida',
    RESERVADA: 'otorga-reservada',
    FUNDAMENTO: 'sin-fundamento',
    APROBADOR: 'aprobador-invalido',
    FECHA: 'fecha-invalida',
    HORIZONTE: 'fecha-mas-de-180-dias',
});

function hoyISO(now) {
    const d = (now instanceof Date) ? now : new Date(now === undefined ? Date.now() : now);
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

function fechaValida(s) {
    if (typeof s !== 'string' || !ISO.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // descarta 2026-02-30
}

function sumarDias(iso, dias) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
}

function leerScopes(fsImpl) {
    const raw = fsImpl.readFileSync(SCOPES_FILE, 'utf8');
    const data = JSON.parse(raw);
    const cs = data && data.CREDENTIAL_SCOPES;
    if (!cs || typeof cs !== 'object') throw new Error('CREDENTIAL_SCOPES ausente');
    return cs;
}

function vacio(error) {
    return { vigentes: [], vencidas: [], descartadas: [], error };
}

/**
 * Valida una entrada. Devuelve `{ ok: true, entrada }` o `{ ok: false, motivo }`.
 * La entrada normalizada lleva `nombres` (variables que otorga).
 */
function validarEntrada(e, { scopes, reservadas, hoy, limite }) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, motivo: MOTIVOS_DESCARTE.NO_OBJETO };
    for (const k of Object.keys(e)) {
        if (!CLAVES.includes(k)) return { ok: false, motivo: MOTIVOS_DESCARTE.CLAVE_DESCONOCIDA };
    }
    if (!TIPOS.includes(e.tipo)) return { ok: false, motivo: MOTIVOS_DESCARTE.TIPO };
    if (typeof e.rol !== 'string' || !ROL.test(e.rol)) return { ok: false, motivo: MOTIVOS_DESCARTE.ROL };

    const tieneScope = e.scope !== undefined && e.scope !== null;
    const tieneVariable = e.variable !== undefined && e.variable !== null;
    if (tieneScope && tieneVariable) return { ok: false, motivo: MOTIVOS_DESCARTE.SCOPE_Y_VARIABLE };
    if (!tieneScope && !tieneVariable) return { ok: false, motivo: MOTIVOS_DESCARTE.SIN_SCOPE_NI_VARIABLE };

    let nombres;
    if (tieneScope) {
        if (typeof e.scope !== 'string' || !Object.prototype.hasOwnProperty.call(scopes, e.scope)
            || !Array.isArray(scopes[e.scope])) {
            return { ok: false, motivo: MOTIVOS_DESCARTE.SCOPE };
        }
        nombres = scopes[e.scope].map(String);
    } else {
        if (typeof e.variable !== 'string' || !VARIABLE.test(e.variable)) {
            return { ok: false, motivo: MOTIVOS_DESCARTE.VARIABLE };
        }
        nombres = [e.variable];
    }
    if (nombres.some((n) => reservadas.has(n.toUpperCase()))) {
        return { ok: false, motivo: MOTIVOS_DESCARTE.RESERVADA };
    }

    if (typeof e.fundamento !== 'string' || e.fundamento.trim() === '') {
        return { ok: false, motivo: MOTIVOS_DESCARTE.FUNDAMENTO };
    }
    if (typeof e.aprobador !== 'string' || !APROBADOR.test(e.aprobador)) {
        return { ok: false, motivo: MOTIVOS_DESCARTE.APROBADOR };
    }
    // Con JSON_SCHEMA la fecha llega como texto; un `Date` (u otro tipo) se descarta.
    if (!fechaValida(e.revisar_el)) return { ok: false, motivo: MOTIVOS_DESCARTE.FECHA };
    if (e.revisar_el > limite) return { ok: false, motivo: MOTIVOS_DESCARTE.HORIZONTE };

    const aprobador = e.aprobador.startsWith('@') ? e.aprobador : '@' + e.aprobador;
    return {
        ok: true,
        vigente: e.revisar_el >= hoy,
        entrada: Object.freeze({
            tipo: e.tipo,
            rol: e.rol,
            scope: tieneScope ? e.scope : null,
            variable: tieneVariable ? e.variable : null,
            nombres: Object.freeze(nombres),
            aprobador,
            revisar_el: e.revisar_el,
            // `fundamento` se conserva sólo para el inventario (test CA-7); NO
            // se copia a `vencidas` ni a los errores (SEC-5).
            fundamento: e.fundamento,
        }),
    };
}

/**
 * Carga y valida el YAML de excepciones. Nunca tira.
 *
 * @param {{ now?: Date|number, file?: string, reservedNames?: string[], fsImpl?: object }} [opts]
 *   `file` sólo para tests (SEC-1): en producción se usa siempre `DEFAULT_FILE`.
 * @returns {{ vigentes: object[], vencidas: object[], descartadas: {indice:number, motivo:string}[], error: string|null }}
 */
function loadExceptions(opts = {}) {
    const { now, file = DEFAULT_FILE, reservedNames = [], fsImpl = fs } = opts;
    try {
        let raw;
        try {
            if (!fsImpl.existsSync(file)) return vacio('archivo de excepciones ausente');
            raw = fsImpl.readFileSync(file);
        } catch {
            return vacio('archivo de excepciones ilegible');
        }
        const bytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw), 'utf8');
        if (bytes > MAX_BYTES) return vacio(`archivo de excepciones supera ${MAX_BYTES} bytes`);

        let yaml;
        try {
            yaml = require('js-yaml');
        } catch {
            return vacio('parser YAML no disponible');
        }
        let doc;
        try {
            // JSON_SCHEMA: sin Date ni tipos implícitos; claves duplicadas tiran.
            doc = yaml.load(String(raw), { schema: yaml.JSON_SCHEMA });
        } catch {
            return vacio('YAML de excepciones ilegible');
        }
        if (!Array.isArray(doc)) return vacio('la raíz del YAML de excepciones no es una lista');

        let scopes;
        try {
            // La tabla de scopes es interna a `lib/`: siempre del disco real.
            scopes = leerScopes(fs);
        } catch {
            return vacio('tabla de scopes ilegible');
        }
        const reservadas = new Set([...RESERVADAS_BASE, ...(Array.isArray(reservedNames) ? reservedNames : [])]
            .map((n) => String(n).toUpperCase()));
        const hoy = hoyISO(now);
        const limite = sumarDias(hoy, MAX_DIAS);

        const vigentes = [];
        const vencidas = [];
        const descartadas = [];
        doc.forEach((e, indice) => {
            const r = validarEntrada(e, { scopes, reservadas, hoy, limite });
            if (!r.ok) {
                descartadas.push(Object.freeze({ indice, motivo: r.motivo }));
            } else if (r.vigente) {
                vigentes.push(r.entrada);
            } else {
                vencidas.push(r.entrada);
            }
        });
        return { vigentes, vencidas, descartadas, error: null };
    } catch {
        return vacio('error inesperado al cargar excepciones');
    }
}

/**
 * Excepciones de un AGENTE (skill). Sólo `tipo: agente` y `rol === skill` (SEC-7).
 * @returns {{ nombres: string[], vencidas: {nombre:string, revisar_el:string, aprobador:string}[], error: string|null }}
 */
function forAgent(skill, opts = {}) {
    const r = loadExceptions(opts);
    const propias = (e) => e.tipo === 'agente' && typeof skill === 'string' && e.rol === skill;
    const nombres = new Set();
    for (const e of r.vigentes.filter(propias)) for (const n of e.nombres) nombres.add(n);
    const vencidas = [];
    for (const e of r.vencidas.filter(propias)) {
        for (const n of e.nombres) vencidas.push(Object.freeze({ nombre: n, revisar_el: e.revisar_el, aprobador: e.aprobador }));
    }
    return { nombres: [...nombres], vencidas, error: r.error };
}

/**
 * Excepciones de un SERVICIO de confianza (declarativas hasta #7636).
 * Sólo `tipo: servicio` (SEC-7).
 */
function forService(nombre, opts = {}) {
    const r = loadExceptions(opts);
    const propias = (e) => e.tipo === 'servicio' && e.rol === nombre;
    return {
        vigentes: r.vigentes.filter(propias).map((e) => ({ rol: e.rol, nombres: e.nombres, revisar_el: e.revisar_el, aprobador: e.aprobador })),
        vencidas: r.vencidas.filter(propias).map((e) => ({ rol: e.rol, nombres: e.nombres, revisar_el: e.revisar_el, aprobador: e.aprobador })),
        error: r.error,
    };
}

module.exports = {
    loadExceptions,
    forAgent,
    forService,
    hoyISO,
    fechaValida,
    DEFAULT_FILE,
    MAX_BYTES,
    MAX_DIAS,
    TZ,
    MOTIVOS_DESCARTE,
    RESERVADAS_BASE,
};
