// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// propuestas-registry.js — Registro único de propuestas al operador.
// Parte 2/3 del split de #6807 (#7515): contrato + publicación.
//
// QUÉ HACE: recibe propuestas de los productores del pipeline (enum cerrado
// `PRODUCTORES`), las valida contra `contracts/propuesta.schema.json`, las
// canonicaliza, las redacta y las persiste bajo la clave `propuestas` del
// estado operativo (`operational-state-backend`, habilitada en #7514) con:
//
//   - id derivado por hash canónico (`claveDedup`) sobre `CAMPOS_HASH` — el
//     productor NUNCA elige el id ni el estado (S2/S3 de #6807);
//   - rechazo por inyección (`handoff.detectInjection`), por schema (Ajv sin
//     `verbose`, `strict:true`), por evidencia ausente y por procedencia
//     (sólo `recomendacion-agente`, desde `ctx`, nunca desde el payload —
//     SEC-7515-1);
//   - redacción de secretos ANTES de medir los caps de bytes y ANTES del hash
//     (SEC-7515-7): republicar el mismo payload da el mismo id y un secreto en
//     `accion` no participa del hash;
//   - dedup por contenido contra `vivas` y contra `memoria` (rechazadas no
//     reinciden, S6), cuota diaria por productor (día UTC, `vivas`+`memoria`)
//     y tope de vivas (`max_vivas`, cotado por `MAX_PROPUESTAS_VIVAS`).
//
// QUÉ NO HACE: no decide (`decidir()` es la parte 3, #7516), no habla con el
// operador (cero `gh`, cero red, cero Telegram: `backend.setDegradationSink`
// ya emite la alerta de store degradado), no siembra archivo (`leer()` devuelve
// `VACIO()` en memoria cuando no hay registro: ningún `ensure*File`), y no
// escribe por fuera de `backend.writeKey` (cero escritura directa a disco).
//
// SUSTRATO (guru §3 / SEC-J): en modo filesystem `writeKey` NO hace CAS, NO
// valida y NO redacta. Por eso el ciclo `leer → evaluar → escribir` corre
// entero dentro de `withLockSync(backend.fileFor(KEYS.PROPUESTAS))` (excluye
// entre procesos del mismo host) y se llama `validateRemoteValue` antes de
// escribir en AMBOS modos. El reintento por `conflict` (máx. 3) se conserva
// para el modo durable, donde el CAS sí compara y el lock no excluye entre
// hosts. Ambos mecanismos coexisten, igual que en `partial-pause.js`.
//
// LOGS (SEC-7515-5): nunca sale texto del payload por `console`. Se loguea
// productor + motivo + patrón matcheado / campo señalado, nada más.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('path');
const crypto = require('crypto');

const backend = require('./operational-state-backend');
const { withLockSync } = require('./file-lock');
const { detectInjection } = require('./handoff');
const { redactObject } = require('./redact');
const auditLog = require('./audit-log');
const { canonicalJsonStringify } = auditLog;
const { stateDir } = require('./project-context');

const MODULO = 'propuestas-registry';
const SCHEMA_FILE = path.join(__dirname, '..', 'contracts', 'propuesta.schema.json');

// ─── Enums (un solo lugar, cerrados) ────────────────────────────────────────

/** Productores habilitados (CA-2 de #6807). El valor sale del ctx / PIPELINE_SKILL. */
const PRODUCTORES = Object.freeze([
    'recomendacion-agente',
    'auditor-modelos',
    'digest-bloqueos',
    'digest-desempates',
    'commander-proactivo',
    // #6809 — auditor del modelo operativo (lib/process-audit/): sugerencias del
    // proceso a partir de la telemetría. Publica sólo por acá (D3 / SEC-6809-4).
    'auditor-proceso',
]);

const TIPOS = Object.freeze([
    'mejora-de-proceso',
    'cambio-de-configuracion',
    'correccion',
    'riesgo',
    'ticket-nuevo',
]);

/** Sin `postergada` (ajuste del operador 01/09/2026 en #6807). */
const ESTADOS = Object.freeze(['pendiente', 'aceptada', 'aceptada-con-agregado', 'rechazada']);

/**
 * Transiciones que admite `decidir()` (parte 3, #7516). Alineadas con #6810:
 * son estas tres y NO existe `postergar` (ajuste del operador en #6807).
 */
const DECISIONES = Object.freeze(['aceptar', 'aceptar-con-agregado', 'rechazar']);

/** Superficies por las que el operador puede decidir. Valores, no presentación. */
const CANALES = Object.freeze(['telegram', 'dashboard', 'cli']);

/**
 * Identidades del decisor (NO roles del pipeline). Es un enum CERRADO y
 * AUTODECLARADO por el caller: el registro no autentica a nadie. Autenticar al
 * operador es obligación del caller (#6810) — mismo reparto que
 * `partial-pause-audit.js`, donde el gate real es `requireAuthorization()`
 * aguas arriba. Lo que el registro sí garantiza es que cada entry del log
 * lleve `actor_proceso`, que el caller no puede falsificar (SEC-7516-4).
 */
const AUTHORIZED_BY = Object.freeze(['operador:telegram', 'operador:dashboard', 'operador:cli']);

/** Transición → estado persistido en `memoria`. */
const ESTADO_FINAL_DE = Object.freeze({
    aceptar: 'aceptada',
    'aceptar-con-agregado': 'aceptada-con-agregado',
    rechazar: 'rechazada',
});

const MOTIVOS_RECHAZO = Object.freeze([
    'productor_desconocido',
    'productor_no_coincide',
    'inyeccion_detectada',
    'evidencia_requerida',
    'schema_invalido',
    'procedencia_invalida',
    'rechazada_previamente',
    'ya_decidida',
    'cuota_excedida',
    'registro_lleno',
    'store_degradado',
    'escritura_rechazada',
    // — propios de `decidir()` (#7516). `ya_decidida`, `inyeccion_detectada`,
    //   `store_degradado` y `escritura_rechazada` se reutilizan tal cual.
    'decision_invalida',
    'authorized_by_invalido',
    'canal_invalido',
    'agregado_requerido',
    'propuesta_inexistente',
    'id_invalido',
    'decision_no_aplicada',
]);

/**
 * Campos que entran al hash del `id` (CA-8 / S6). Es una constante exportada
 * para que el test negativo cambie uno por uno los campos EXCLUIDOS (`titulo`,
 * `evidencia.resumen`, `beneficio`, `costo`, `riesgo`, timestamps) y exija el
 * mismo id. El hash se calcula sobre el payload YA canonicalizado y redactado
 * (SEC-7515-7): `accion` va normalizada (trim + lowercase + espacios
 * colapsados) y un `[REDACTED]` en ella participa como tal.
 */
const CAMPOS_HASH = Object.freeze(['productor', 'tipo', 'accion', 'evidencia.tipo', 'evidencia.referencia']);

const SCHEMA_VERSION = 1;
const ID_HEX_LEN = 24;
/** Forma del `id` que acepta `decidir()`, coherente con `ID_HEX_LEN` (SEC-7516-5). */
const RE_ID = new RegExp(`^[0-9a-f]{${ID_HEX_LEN}}$`);
/** Claves admitidas en el argumento de `decidir()` (allowlist, no denylist). */
const CLAVES_DECIDIR = new Set(['id', 'decision', 'authorizedBy', 'canal', 'agregado']);
/** Nombre del archivo del log encadenado de decisiones. */
const LOG_DECISIONES = 'propuestas-decisiones.jsonl';

// Caps (SEC-B / SEC-7515-4). El crudo se mide ANTES de cualquier regex.
const MAX_BYTES_CRUDO = 64 * 1024;
// SEC-7515-V1: claves que jamás se aceptan en ningún nivel del payload. Una
// clave PROPIA `__proto__` (lo que produce `JSON.parse('{"__proto__":{…}}')`)
// convertiría la copia canónica en un objeto con prototipo controlado por el
// productor, y Ajv (`for…in`) daría por cumplidos `required` y
// `additionalProperties` leyendo campos HEREDADOS que `Object.keys` no ve.
const CLAVES_PROHIBIDAS = new Set(['__proto__', 'constructor', 'prototype']);
// SEC-7515-V2: forma admitida para que un NOMBRE de clave del payload aparezca
// en un log o en `detalle`. Fuera de esta forma se reemplaza por un marcador:
// los nombres de clave son contenido no confiable (no pasan por textosDe, no
// se redactan, no tienen tope propio) y no pueden salir crudos por `console`.
const RE_CLAVE_LOGUEABLE = /^[a-z0-9_.-]{1,64}$/;
const CLAVE_NO_ADMITIDA = '(clave no admitida)';
const MAX_CHARS_DETALLE = 256;
const MAX_BYTES_POR_STRING = 2048;
const MAX_BYTES_PAYLOAD = 8192;

const DEFAULT_CUOTA_DIARIA = 50;
const DEFAULT_MAX_VIVAS = 500;

const ASOCIACIONES_CONFIABLES = Object.freeze(['OWNER', 'MEMBER']);

const LOCK_TIMEOUT_MS = 5000;
const LOCK_MAX_RETRIES = 3;
const MAX_REINTENTOS_CONFLICT = 3;

// ─── Estado de proceso NO crítico (sólo rate-limit de logs) ─────────────────
// `cuota_excedida` se loguea una vez por productor/día. Es memoria de proceso
// a propósito: perderla en un restart sólo repite un log, no altera el registro.
const cuotaLogueada = new Set();

// ─── Schema (Ajv compilado lazy, una sola vez) ──────────────────────────────
let validador = null;
function validadorSchema() {
    if (validador) return validador;
    // eslint-disable-next-line global-require
    const Ajv = require('ajv');
    // SEC-7515-3: sin `verbose` (los errores no llevan `data`), `strict:true`.
    // SEC-7515-V1 (c): `ownProperties` para que `required` y
    // `additionalProperties` sólo consideren propiedades PROPIAS del dato.
    const ajv = new Ajv({ allErrors: true, verbose: false, strict: true, ownProperties: true });
    // eslint-disable-next-line global-require
    const schema = require(SCHEMA_FILE);
    validador = ajv.compile(schema);
    return validador;
}

/**
 * Texto de error de Ajv que señala CAMPO + REGLA (UX-4) sin volcar datos
 * (SEC-7515-3). `errorsText()` no nombra la propiedad sobrante en
 * `additionalProperties`; acá se agrega desde `params` (es un nombre de clave
 * del payload, no un valor).
 */
function formatearErroresAjv(errors) {
    if (!Array.isArray(errors) || errors.length === 0) return 'schema inválido';
    const texto = errors.map((e) => {
        const donde = e.instancePath ? `data${e.instancePath}` : 'data';
        // SEC-7515-V2: el nombre de la propiedad sobrante viene del payload y
        // no está canonicalizado ni redactado ni acotado: sólo se muestra si
        // tiene forma de identificador; si no, un marcador fijo.
        let extra = '';
        if (e.params && typeof e.params.additionalProperty === 'string') {
            const clave = claveLogueable(e.params.additionalProperty);
            extra = clave === CLAVE_NO_ADMITIDA ? ` ${clave}` : ` (${clave})`;
        }
        return `${donde} ${e.message}${extra}`;
    }).join('; ');
    return acotarDetalle(texto);
}

/**
 * Nombre de clave apto para log/`detalle` (SEC-7515-V2): se devuelve tal cual
 * sólo si cumple `RE_CLAVE_LOGUEABLE`; en cualquier otro caso, el marcador.
 * @param {any} k
 * @returns {string}
 */
function claveLogueable(k) {
    return (typeof k === 'string' && RE_CLAVE_LOGUEABLE.test(k)) ? k : CLAVE_NO_ADMITIDA;
}

/**
 * Tope duro para cualquier `detalle` que salga por `console.warn` o por el
 * resultado (SEC-7515-V2): nunca más de `MAX_CHARS_DETALLE` chars.
 * @param {string} texto
 * @returns {string}
 */
function acotarDetalle(texto) {
    const t = String(texto);
    return t.length > MAX_CHARS_DETALLE ? `${t.slice(0, MAX_CHARS_DETALLE - 1)}…` : t;
}

/**
 * Busca alguna clave prohibida (`CLAVES_PROHIBIDAS`) en cualquier nivel del
 * valor (SEC-7515-V1 (a)). PURA. Se recorre con `Object.keys`, que SÍ ve la
 * propiedad propia `__proto__` que produce `JSON.parse`. Se llama después del
 * pre-cap de 64 KB, así que el recorrido está acotado; y como el payload ya
 * pasó `JSON.stringify`, no hay ciclos.
 * @param {any} valor
 * @returns {boolean} true si hay alguna clave prohibida
 */
function tieneClaveProhibida(valor) {
    if (Array.isArray(valor)) return valor.some(tieneClaveProhibida);
    if (!valor || typeof valor !== 'object') return false;
    for (const k of Object.keys(valor)) {
        if (CLAVES_PROHIBIDAS.has(k)) return true;
        if (tieneClaveProhibida(valor[k])) return true;
    }
    return false;
}

// ─── Puras: canonicalización, textos, sensible, hash ────────────────────────

// Caracteres de formato (Cf: ZWSP, ZWJ, BOM, marcas bidi…) y de control (Cc),
// salvo `\n`. Se aplican DESPUÉS de NFKC para que un homoglifo compatible
// (fullwidth, ligaduras) colapse al ASCII antes de que se mida nada.
const RE_CF = /\p{Cf}/gu;
const RE_CC_SALVO_NL_TAB = /(?![\n\t])\p{Cc}/gu;   // `\t` se conserva: es espacio, no control
const RE_ESPACIOS_H = /[^\S\n]+/g;

/**
 * Canonicaliza UN string (SEC-7515-2): NFKC, strip de `\p{Cf}` y controles
 * (salvo `\n`), colapso de espacios horizontales, trim por línea y global.
 * Con `cfComoEspacio` los Cf se vuelven espacio en vez de desaparecer: es la
 * variante que se usa SÓLO para detección de inyección, porque un ZWSP puesto
 * en lugar del espacio ("ignore​previous") tiene que seguir matcheando
 * `\bignore\s+previous`.
 * @param {string} s
 * @param {{cfComoEspacio?: boolean}} [opts]
 * @returns {string}
 */
function canonicalizarTexto(s, opts) {
    if (typeof s !== 'string') return s;
    let out = s.normalize('NFKC');
    out = out.replace(RE_CF, (opts && opts.cfComoEspacio) ? ' ' : '');
    out = out.replace(RE_CC_SALVO_NL_TAB, '');
    out = out.replace(RE_ESPACIOS_H, ' ');
    out = out.split('\n').map((l) => l.trim()).join('\n').trim();
    return out;
}

/**
 * Canonicaliza un payload entero (PURA: devuelve copia, no muta). Recorre
 * objetos y arrays; los strings pasan por `canonicalizarTexto`; el resto de
 * los escalares queda igual. Las claves NO se tocan.
 * @param {any} valor
 * @param {{cfComoEspacio?: boolean}} [opts]
 * @returns {any}
 */
function canonicalizar(valor, opts) {
    if (typeof valor === 'string') return canonicalizarTexto(valor, opts);
    if (Array.isArray(valor)) return valor.map((v) => canonicalizar(v, opts));
    if (valor && typeof valor === 'object') {
        const out = {};
        for (const k of Object.keys(valor)) {
            // SEC-7515-V1 (b): `out['__proto__'] = x` cambiaría el PROTOTIPO de la
            // copia, no una propiedad propia. Se salta acá aunque el paso 0 de
            // `publicar` ya rechace estas claves: la copia jamás cambia de prototipo.
            if (CLAVES_PROHIBIDAS.has(k)) continue;
            out[k] = canonicalizar(valor[k], opts);
        }
        return out;
    }
    return valor;
}

/**
 * Todos los strings de un payload con su path punteado (PURA).
 * @param {any} valor
 * @returns {Array<{path: string, texto: string}>}
 */
function textosDe(valor) {
    const out = [];
    const visitar = (v, p) => {
        if (typeof v === 'string') { out.push({ path: p, texto: v }); return; }
        if (Array.isArray(v)) { v.forEach((x, i) => visitar(x, `${p}[${i}]`)); return; }
        if (v && typeof v === 'object') {
            // SEC-7515-V2: el `path` sale por log (`campo=`) y por `detalle`,
            // así que cada segmento pasa por `claveLogueable`.
            for (const k of Object.keys(v)) {
                const seg = claveLogueable(k);
                visitar(v[k], p ? `${p}.${seg}` : seg);
            }
        }
    };
    visitar(valor, '');
    return out;
}

/**
 * `sensible = true` si `tipo === 'riesgo'` o (`productor === 'recomendacion-agente'`
 * y `agente === 'security'`). Nunca la rebaja (CA-5 / S5). PURA: devuelve
 * `{ payload, corregido }` con copia.
 * @param {object} payload
 * @param {string} productor
 */
function forzarSensible(payload, productor) {
    const debeSerSensible = payload.tipo === 'riesgo'
        || (productor === 'recomendacion-agente' && payload.agente === 'security');
    if (!debeSerSensible || payload.sensible === true) return { payload, corregido: false };
    return { payload: { ...payload, sensible: true }, corregido: true };
}

/** Normalización de `accion` para el hash: lowercase + todo espacio colapsado. */
function normalizarAccion(s) {
    return canonicalizarTexto(String(s == null ? '' : s)).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Clave de dedup / id: sha256 hex truncado a 24 sobre el JSON canónico
 * (claves ordenadas) de `CAMPOS_HASH`. Excluye `titulo`, `evidencia.resumen`,
 * `beneficio`, `costo`, `riesgo` y timestamps. PURA.
 * @param {object} payloadCanonico  payload YA canonicalizado y redactado
 * @param {string} productor
 * @returns {string}
 */
function claveDedup(payloadCanonico, productor) {
    const ev = (payloadCanonico && payloadCanonico.evidencia) || {};
    const base = {
        productor: String(productor == null ? '' : productor),
        tipo: String(payloadCanonico.tipo == null ? '' : payloadCanonico.tipo),
        accion: normalizarAccion(payloadCanonico.accion),
        evidencia_tipo: canonicalizarTexto(String(ev.tipo == null ? '' : ev.tipo)),
        evidencia_referencia: canonicalizarTexto(String(ev.referencia == null ? '' : ev.referencia)),
    };
    return crypto.createHash('sha256')
        .update(canonicalJsonStringify(base), 'utf8')
        .digest('hex')
        .slice(0, ID_HEX_LEN);
}

// ─── Config ─────────────────────────────────────────────────────────────────

function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

/**
 * Sección `propuestas` de la config efectiva, con defaults. `ctx.config`
 * (inyección por firma, tests) cortocircuita la lectura y acepta DOS formas,
 * a propósito: la config entera (`{ propuestas: {...} }`, lo que devuelve
 * `config-resolver`) o la sección sola (`{ cuota_diaria_por_productor, ... }`).
 * Si trae `propuestas`, gana esa clave; si no, el objeto se toma como sección.
 * Config ausente o ilegible ⇒ defaults: cuota/tope sanos y allowlist VACÍA
 * (fail-closed para `recomendacion-agente`: nadie entra desde un repo público
 * sin allowlist). `max_vivas` se cota por `MAX_PROPUESTAS_VIVAS` (CA-PO-4).
 * Se resuelve UNA vez por `publicar()` (antes del paso 6) y el mismo objeto
 * alimenta procedencia, cuota y tope en todos los reintentos del ciclo.
 */
function configPropuestas(ctx) {
    let seccion = null;
    if (ctx && ctx.config && typeof ctx.config === 'object') {
        seccion = ctx.config.propuestas || ctx.config;
    } else {
        try {
            // eslint-disable-next-line global-require
            const doc = require('./config-resolver').resolve({ pipelineDir: pipelineDir() });
            seccion = doc && doc.propuestas;
        } catch (err) {
            seccion = null;
            // Ausencia (tmpdir de tests, pre-cutover) es silenciosa; un YAML
            // ILEGIBLE sí se loguea: los defaults son sanos pero no son la config.
            if (!(err && err.causa === 'ENOENT')) {
                console.warn(`[${MODULO}] config ilegible, se usan defaults (${(err && err.name) || 'Error'})`);
            }
        }
    }
    seccion = (seccion && typeof seccion === 'object') ? seccion : {};
    const entero = (v, d) => (Number.isInteger(v) && v >= 1) ? v : d;
    const autores = Array.isArray(seccion.autores_permitidos)
        ? seccion.autores_permitidos.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim())
        : [];
    return {
        cuota_diaria_por_productor: entero(seccion.cuota_diaria_por_productor, DEFAULT_CUOTA_DIARIA),
        max_vivas: Math.min(entero(seccion.max_vivas, DEFAULT_MAX_VIVAS), backend.MAX_PROPUESTAS_VIVAS),
        autores_permitidos: autores,
    };
}

// ─── Store: leer / escribir (única salida) ──────────────────────────────────

function VACIO() {
    return { meta: { schema_version: SCHEMA_VERSION, updated_at: null }, vivas: [], memoria: [] };
}

/**
 * Lee el registro. Mismo criterio que `partial-pause.js` (D-1 de #5113):
 * `error` degrada IGUAL que `degraded` (en FS el fallo viaja por `error`).
 * `value === null` ⇒ `VACIO()` en memoria; NUNCA se siembra archivo.
 *
 * Registro inexistente ⇒ `version: 0` (create-once), igual que
 * `partial-pause.js`: en modo durable `writeKey` rechaza `expectedVersion`
 * null/undefined (CA-A4) y `0` es la condición `attribute_not_exists` que da
 * un único ganador en la creación. Con `null` la primera `publicar()` fallaba
 * SIEMPRE con `escritura_rechazada` y el registro nunca se creaba (rev-2).
 * En modo FS el sustrato ignora `expectedVersion`, así que `0` es inocuo.
 * @returns {{ok:true, value:object, version:number|string|null}|{ok:false, motivo:string, error:Error|null}}
 */
function leer() {
    let res;
    try {
        res = backend.readKeyWithVersion(backend.KEYS.PROPUESTAS);
    } catch (err) {
        return { ok: false, motivo: 'store_degradado', error: err };
    }
    if (!res || res.degraded || res.error) {
        return { ok: false, motivo: 'store_degradado', error: (res && res.error) || null };
    }
    const v = res.value;
    if (v === null || v === undefined) return { ok: true, value: VACIO(), version: 0 };
    if (typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.vivas) || !Array.isArray(v.memoria)) {
        return { ok: false, motivo: 'store_degradado', error: new Error('registro con forma inválida') };
    }
    const value = {
        meta: { schema_version: SCHEMA_VERSION, ...(v.meta && typeof v.meta === 'object' ? v.meta : {}) },
        vivas: v.vivas,
        memoria: v.memoria,
    };
    return { ok: true, value, version: res.version };
}

/**
 * Única salida al store. Sella `meta.updated_at` (sin eso `isoVersionOf`
 * devuelve `null`) y valida la forma con `validateRemoteValue` en AMBOS modos
 * (SEC-J: en FS el sustrato no lo hace).
 */
function escribir(value, expectedVersion) {
    value.meta = { ...(value.meta || {}), schema_version: SCHEMA_VERSION, updated_at: new Date().toISOString() };
    const check = backend.validateRemoteValue(backend.KEYS.PROPUESTAS, value);
    if (!check.ok) return { ok: false, error: new Error(`forma inválida: ${check.reason}`) };
    try {
        return backend.writeKey(backend.KEYS.PROPUESTAS, value, expectedVersion);
    } catch (err) {
        return { ok: false, error: err };
    }
}

// ─── Helpers de publicar ────────────────────────────────────────────────────

function rechazo(motivo, detalle, extra) {
    return { ok: false, motivo, detalle: detalle || null, ...(extra || {}) };
}

function resolverProductor(ctx) {
    const declarado = ctx && typeof ctx.productor === 'string' ? ctx.productor.trim() : '';
    if (declarado) return PRODUCTORES.includes(declarado) ? declarado : null;
    const skill = String(process.env.PIPELINE_SKILL || '').trim();
    return PRODUCTORES.includes(skill) ? skill : null;
}

function bytesDe(s) { return Buffer.byteLength(s, 'utf8'); }

function diaUtc(iso) {
    if (typeof iso !== 'string' || iso.length < 10) return null;
    return iso.slice(0, 10);
}

/** Entradas de `vivas` + `memoria` del productor creadas el mismo día UTC. */
function contarDelDia(value, productor, hoy) {
    let n = 0;
    for (const v of value.vivas) if (v && v.productor === productor && diaUtc(v.creada_en) === hoy) n++;
    for (const m of value.memoria) if (m && m.productor === productor && diaUtc(m.creada_en) === hoy) n++;
    return n;
}

function buscarEnMemoria(memoria, id) {
    return memoria.find((m) => m && (m.id === id || m.clave_dedup === id)) || null;
}

function copiar(o) { return JSON.parse(JSON.stringify(o)); }

// ─── API pública ────────────────────────────────────────────────────────────

/**
 * Publica una propuesta. Cada paso corta con `{ ok:false, motivo, detalle }`
 * y NO escribe. Orden (ver cabecera del archivo y body de #7515):
 *   0. forma básica + pre-cap de 64 KB crudo (SEC-7515-4) + clave_prohibida
 *      (`__proto__`|`constructor`|`prototype` en cualquier nivel, SEC-7515-V1)
 *   1. productor desde ctx / PIPELINE_SKILL (enum cerrado); `payload.productor`
 *      distinto ⇒ productor_no_coincide. `payload.procedencia` ⇒ procedencia_invalida
 *   2. canonicalizar + detectInjection ⇒ inyeccion_detectada
 *   3. evidencia_requerida; Ajv ⇒ schema_invalido
 *   4. redactar; caps 2048/8192 ⇒ schema_invalido
 *   5. forzarSensible (corrige, no rechaza)
 *   6. procedencia (sólo recomendacion-agente, desde ctx) ⇒ procedencia_invalida
 *   7. id = claveDedup(redactado)
 *   8-10. bajo lock: dedup vivas/memoria, cuota, tope, push + escribir (retry conflict ≤3)
 *
 * @param {object} payload
 * @param {{productor?: string, procedencia?: {author?: string, autor?: string, authorAssociation?: string}, config?: object, ahora?: string}} [ctx]
 * @returns {object}
 */
function publicar(payload, ctx) {
    ctx = ctx || {};

    // 0 — forma y pre-cap crudo, antes de correr un solo regex.
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return rechazo('schema_invalido', 'el payload debe ser un objeto');
    }
    let crudo;
    try {
        crudo = JSON.stringify(payload);
    } catch (err) {
        return rechazo('schema_invalido', 'payload no serializable');
    }
    if (typeof crudo !== 'string' || bytesDe(crudo) > MAX_BYTES_CRUDO) {
        return rechazo('schema_invalido', 'payload_excesivo');
    }
    // SEC-7515-V1 (a): `__proto__` / `constructor` / `prototype` en cualquier
    // nivel del payload crudo cortan acá, antes de copiar o validar nada.
    if (tieneClaveProhibida(payload)) {
        console.warn(`[${MODULO}] schema_invalido: clave_prohibida`);
        return rechazo('schema_invalido', 'clave_prohibida');
    }

    // 1 — identidad del productor (S2) y procedencia NO autodeclarable (SEC-7515-1).
    const productor = resolverProductor(ctx);
    if (!productor) {
        return rechazo('productor_desconocido',
            'el productor debe venir por ctx.productor o PIPELINE_SKILL y pertenecer al enum PRODUCTORES');
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'productor') && payload.productor !== productor) {
        console.warn(`[${MODULO}] productor_no_coincide: contexto=${productor}`);
        return rechazo('productor_no_coincide', `el payload declara un productor distinto de ${productor}`);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'procedencia')) {
        console.warn(`[${MODULO}] procedencia_invalida: procedencia autodeclarada en el payload (productor=${productor})`);
        return rechazo('procedencia_invalida', 'la procedencia viaja por ctx, no dentro del payload');
    }
    const sinProductor = { ...payload };
    delete sinProductor.productor;

    // 2 — canonicalizar y detectar inyección (sobre las dos variantes de Cf).
    const canonico = canonicalizar(sinProductor);
    const variantes = [textosDe(canonico), textosDe(canonicalizar(sinProductor, { cfComoEspacio: true }))];
    for (const textos of variantes) {
        for (const { path: p, texto } of textos) {
            const { hits } = detectInjection(texto);   // se descarta `text` (truncado): nunca se persiste
            if (hits.length > 0) {
                console.warn(`[${MODULO}] inyeccion_detectada productor=${productor} campo=${p} patron=${JSON.stringify(hits[0])}`);
                return rechazo('inyeccion_detectada', `patrón de inyección en ${p}`, { campo: p });
            }
        }
    }

    // 3 — evidencia obligatoria y schema.
    if (!canonico.evidencia || typeof canonico.evidencia !== 'object' || Array.isArray(canonico.evidencia)) {
        return rechazo('evidencia_requerida', 'la propuesta necesita evidencia {tipo, referencia, resumen}');
    }
    const validar = validadorSchema();
    if (!validar(canonico)) {
        const detalle = formatearErroresAjv(validar.errors);
        console.warn(`[${MODULO}] schema_invalido productor=${productor}: ${detalle}`);
        return rechazo('schema_invalido', detalle);
    }

    // 4 — redactar ANTES de medir (y antes del hash, SEC-7515-7).
    const redactado = redactObject(canonico);
    for (const { path: p, texto } of textosDe(redactado)) {
        if (bytesDe(texto) > MAX_BYTES_POR_STRING) {
            return rechazo('schema_invalido', `${p} supera ${MAX_BYTES_POR_STRING} bytes`);
        }
    }
    if (bytesDe(JSON.stringify(redactado)) > MAX_BYTES_PAYLOAD) {
        return rechazo('schema_invalido', `payload supera ${MAX_BYTES_PAYLOAD} bytes`);
    }

    // 5 — sensible no rebajable.
    const forzado = forzarSensible(redactado, productor);
    if (forzado.corregido) {
        console.warn(`[${MODULO}] sensible forzado a true (productor=${productor}, tipo=${redactado.tipo})`);
    }
    const listo = forzado.payload;

    // 6 — procedencia verificable, sólo para el cosechador de comentarios.
    // La config se resuelve UNA vez acá y la reutiliza el ciclo (cuota/tope).
    const cfg = configPropuestas(ctx);
    if (productor === 'recomendacion-agente') {
        const proc = ctx.procedencia && typeof ctx.procedencia === 'object' ? ctx.procedencia : null;
        const autor = proc ? String(proc.author || proc.autor || '').trim() : '';
        const asoc = proc ? String(proc.authorAssociation || '').trim().toUpperCase() : '';
        const valida = !!proc
            && ASOCIACIONES_CONFIABLES.includes(asoc)
            && autor.length > 0
            && cfg.autores_permitidos.includes(autor);
        if (!valida) {
            console.warn(`[${MODULO}] procedencia_invalida productor=${productor} author=${autor || '(vacío)'} authorAssociation=${asoc || '(vacía)'}`);
            return rechazo('procedencia_invalida',
                'recomendacion-agente exige ctx.procedencia con authorAssociation OWNER|MEMBER y autor en propuestas.autores_permitidos');
        }
    }

    // 7 — id derivado por el registro.
    const id = claveDedup(listo, productor);
    const ahora = (typeof ctx.ahora === 'string' && ctx.ahora) ? ctx.ahora : new Date().toISOString();
    const hoy = diaUtc(ahora);

    // 8-10 — read-modify-write bajo lock, con retry por conflict (durable).
    let lockPath;
    try {
        lockPath = backend.fileFor(backend.KEYS.PROPUESTAS);
    } catch (err) {
        return rechazo('store_degradado', err.message);
    }

    const ciclo = () => {
        let ultimo = null;
        for (let intento = 1; intento <= MAX_REINTENTOS_CONFLICT; intento++) {
            const lectura = leer();
            if (!lectura.ok) {
                return rechazo('store_degradado', (lectura.error && lectura.error.message) || 'registro ilegible');
            }
            const { value, version } = lectura;

            const viva = value.vivas.find((v) => v && v.id === id);
            if (viva) return { ok: true, duplicada: true, id, item: copiar(viva) };
            const previa = buscarEnMemoria(value.memoria, id);
            if (previa) {
                if (previa.estado_final === 'rechazada') {
                    return { ...rechazo('rechazada_previamente', 'la misma propuesta ya fue rechazada por el operador'),
                        rechazada_previamente: true, id, decidido_en: previa.decidido_en || null };
                }
                return { ...rechazo('ya_decidida', `la misma propuesta ya fue decidida (${previa.estado_final})`),
                    ya_decidida: true, id, estado_final: previa.estado_final || null, decidido_en: previa.decidido_en || null };
            }

            if (contarDelDia(value, productor, hoy) >= cfg.cuota_diaria_por_productor) {
                const clave = `${productor}|${hoy}`;
                if (!cuotaLogueada.has(clave)) {
                    cuotaLogueada.add(clave);
                    console.warn(`[${MODULO}] cuota_excedida productor=${productor} dia=${hoy} cuota=${cfg.cuota_diaria_por_productor}`);
                }
                return rechazo('cuota_excedida', `cuota diaria de ${cfg.cuota_diaria_por_productor} alcanzada para ${productor}`);
            }
            if (value.vivas.length >= cfg.max_vivas) {
                return rechazo('registro_lleno', `max_vivas=${cfg.max_vivas} alcanzado`);
            }

            const entrada = { id, productor, ...listo, estado: 'pendiente', creada_en: ahora };
            const nuevo = { meta: value.meta, vivas: value.vivas.concat([entrada]), memoria: value.memoria };
            const res = escribir(nuevo, version);
            if (res && res.ok) return { ok: true, id, item: copiar(entrada) };
            ultimo = res;
            if (!(res && res.conflict)) break;
            // conflict: se relee y se re-evalúa dedup/memoria/cuota/tope.
        }
        const msg = (ultimo && ultimo.error && ultimo.error.message) || (ultimo && ultimo.conflict ? 'conflicto de versión persistente' : 'motivo desconocido');
        console.warn(`[${MODULO}] escritura_rechazada productor=${productor}: ${msg}`);
        return rechazo('escritura_rechazada', msg);
    };

    try {
        return withLockSync(lockPath, ciclo, {
            component: `${MODULO}-lock`,
            timeoutMs: LOCK_TIMEOUT_MS,
            maxRetries: LOCK_MAX_RETRIES,
        });
    } catch (err) {
        console.warn(`[${MODULO}] lock no adquirido: ${err && err.message}`);
        return rechazo('store_degradado', `lock no adquirido: ${err && err.message}`);
    }
}

/**
 * Pendientes del registro, filtradas y ordenadas por `creada_en` asc. PURA
 * sobre `leer()`: cero `gh`, cero red, cero productores. Store ilegible ⇒
 * `{ ok:false, motivo:'store_degradado' }` sin throw (CA-21).
 * @param {{productor?: string, tipo?: string, sensible?: boolean, desde?: string}} [filtro]
 * @returns {{ok:true, items:object[]}|{ok:false, motivo:string, detalle:string|null}}
 */
function listarPendientes(filtro) {
    filtro = filtro || {};
    const lectura = leer();
    if (!lectura.ok) {
        return rechazo(lectura.motivo, (lectura.error && lectura.error.message) || 'registro ilegible');
    }
    const items = lectura.value.vivas
        .filter((v) => v && typeof v === 'object' && v.estado === 'pendiente')
        .filter((v) => filtro.productor === undefined || v.productor === filtro.productor)
        .filter((v) => filtro.tipo === undefined || v.tipo === filtro.tipo)
        .filter((v) => filtro.sensible === undefined || v.sensible === filtro.sensible)
        .filter((v) => filtro.desde === undefined || (typeof v.creada_en === 'string' && v.creada_en >= filtro.desde))
        .sort((a, b) => String(a.creada_en || '').localeCompare(String(b.creada_en || '')))
        .map(copiar);
    return { ok: true, items };
}


// ─── Log encadenado de decisiones (#7516) ───────────────────────────────────

/**
 * Path del log append-only de decisiones. Es una FUNCIÓN y no una constante de
 * módulo a propósito: `stateDir()` depende del entorno del proceso (namespace
 * de proyecto, `PIPELINE_DIR_OVERRIDE` de los tests) y evaluarlo en el
 * `require` lo congelaría en el valor del arranque.
 * @returns {string}
 */
function logDecisiones() {
    return path.join(stateDir(), 'audit', LOG_DECISIONES);
}

/** Líneas no vacías del log. Nunca tira: un log ausente o ilegible es `[]`. */
function lineasDelLog(file) {
    try {
        if (!fs.existsSync(file)) return [];
        return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    } catch {
        return [];
    }
}

/**
 * Próximo `seq`: contiguo desde 1 sobre la cantidad de líneas. Se calcula
 * DENTRO del lock del registro, que es el que serializa todos los `decidir()`
 * del host, así que no hay dos procesos pidiendo el mismo número.
 */
function siguienteSeq(file) {
    return lineasDelLog(file).length + 1;
}

/** `seq` de cada línea (o `null` si la línea no parsea). PURA, sin throw. */
function leerSeqs(file) {
    return lineasDelLog(file).map((l) => {
        try {
            const o = JSON.parse(l);
            return Number.isInteger(o && o.seq) ? o.seq : null;
        } catch {
            return null;
        }
    });
}

/** ¿Alguna línea del log menciona ese hash (como `hash_self` o como `ref_hash`)? */
function hashPresenteEnLog(file, hash) {
    return lineasDelLog(file).some((l) => l.indexOf(hash) !== -1);
}

/**
 * Aplica la transición de estado de una propuesta viva. Única superficie de
 * decisión: `publicar()` no puede escribir `estado` ni mover nada a `memoria`.
 *
 * Nunca tira: siempre devuelve `{ok:true, ...}` o `{ok:false, motivo, detalle}`
 * (mismo contrato que `publicar()`, CA-11 de #7515).
 *
 * Orden ESTRICTO:
 *   (a) forma del argumento, enums, coherencia `authorizedBy`↔`canal`, forma
 *       del `id`, `agregado` obligatorio para `aceptar-con-agregado`, inyección
 *       sobre el `agregado` (dos variantes de Cf), cap de bytes y redacción.
 *       Nada de esto toca el store ni el log.
 *   (b) bajo el lock del registro: precondición contra el estado REAL y append
 *       de la decisión al log encadenado. El log va PRIMERO: una decisión que
 *       el store no llegó a aplicar queda registrada; una que el log no
 *       registró no se aplica.
 *   (c) recién después el write al store, re-validando la precondición en cada
 *       reintento. Si otro proceso ganó la carrera, se aborta con una entry de
 *       compensación y NO se re-appendea la decisión.
 *
 * Orden de locks SIEMPRE `propuestas` → log de decisiones (nunca al revés).
 *
 * @param {{id: string, decision: string, authorizedBy: string, canal: string, agregado?: string}} args
 * @returns {object}
 */
function decidir(args) {
    // (a0) — forma del argumento. Mismas guardas que el paso 0 de `publicar()`.
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return rechazo('schema_invalido', 'el argumento debe ser un objeto');
    }
    if (tieneClaveProhibida(args)) {
        console.warn(`[${MODULO}] schema_invalido: clave_prohibida en decidir()`);
        return rechazo('schema_invalido', 'clave_prohibida');
    }
    for (const k of Object.keys(args)) {
        if (!CLAVES_DECIDIR.has(k)) {
            return rechazo('schema_invalido', `clave desconocida: ${claveLogueable(k)}`);
        }
    }

    // (a1) — enums y forma del id, ANTES de tocar el store (SEC-7516-5).
    const id = typeof args.id === 'string' ? args.id : '';
    if (!RE_ID.test(id)) {
        return rechazo('id_invalido', `el id debe tener ${ID_HEX_LEN} caracteres hexadecimales`);
    }
    if (!DECISIONES.includes(args.decision)) {
        return rechazo('decision_invalida', `decision debe ser una de: ${DECISIONES.join(', ')}`);
    }
    if (!AUTHORIZED_BY.includes(args.authorizedBy)) {
        console.warn(`[${MODULO}] authorized_by_invalido canal=${claveLogueable(args.canal)}`);
        return rechazo('authorized_by_invalido', `authorizedBy debe ser una de: ${AUTHORIZED_BY.join(', ')}`);
    }
    if (!CANALES.includes(args.canal)) {
        return rechazo('canal_invalido', `canal debe ser uno de: ${CANALES.join(', ')}`);
    }
    if (args.authorizedBy.split(':')[1] !== args.canal) {
        return rechazo('canal_invalido', 'el canal no coincide con la identidad declarada en authorizedBy');
    }
    if (args.agregado != null && typeof args.agregado !== 'string') {
        return rechazo('schema_invalido', 'agregado debe ser texto');
    }
    if (args.decision === 'aceptar-con-agregado' && !String(args.agregado == null ? '' : args.agregado).trim()) {
        return rechazo('agregado_requerido', 'aceptar-con-agregado exige un agregado no vacío');
    }

    // (a2) — agregado: canonicalizar → inyección (dos variantes de Cf) → cap →
    // redactar. Al log NUNCA entra el crudo (SEC-7516-1): el log es append-only
    // encadenado y borrar una línea rompería todo lo posterior.
    let agregado = null;
    if (args.agregado != null) {
        const canonico = canonicalizar({ agregado: args.agregado });
        const comoEspacio = canonicalizar({ agregado: args.agregado }, { cfComoEspacio: true });
        for (const { path: campo, texto } of [...textosDe(canonico), ...textosDe(comoEspacio)]) {
            const { hits } = detectInjection(texto);
            if (hits.length > 0) {
                console.warn(`[${MODULO}] inyeccion_detectada campo=${campo} patron=${JSON.stringify(hits[0])}`);
                return rechazo('inyeccion_detectada', `patrón de inyección en ${campo}`, { campo });
            }
        }
        if (bytesDe(canonico.agregado) > MAX_BYTES_POR_STRING) {
            return rechazo('schema_invalido', `agregado supera ${MAX_BYTES_POR_STRING} bytes`);
        }
        agregado = redactObject(canonico).agregado;
    }

    const ahora = new Date().toISOString();
    const estadoFinal = ESTADO_FINAL_DE[args.decision];

    let lockPath;
    try {
        lockPath = backend.fileFor(backend.KEYS.PROPUESTAS);
    } catch (err) {
        return rechazo('store_degradado', err.message);
    }

    const ciclo = () => {
        // (b0) — precondición contra el estado REAL, no contra lo que crea el caller.
        const lectura = leer();
        if (!lectura.ok) {
            return rechazo('store_degradado', (lectura.error && lectura.error.message) || 'registro ilegible');
        }
        const viva = lectura.value.vivas.find((v) => v && v.id === id);
        if (!viva) {
            const previa = buscarEnMemoria(lectura.value.memoria, id);
            if (previa) {
                return {
                    ...rechazo('ya_decidida', `la propuesta ya fue decidida (${previa.estado_final})`),
                    ya_decidida: true,
                    id,
                    estado_final: previa.estado_final || null,
                    decidido_en: previa.decidido_en || null,
                };
            }
            return rechazo('propuesta_inexistente', 'no hay ninguna propuesta viva con ese id');
        }

        let file;
        try {
            file = logDecisiones();
        } catch (err) {
            return rechazo('store_degradado', `log de decisiones no resoluble: ${err && err.message}`);
        }

        // (b) — el log PRIMERO. `appendChained` es fail-closed: si no toma su
        // lock, TIRA. Se captura y se traduce: de `decidir()` no sale un throw.
        const entry = {
            timestamp: ahora,
            seq: siguienteSeq(file),
            id,
            decision: args.decision,
            estado_final: estadoFinal,
            // Autodeclarado por el caller — NO es autenticación (ver `AUTHORIZED_BY`).
            authorized_by: args.authorizedBy,
            canal: args.canal,
            // Contexto NO falsificable por el caller (SEC-7516-4).
            actor_proceso: {
                pid: process.pid,
                projectId: require('./project-context').currentProjectIdOrNull(),
                skill: String(process.env.PIPELINE_SKILL || '') || null,
            },
            agregado,
            productor: viva.productor || null,
            sensible: viva.sensible === true,
        };
        let firma;
        try {
            firma = auditLog.appendChained({ file, entry });
        } catch (err) {
            console.warn(`[${MODULO}] store_degradado: log de decisiones no disponible`);
            return rechazo('store_degradado', `log de decisiones no disponible: ${err && err.message}`);
        }

        /**
         * La decisión quedó en el log pero no se aplicó al store: se appendea UNA
         * entry de compensación que la referencia (SEC-7516-8) y se devuelve un
         * resultado distinguible (`decision_registrada: true`).
         */
        const compensar = (motivo, detalle) => {
            try {
                auditLog.appendChained({
                    file,
                    entry: {
                        timestamp: new Date().toISOString(),
                        seq: siguienteSeq(file),
                        tipo: 'decision_no_aplicada',
                        ref_hash: firma.hash_self,
                        motivo,
                        id,
                    },
                });
            } catch (err) {
                return rechazo('store_degradado', `compensación no registrada: ${err && err.message}`,
                    { decision_registrada: true, hash_self: firma.hash_self, id });
            }
            return rechazo(motivo, detalle, { decision_registrada: true, hash_self: firma.hash_self, id });
        };

        // (c) — write al store. Cada reintento RE-VALIDA la precondición: al
        // releer, otro proceso pudo haber movido el mismo id a `memoria`.
        let ultimo = null;
        for (let intento = 1; intento <= MAX_REINTENTOS_CONFLICT; intento++) {
            const l = intento === 1 ? lectura : leer();
            if (!l.ok) {
                return compensar('store_degradado', (l.error && l.error.message) || 'registro ilegible');
            }
            const fuente = l.value.vivas.find((v) => v && v.id === id);
            if (!fuente || buscarEnMemoria(l.value.memoria, id)) {
                return compensar('ya_decidida', 'otra decisión sobre el mismo id ganó la carrera antes del write');
            }
            const nuevo = {
                // Ancla cruzada store↔log (SEC-7516-3 ii): permite detectar una
                // truncación por la cola del log, que el hash chain solo no ve.
                meta: { ...l.value.meta, ultimo_hash_decision: firma.hash_self },
                vivas: l.value.vivas.filter((v) => !(v && v.id === id)),
                memoria: l.value.memoria.concat([{
                    id,
                    clave_dedup: fuente.clave_dedup || id,
                    estado_final: estadoFinal,
                    decidido_en: ahora,
                    // `productor` + `creada_en` son de la CUOTA (CA-PO-3 / SEC-7515-8),
                    // `sensible` es un bit de POLÍTICA (SEC-7516-7). Ninguno es cuerpo.
                    productor: fuente.productor,
                    creada_en: fuente.creada_en,
                    sensible: fuente.sensible === true,
                }]),
            };
            const res = escribir(nuevo, l.version);
            if (res && res.ok) {
                return {
                    ok: true,
                    id,
                    estado_final: estadoFinal,
                    decidido_en: ahora,
                    sensible: fuente.sensible === true,
                    // El agregado NO se persiste en `memoria`: vive en el log y
                    // viaja al caller por este retorno.
                    agregado,
                    hash_self: firma.hash_self,
                };
            }
            ultimo = res;
            if (!(res && res.conflict)) break;
        }
        const msg = (ultimo && ultimo.error && ultimo.error.message)
            || (ultimo && ultimo.conflict ? 'conflicto de versión persistente' : 'motivo desconocido');
        console.warn(`[${MODULO}] decision_no_aplicada id=${id}: ${msg}`);
        return compensar('decision_no_aplicada', msg);
    };

    try {
        return withLockSync(lockPath, ciclo, {
            component: `${MODULO}-lock`,
            timeoutMs: LOCK_TIMEOUT_MS,
            maxRetries: LOCK_MAX_RETRIES,
        });
    } catch (err) {
        console.warn(`[${MODULO}] lock no adquirido: ${err && err.message}`);
        return rechazo('store_degradado', `lock no adquirido: ${err && err.message}`);
    }
}

/**
 * Integridad del log de decisiones. NO es un alias de `verifyChain`: el hash
 * chain detecta ALTERACIÓN pero no TRUNCACIÓN por la cola (al releer, la cadena
 * re-ancla desde la última línea sobreviviente y queda coherente). Se cierra
 * con dos señales extra, sin tocar `audit-log.js`:
 *   - `seq` contiguo desde 1;
 *   - ancla cruzada: `meta.ultimo_hash_decision` del store tiene que estar en el log.
 *
 * @returns {{ok:boolean, entriesChecked:number, motivo:string|null, brokenAt?:number, reason?:string}}
 */
function verificarCadenaDecisiones() {
    let file;
    try {
        file = logDecisiones();
    } catch (err) {
        return { ok: false, entriesChecked: 0, motivo: 'no_resoluble', reason: (err && err.message) || 'path no resoluble' };
    }
    let base;
    try {
        base = auditLog.verifyChain(file);
    } catch (err) {
        return { ok: false, entriesChecked: 0, motivo: 'alterado', reason: (err && err.message) || 'cadena ilegible' };
    }
    if (!base.ok) return { ...base, motivo: 'alterado' };

    const seqs = leerSeqs(file);
    for (let i = 0; i < seqs.length; i++) {
        if (seqs[i] !== i + 1) {
            return {
                ok: false,
                entriesChecked: i,
                brokenAt: i,
                motivo: 'truncado',
                reason: `seq ${String(seqs[i])} en la posición ${i + 1}`,
            };
        }
    }

    const ancla = leer();
    const ultimo = ancla.ok && ancla.value.meta ? ancla.value.meta.ultimo_hash_decision : null;
    if (typeof ultimo === 'string' && ultimo && !hashPresenteEnLog(file, ultimo)) {
        return {
            ok: false,
            entriesChecked: seqs.length,
            motivo: 'truncado',
            reason: 'el store ancla un hash de decisión que no está en el log',
        };
    }
    return { ok: true, entriesChecked: seqs.length, motivo: null };
}

module.exports = {
    publicar,
    listarPendientes,
    decidir,
    verificarCadenaDecisiones,
    logDecisiones,
    claveDedup,
    // Puras para tests de contrato:
    canonicalizar,
    canonicalizarTexto,
    forzarSensible,
    textosDe,
    formatearErroresAjv,
    // Enums / constantes:
    PRODUCTORES,
    TIPOS,
    ESTADOS,
    DECISIONES,
    CANALES,
    AUTHORIZED_BY,
    ESTADO_FINAL_DE,
    MOTIVOS_RECHAZO,
    CAMPOS_HASH,
    SCHEMA_VERSION,
    SCHEMA_FILE,
    MAX_BYTES_CRUDO,
    MAX_BYTES_POR_STRING,
    MAX_BYTES_PAYLOAD,
    DEFAULT_CUOTA_DIARIA,
    DEFAULT_MAX_VIVAS,
    // Sólo tests: el rate-limit de logs de cuota es memoria de proceso.
    _resetLogCuotaForTests() { cuotaLogueada.clear(); },
};
