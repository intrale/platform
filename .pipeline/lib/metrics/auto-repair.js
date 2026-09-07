'use strict';

// =============================================================================
// auto-repair.js — Métrica de auto-reparaciones del despacho + detector de
// repetición anómala (issue #6117).
//
// POR QUÉ EXISTE
// --------------
// Antes de #6117, cada auto-reparación EXITOSA de la lista de despacho emitía
// un aviso de Telegram. Esos avisos no pedían ninguna decisión del operador (la
// operación ya se había ejecutado bien), exponían vocabulario interno y diluían
// las alertas que sí requieren intervención. #6117 los silencia y manda el dato
// a este store, que es lo que hace observable la reparación sin ocupar el canal.
//
// Registra, de forma append-only, una línea JSON por auto-reparación exitosa con
// EXACTAMENTE los 4 campos whitelist:
//   { tipo, issues, count, timestamp }
//
// Fuente de verdad: `.pipeline/state/auto-repair.jsonl`. Patrón de escritura
// idéntico a `metrics/provider-cost.js` (que a su vez copia `audit-log.js:293`):
// `appendFileSync(JSON.stringify(rec) + '\n')`, un registro por línea.
//
// DOS RESPONSABILIDADES, UN SOLO STORE (H4)
// -----------------------------------------
// El mismo JSONL cubre la métrica (CA-6) y el contador de repetición (CA-5). Se
// eligió así a propósito: el Pulpo se reinicia seguido (watchdog, `restart.js`,
// respawn) y un contador in-memory — como el de `lib/telegram-alert-dedup.js` —
// se resetearía justo cuando la causa raíz agita el sistema y provoca los
// reinicios. Derivar el conteo de un archivo en `.pipeline/state/` lo hace
// sobrevivir al reinicio, que es la única forma de que la N-ésima repetición se
// llegue a detectar.
//
// TRADE-OFF DE LA ROTACIÓN (documentado a propósito)
// --------------------------------------------------
// El JSONL rota por tamaño (`lib/jsonl-rotation`, 5 MB) y la ventana de
// repetición es de 1 hora. Una rotación justo dentro de la ventana subcuenta las
// reparaciones previas y puede demorar una alerta. Se acepta: el volumen
// esperado es de unidades por día (una auto-reparación es un evento raro), así
// que llegar a 5 MB dentro de una ventana de 1 h no es un escenario real. NO se
// agrega lógica de merge de archivos rotados — sería complejidad para un caso
// que no ocurre, y el costo del fallo es una alerta tardía, no un dato perdido
// (la línea rotada sigue existiendo comprimida).
//
// SEGURIDAD
//   - SEC-6 (whitelist estricta): el registro se construye por ASIGNACIÓN
//     LITERAL de los 4 campos. NUNCA `{...opts}` ni `Object.assign(dst, opts)`.
//     El `opts` del caller arrastra el `probe` del desync-detector y el
//     resultado del mutador; un spread filtraría paths, allowlists completas y
//     motivos crudos al store que el dashboard expone sin autenticación.
//   - `tipo` se valida contra el enum cerrado `TIPOS`; cualquier otro valor cae
//     a `'desconocido'`. Cierra CWE-117 (log injection) sin necesidad de
//     sanitizar: el campo no puede contener texto arbitrario.
//   - `issues` se coerciona a array de ENTEROS POSITIVOS. Números de issue, nada
//     más: no puede vehicular strings ni objetos.
//   - SEC-3 (la firma es SOLO el tipo): el set de issues es PAYLOAD, nunca clave
//     de agrupación. Si el set formara parte de la firma, la misma causa raíz
//     reparando issues distintos en cada vuelta nunca alcanzaría el umbral — que
//     es exactamente el síntoma que la alerta busca detectar.
//   - SEC-4 (fail-open hacia notificar): si el JSONL no se lee o no se parsea,
//     `shouldAlertRepetition` devuelve `alert: true`. Perder la capacidad de
//     contar no puede traducirse en silencio: ante la duda, se avisa.
//
// NEVER-THROWS: `recordAutoRepair` y `readLastAutoRepair` van envueltos en
// try/catch que traga el error. Esta telemetría es best-effort y jamás debe
// romper el ciclo del Pulpo ni el camino de reparación que la invoca.
// =============================================================================

const fs = require('fs');
const path = require('path');

// Set exacto de campos persistidos. El test afirma que `Object.keys` de cada
// línea === este array, ni una clave más (SEC-6 whitelist estricta).
const WHITELIST = ['tipo', 'issues', 'count', 'timestamp'];

// Enum cerrado de tipos de auto-reparación. Un `tipo` fuera de este set se
// persiste como 'desconocido' en vez de escribirse crudo.
const TIPOS = new Set(['convergencia_aditiva', 'reparacion_aditiva_wave_add']);

// Defaults + rangos del detector de repetición. Estilo `lib/anomaly-detector.js`:
// una config rota NUNCA frena el pipeline ni desactiva la alerta — se clampea.
const DEFAULT_THRESHOLD = 3;
const THRESHOLD_MIN = 2;      // < 2 haría que la 1ª reparación ya alerte: sin sentido.
const THRESHOLD_MAX = 50;
const DEFAULT_WINDOW_MS = 3600000;   // 1 hora
const WINDOW_MIN_MS = 60000;         // 1 minuto
const WINDOW_MAX_MS = 86400000;      // 24 horas

// Umbral de rotación del JSONL, en MB. Ver "TRADE-OFF DE LA ROTACIÓN" arriba.
const ROTATE_MB = 5;

/**
 * Ruta canónica del JSONL de auto-reparaciones.
 *
 * Respeta `PIPELINE_DIR_OVERRIDE` igual que `lib/desync-block-notifier.js`. Es
 * obligatorio, no cosmético: sin esto los tests de integración escribirían en el
 * `.pipeline/state/` REAL, contaminando el contador que el pipeline en
 * producción usa para decidir si alerta por repetición — y encima leerían ese
 * mismo estado real, volviéndose no deterministas.
 */
function defaultFile() {
    const base = process.env.PIPELINE_DIR_OVERRIDE
        ? path.resolve(process.env.PIPELINE_DIR_OVERRIDE)
        : path.join(__dirname, '..', '..');
    return path.join(base, 'state', 'auto-repair.jsonl');
}

/**
 * Clampea un número dentro de [min, max]. Un valor no finito cae al default.
 * Nunca lanza: la config del operador no puede romper el camino de reparación.
 */
function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
}

/** Normaliza el tipo contra el enum cerrado (SEC-6). */
function normalizeTipo(tipo) {
    const t = String(tipo == null ? '' : tipo);
    return TIPOS.has(t) ? t : 'desconocido';
}

/** Coerciona a array de enteros positivos y deduplica (SEC-6). */
function normalizeIssues(issues) {
    if (!Array.isArray(issues)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of issues) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    return out;
}

/**
 * Persiste una auto-reparación exitosa (append-only, never-throws).
 *
 * @param {object} opts
 * @param {string} opts.tipo     'convergencia_aditiva' | 'reparacion_aditiva_wave_add'
 * @param {number[]} opts.issues números de issue repuestos
 * @param {object} [deps]        inyección para tests: { fs, file, now }
 * @returns {{ ok: boolean }} best-effort; `ok:false` si no se pudo escribir.
 */
function recordAutoRepair(opts = {}, deps = {}) {
    const _fs = deps.fs || fs;
    const file = deps.file || defaultFile();
    try {
        const issues = normalizeIssues(opts.issues);
        // SEC-6: asignación LITERAL de los 4 campos. Prohibido spread.
        const record = {
            tipo: normalizeTipo(opts.tipo),
            issues,
            count: issues.length,
            timestamp: new Date(typeof deps.now === 'function' ? deps.now() : Date.now()).toISOString(),
        };
        try { _fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* best-effort */ }
        // Rotación ANTES del append: si el archivo ya está pasado de tamaño, se
        // archiva y el append siguiente arranca sobre uno vacío.
        try {
            require('../jsonl-rotation').rotateIfNeeded({ path: file, limitMb: ROTATE_MB, redact: true });
        } catch { /* best-effort: la rotación nunca bloquea la métrica */ }
        _fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
        return { ok: true };
    } catch {
        return { ok: false };   // never-throws — best-effort
    }
}

/**
 * Lee todas las líneas parseables del JSONL. Uso interno.
 *
 * @returns {{ ok: boolean, records: object[] }}
 *   `ok:false` si el archivo existe pero no se pudo leer (permiso denegado,
 *   I/O). Un archivo AUSENTE es `ok:true` con `records: []` — no haber reparado
 *   nunca es un estado legítimo, no una falla de lectura.
 */
function readRecords(deps = {}) {
    const _fs = deps.fs || fs;
    const file = deps.file || defaultFile();
    let raw;
    try {
        raw = _fs.readFileSync(file, 'utf8');
    } catch (e) {
        // ENOENT = todavía no hubo ninguna reparación. Cualquier otro error
        // (EACCES, EIO) es estado ilegible de verdad → fail-open hacia notificar.
        if (e && e.code === 'ENOENT') return { ok: true, records: [] };
        return { ok: false, records: [] };
    }
    const records = [];
    let hadParseError = false;
    for (const line of String(raw).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec;
        try { rec = JSON.parse(trimmed); } catch { hadParseError = true; continue; }
        if (!rec || typeof rec !== 'object') { hadParseError = true; continue; }
        records.push(rec);
    }
    // SEC-4: una línea corrupta significa que el conteo que devolvamos puede ser
    // menor al real. Marcamos el estado como ilegible para que el detector
    // falle hacia notificar en vez de dar un `alert:false` que no puede sostener.
    if (hadParseError) return { ok: false, records };
    return { ok: true, records };
}

/**
 * Última auto-reparación registrada, para el dashboard (read-only).
 *
 * @param {object} [deps] inyección para tests: { fs, file }
 * @returns {{tipo: string, issues: number[], timestamp: string}|null}
 *   `null` si no hay ninguna, el archivo no existe o algo falla. NUNCA lanza.
 */
function readLastAutoRepair(deps = {}) {
    try {
        const { records } = readRecords(deps);
        // Se recorre de atrás hacia adelante: la última línea BIEN FORMADA gana.
        // Una línea final truncada por un crash a mitad de append no puede dejar
        // al dashboard sin dato.
        for (let i = records.length - 1; i >= 0; i--) {
            const rec = records[i];
            const tipo = normalizeTipo(rec.tipo);
            const timestamp = typeof rec.timestamp === 'string' ? rec.timestamp : null;
            if (!timestamp || !Number.isFinite(Date.parse(timestamp))) continue;
            // SEC-6: se re-proyecta el shape acotado. Aunque el JSONL tuviera
            // campos de más (versión futura, edición manual), el dashboard sólo
            // ve estos tres.
            return { tipo, issues: normalizeIssues(rec.issues), timestamp };
        }
        return null;
    } catch {
        return null;   // never-throws
    }
}

/**
 * ¿La repetición de esta reparación delata una causa raíz sin resolver?
 *
 * Cuenta cuántas reparaciones del MISMO tipo (SEC-3: el tipo es toda la firma;
 * el set de issues es payload) hay dentro de la ventana, y compara con el
 * umbral. Se asume que la reparación en curso YA fue registrada con
 * `recordAutoRepair` antes de llamar acá, así que el conteo la incluye.
 *
 * @param {object} opts
 * @param {string} opts.tipo         firma de la reparación
 * @param {number} [opts.nowMs]      epoch ms de referencia (default Date.now())
 * @param {number} [opts.threshold]  N reparaciones que disparan la alerta
 * @param {number} [opts.windowMs]   ventana de tiempo en ms
 * @param {object} [deps]            inyección para tests: { fs, file }
 * @returns {{alert: boolean, count: number, threshold: number, windowMs: number,
 *           motivo: 'umbral'|'estado_ilegible'|'bajo_umbral'}}
 */
function shouldAlertRepetition(opts = {}, deps = {}) {
    const threshold = clamp(opts.threshold, THRESHOLD_MIN, THRESHOLD_MAX, DEFAULT_THRESHOLD);
    const windowMs = clamp(opts.windowMs, WINDOW_MIN_MS, WINDOW_MAX_MS, DEFAULT_WINDOW_MS);
    const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
    const tipo = normalizeTipo(opts.tipo);

    let read;
    try {
        read = readRecords(deps);
    } catch {
        read = { ok: false, records: [] };
    }

    // SEC-4 — fail-open hacia NOTIFICAR. Si no podemos contar, no podemos
    // afirmar que estamos bajo el umbral. El costo de un aviso de más es ruido;
    // el de un aviso de menos es una causa raíz que sigue corriendo invisible.
    if (!read.ok) {
        return { alert: true, count: 0, threshold, windowMs, motivo: 'estado_ilegible' };
    }

    const desde = nowMs - windowMs;
    let count = 0;
    for (const rec of read.records) {
        // SEC-3: se agrupa SÓLO por tipo. `rec.issues` no participa de la firma.
        if (normalizeTipo(rec.tipo) !== tipo) continue;
        const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
        if (!Number.isFinite(ts)) continue;
        if (ts < desde || ts > nowMs) continue;
        count++;
    }

    if (count >= threshold) {
        return { alert: true, count, threshold, windowMs, motivo: 'umbral' };
    }
    return { alert: false, count, threshold, windowMs, motivo: 'bajo_umbral' };
}

module.exports = {
    recordAutoRepair,
    readLastAutoRepair,
    shouldAlertRepetition,
    WHITELIST,
    TIPOS,
    DEFAULT_THRESHOLD,
    DEFAULT_WINDOW_MS,
};
