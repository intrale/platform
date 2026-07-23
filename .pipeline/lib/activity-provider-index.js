'use strict';

// =============================================================================
// activity-provider-index.js — Índice (issue, skill, fase) → proveedor (#4199).
//
// El feed de Historial (timeline de ejecuciones de agentes) necesita el
// PROVEEDOR de cada ejecución para el filtro «por proveedor» (CA-4 de #4199).
// Los markers FS de fase (`.pipeline/desarrollo/*/procesado/*`) NO registran el
// proveedor; la única fuente fiable por-ejecución es el activity-log
// (`.claude/activity-log.jsonl`), donde cada `session:start`/`session:end` lleva
// `{ issue, skill, phase, provider }` (verificado empíricamente sobre el log
// real del pipeline).
//
// Este módulo construye un índice liviano y cacheado de ese join, para que el
// slice del historial pueda resolver `provider` por ejecución sin re-parsear el
// log en cada item. Diseño defensivo (regla «el pipeline no puede morir»):
//   - Lectura ACOTADA: solo se parsea la cola del archivo (MAX_BYTES), porque
//     el activity-log puede crecer y rota; el historial muestra lo reciente.
//   - Cache por (mtimeMs + size): si el archivo no cambió, se reusa el índice.
//   - Todo en try/catch: ante cualquier error (archivo ausente, línea corrupta,
//     IO) degrada a un índice vacío → el filtro de proveedor simplemente no
//     ofrece opciones, pero la pantalla sigue funcionando (CA-3 degradación).
//
// El módulo NO escribe nada y NO depende del resto del pipeline.
// =============================================================================

const fs = require('fs');

// Tope de lectura: 4 MB de cola del activity-log. Suficiente para cubrir la
// ventana de ejecuciones que el historial muestra (días recientes) sin cargar
// archivos históricos enteros en memoria.
const MAX_BYTES = 4 * 1024 * 1024;

// Cache de proceso. Clave de invalidación = `${mtimeMs}:${size}` del archivo.
let _cache = { key: null, index: null };

// Clave de join. Normaliza a string y minúsculas el skill/fase para tolerar
// variaciones de casing entre el marker FS y el activity-log.
function _key(issue, skill, fase) {
    return `${String(issue)}::${String(skill || '').toLowerCase()}::${String(fase || '').toLowerCase()}`;
}

// Clave de fallback (issue + skill) cuando la fase no matchea exactamente.
function _keyLoose(issue, skill) {
    return `${String(issue)}::${String(skill || '').toLowerCase()}`;
}

// Lee la cola del archivo (hasta MAX_BYTES) como texto utf8. Si el archivo es
// más grande que el tope, descarta la primera línea parcial (puede estar
// cortada por el offset). Devuelve '' ante cualquier error.
function _readTail(filePath, size) {
    let fd = null;
    try {
        const start = size > MAX_BYTES ? size - MAX_BYTES : 0;
        const length = size - start;
        if (length <= 0) return '';
        const buf = Buffer.allocUnsafe(length);
        fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buf, 0, length, start);
        let text = buf.toString('utf8');
        // Si recortamos por el medio, la primera línea puede estar partida.
        if (start > 0) {
            const nl = text.indexOf('\n');
            if (nl >= 0) text = text.slice(nl + 1);
        }
        return text;
    } catch {
        return '';
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* noop */ } }
    }
}

// buildProviderIndex(activityLogPath)
//   Devuelve un objeto con métodos de consulta. Cacheado por mtime+size.
//   Siempre devuelve un índice válido (vacío ante error).
function buildProviderIndex(activityLogPath) {
    let key = null;
    try {
        const st = fs.statSync(activityLogPath);
        key = `${st.mtimeMs}:${st.size}`;
        if (_cache.key === key && _cache.index) return _cache.index;
        const text = _readTail(activityLogPath, st.size);
        const map = new Map();      // key estricta → provider
        const looseMap = new Map(); // key floja (issue+skill) → provider
        const providers = new Set();
        const lines = text.split('\n');
        for (const line of lines) {
            if (!line) continue;
            let e;
            try { e = JSON.parse(line); } catch { continue; }
            if (!e || typeof e !== 'object') continue;
            // Solo eventos de sesión llevan el join issue/skill/phase/provider.
            const ev = e.event || '';
            if (ev !== 'session:start' && ev !== 'session:end') continue;
            const prov = e.provider;
            if (!prov || typeof prov !== 'string') continue;
            if (e.issue === undefined || e.issue === null) continue;
            const skill = e.skill || '';
            const phase = e.phase || '';
            // «último gana»: el log está en orden cronológico, así que la última
            // sesión observada para esa ejecución refleja el proveedor efectivo.
            map.set(_key(e.issue, skill, phase), prov);
            looseMap.set(_keyLoose(e.issue, skill), prov);
            providers.add(prov);
        }
        const index = {
            size: map.size,
            providers: Array.from(providers).sort(),
            // resolve(issue, skill, fase) → provider|null. Intenta match estricto
            // y cae al match flojo (issue+skill) si la fase no coincide.
            resolve(issue, skill, fase) {
                if (issue === undefined || issue === null) return null;
                const strict = map.get(_key(issue, skill, fase));
                if (strict) return strict;
                const loose = looseMap.get(_keyLoose(issue, skill));
                return loose || null;
            },
        };
        _cache = { key, index };
        return index;
    } catch {
        // Archivo ausente o IO error → índice vacío inerte (degradación CA-3).
        const empty = { size: 0, providers: [], resolve() { return null; } };
        if (key) _cache = { key, index: empty };
        return empty;
    }
}

// Helper para tests: limpia el cache de proceso.
function _resetCacheForTests() {
    _cache = { key: null, index: null };
}

module.exports = {
    buildProviderIndex,
    _resetCacheForTests,
    _key,
    MAX_BYTES,
};
