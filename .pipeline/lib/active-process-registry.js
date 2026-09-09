// =============================================================================
// active-process-registry — registro de corridas en vuelo que sobrevive al
// reinicio del Pulpo.
//
// POR QUÉ EXISTE (incidente 2026-09-08)
// -------------------------------------
// `activeProcesses` era un `new Map()` en memoria. Cada reinicio del Pulpo lo
// vaciaba, y como `brazoHuerfanos` usa ese mapa para decidir si una corrida
// sigue viva, todo lo que estuviera en `trabajando/` pasaba a ser "un proceso
// que no existe" — aunque el agente estuviera corriendo. Con el mtime heredado
// por `fs.renameSync` empujando la edad por encima del timeout, el barrido
// posterior al boot rebotaba fases sanas y les consumía los tres reintentos.
//
// QUÉ HACE
// --------
// Extiende `Map`, así que los ~15 call-sites de `.get/.set/.delete/.has` y las
// iteraciones siguen funcionando sin tocarlos. Además:
//   * persiste el registro en disco en cada mutación (escritura atómica);
//   * lo rehidrata al boot descartando los PIDs que ya no viven.
//
// QUÉ NO PERSISTE
// ---------------
// El handle del watchdog (`setTimeout`) no es serializable y no sobrevive al
// proceso: se omite. Los consumidores ya toleran su ausencia — `clearTimeout`
// sobre `undefined` es no-op. La verdad sobre "sigue vivo" nunca sale del
// archivo: siempre se revalida contra el SO con `isProcessAlive`.
//
// FAIL-SAFE
// ---------
// Toda la I/O es best-effort. Si el archivo está corrupto, es ilegible o el
// disco falla, el registro arranca vacío: se degrada exactamente al
// comportamiento anterior, nunca peor. Por eso la ventana de gracia de
// `orphan-guard` sigue siendo necesaria como segunda red.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// Campos que sí viajan a disco. Lista blanca explícita: evita serializar por
// accidente un handle, un stream o un objeto con ciclos.
const CAMPOS_PERSISTIBLES = Object.freeze([
    'pid',
    'startTime',
    'trabajandoPath',
    'pipeline',
    'fase',
    'worktreePath',
]);

function proyectarParaDisco(info) {
    if (!info || typeof info !== 'object') return null;
    const out = {};
    for (const campo of CAMPOS_PERSISTIBLES) {
        if (info[campo] !== undefined) out[campo] = info[campo];
    }
    return Number.isFinite(out.pid) ? out : null;
}

class ActiveProcessRegistry extends Map {
    /**
     * @param {object} [opts]
     * @param {string} [opts.file]              ruta del archivo de estado
     * @param {typeof fs} [opts.fsImpl]
     * @param {(pid:number)=>boolean} [opts.isProcessAlive]
     * @param {(msg:string)=>void} [opts.onLog]
     */
    constructor(opts = {}) {
        super();
        this._file = opts.file || null;
        this._fs = opts.fsImpl || fs;
        this._isProcessAlive = typeof opts.isProcessAlive === 'function'
            ? opts.isProcessAlive
            : () => false;
        this._log = typeof opts.onLog === 'function' ? opts.onLog : () => {};
        // Durante la rehidratación no queremos reescribir el archivo en cada
        // `set`: se persiste una sola vez al final.
        this._silenciado = false;
    }

    set(key, value) {
        super.set(key, value);
        this._persistir();
        return this;
    }

    delete(key) {
        const borrado = super.delete(key);
        if (borrado) this._persistir();
        return borrado;
    }

    clear() {
        super.clear();
        this._persistir();
    }

    /**
     * Carga el registro del disco y descarta las corridas cuyo PID ya no vive.
     * Idempotente. Devuelve el detalle para que el caller pueda loguearlo.
     *
     * `confiable` dice si el registro resultante describe la realidad. Es false
     * cuando no había archivo (primer arranque tras el deploy) o cuando estaba
     * corrupto: en esos casos el vacío NO significa "nadie está corriendo", y
     * quien consuma el registro tiene que tratarlo como desconocimiento, no como
     * evidencia de muerte.
     *
     * @returns {{ rehidratadas: number, descartadas: number, error: string|null, confiable: boolean }}
     */
    rehidratar() {
        if (!this._file) return { rehidratadas: 0, descartadas: 0, error: null, confiable: false };
        let crudo;
        try {
            crudo = this._fs.readFileSync(this._file, 'utf8');
        } catch {
            // No existe todavía: primer arranque. No es un error, pero tampoco
            // podemos afirmar que no haya corridas en vuelo.
            return { rehidratadas: 0, descartadas: 0, error: null, confiable: false };
        }

        let datos;
        try {
            datos = JSON.parse(crudo);
        } catch (e) {
            this._log(`registro de corridas ilegible, arranco vacío: ${e.message}`);
            return { rehidratadas: 0, descartadas: 0, error: e.message, confiable: false };
        }

        const entradas = (datos && typeof datos === 'object' && datos.corridas) || {};
        let rehidratadas = 0;
        let descartadas = 0;

        this._silenciado = true;
        try {
            for (const [key, info] of Object.entries(entradas)) {
                const proyeccion = proyectarParaDisco(info);
                if (!proyeccion) { descartadas++; continue; }
                // La verdad la tiene el SO, no el archivo.
                let vivo = false;
                try { vivo = this._isProcessAlive(proyeccion.pid) === true; } catch { vivo = false; }
                if (!vivo) { descartadas++; continue; }
                super.set(key, proyeccion);
                rehidratadas++;
            }
        } finally {
            this._silenciado = false;
        }

        this._persistir();
        return { rehidratadas, descartadas, error: null, confiable: true };
    }

    _persistir() {
        if (!this._file || this._silenciado) return;
        const corridas = {};
        for (const [key, info] of super.entries()) {
            const proyeccion = proyectarParaDisco(info);
            if (proyeccion) corridas[key] = proyeccion;
        }
        const payload = JSON.stringify({
            version: 1,
            actualizado: new Date().toISOString(),
            corridas,
        }, null, 2);

        try {
            this._fs.mkdirSync(path.dirname(this._file), { recursive: true });
            // Escritura atómica: un Pulpo que muere a mitad de la escritura no
            // deja el registro truncado (que se leería como "nadie corre" y
            // volvería a habilitar el rebote masivo).
            const tmp = `${this._file}.tmp.${process.pid}`;
            this._fs.writeFileSync(tmp, payload, 'utf8');
            this._fs.renameSync(tmp, this._file);
        } catch (e) {
            this._log(`no pude persistir el registro de corridas: ${e.message}`);
        }
    }
}

module.exports = { ActiveProcessRegistry, CAMPOS_PERSISTIBLES };
