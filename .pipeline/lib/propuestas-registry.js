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

const path = require('path');
const crypto = require('crypto');

const backend = require('./operational-state-backend');
const { withLockSync } = require('./file-lock');
const { detectInjection } = require('./handoff');
const { redactObject } = require('./redact');
const { canonicalJsonStringify } = require('./audit-log');

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
 * Previstos para la parte 3 (#7516, `decidir()`): quedan vacíos a propósito
 * para que completarlos no cambie la firma pública del módulo.
 */
const DECISIONES = Object.freeze([]);
const CANALES = Object.freeze([]);

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

// Caps (SEC-B / SEC-7515-4). El crudo se mide ANTES de cualquier regex.
const MAX_BYTES_CRUDO = 64 * 1024;
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
    const ajv = new Ajv({ allErrors: true, verbose: false, strict: true });
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
    return errors.map((e) => {
        const donde = e.instancePath ? `data${e.instancePath}` : 'data';
        const extra = (e.params && typeof e.params.additionalProperty === 'string')
            ? ` (${e.params.additionalProperty})`
            : '';
        return `${donde} ${e.message}${extra}`;
    }).join('; ');
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
        for (const k of Object.keys(valor)) out[k] = canonicalizar(valor[k], opts);
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
            for (const k of Object.keys(v)) visitar(v[k], p ? `${p}.${k}` : k);
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
 * (inyección por firma, tests) cortocircuita la lectura. Config ausente o
 * ilegible ⇒ defaults: cuota/tope sanos y allowlist VACÍA (fail-closed para
 * `recomendacion-agente`: nadie entra desde un repo público sin allowlist).
 * `max_vivas` se cota por `MAX_PROPUESTAS_VIVAS` del sustrato (CA-PO-4).
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
 * @returns {{ok:true, value:object, version:any}|{ok:false, motivo:string, error:Error|null}}
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
    if (v === null || v === undefined) return { ok: true, value: VACIO(), version: null };
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
 *   0. forma básica + pre-cap de 64 KB crudo (SEC-7515-4)
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
    if (productor === 'recomendacion-agente') {
        const cfg = configPropuestas(ctx);
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

            const cfg = configPropuestas(ctx);
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

module.exports = {
    publicar,
    listarPendientes,
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
