// =============================================================================
// force-windows-hide — suprime las ventanas de consola en Windows
// =============================================================================
//
// Problema: en Windows, cuando un proceso Node corre sin consola propia (todos
// los servicios del pipeline se lanzan con `Start-Process -WindowStyle Hidden`
// o con `detached:true`), cada hijo que crea `child_process` levanta SU PROPIA
// consola (`conhost.exe`) y esa ventana es VISIBLE: aparece, roba el foco y se
// cierra. Con el pulpo llamando `gh`, `git`, `tasklist` y `powershell` decenas
// de veces por minuto, el escritorio queda inusable.
//
// Node expone la opción `windowsHide` para eso, pero su default es `false` y
// hay que pasarla en CADA llamada. Sostener esa disciplina en ~780 sitios de
// llamada no es realista: alcanza con que un solo `execSync` nuevo se olvide
// para que el parpadeo vuelva (ya pasó — ver memoria ops-watchdog-window-flash).
//
// Este módulo lo resuelve de raíz: parchea `child_process` una sola vez, al
// arranque de cada entrypoint, forzando `windowsHide: true` en todas las
// variantes de spawn/exec. Es idempotente y no-op fuera de Windows.
//
// Propagación a procesos hijos: además inyecta `--require <este archivo>` en
// `NODE_OPTIONS`, para que los sub-procesos Node que lanza el pipeline (hooks,
// skills determinísticos, scripts one-shot) nazcan ya parcheados sin tener que
// tocarlos uno por uno. Se puede desactivar con `PIPELINE_NO_HIDE_PATCH=1`.
//
// Uso: `require('./lib/force-windows-hide').apply();` como PRIMERA línea
// ejecutable del entrypoint, antes de cualquier otro require que pueda
// spawnear.
// =============================================================================

'use strict';

const path = require('path');

const FLAG = '__intralePipelineWindowsHidePatched';
// Variantes con objeto de opciones en distintas posiciones:
//   spawn(cmd, args?, opts?) / execFile(file, args?, opts?, cb?)
//   exec(cmd, opts?, cb?) / execSync(cmd, opts?)
const ARG_STYLE = {
    spawn: 'file-args',
    spawnSync: 'file-args',
    execFile: 'file-args',
    execFileSync: 'file-args',
    exec: 'command',
    execSync: 'command',
    fork: 'file-args',
};

// Devuelve el índice donde vive (o debería vivir) el objeto de opciones.
function _optionsIndex(style, args) {
    const start = style === 'command' ? 1 : 1;
    for (let i = start; i < args.length; i++) {
        const a = args[i];
        if (typeof a === 'function') return i; // callback: las opciones van antes
        if (Array.isArray(a)) continue; // args del comando
        if (a && typeof a === 'object') return i; // ya hay objeto de opciones
        if (a == null) continue;
    }
    return args.length;
}

function _withHide(style, args) {
    const out = args.slice();
    const idx = _optionsIndex(style, out);
    const current = out[idx];
    if (current && typeof current === 'object' && !Array.isArray(current)) {
        // Respetamos un opt-out explícito: si alguien puso windowsHide:false a
        // propósito (por ejemplo para debug interactivo), no lo pisamos.
        if (Object.prototype.hasOwnProperty.call(current, 'windowsHide')) return out;
        out[idx] = Object.assign({}, current, { windowsHide: true });
        return out;
    }
    // No había objeto de opciones: lo insertamos antes del callback (si hay).
    out.splice(idx, 0, { windowsHide: true });
    return out;
}

// Suma `--require <self>` a NODE_OPTIONS para que los hijos Node hereden el
// parche. Idempotente: no duplica la entrada si ya está.
function _propagate(env) {
    // Barras forward a propósito: Node las acepta en Windows y evitan que
    // JSON.stringify escape cada `\` (con backslashes el `includes()` de abajo
    // nunca matcheaba y NODE_OPTIONS crecía un `--require` por cada apply()).
    const self = path.resolve(__filename).split(path.sep).join('/');
    const flag = `--require ${JSON.stringify(self)}`;
    const prev = env.NODE_OPTIONS || '';
    if (prev.includes(flag)) return;
    env.NODE_OPTIONS = prev ? `${prev} ${flag}` : flag;
}

function apply({ propagate = true, _cp = null, _platform = process.platform, _env = process.env } = {}) {
    if (_platform !== 'win32') return false;
    if (_env.PIPELINE_NO_HIDE_PATCH === '1') return false;

    const cp = _cp || require('child_process');
    if (cp[FLAG]) return true;

    for (const [name, style] of Object.entries(ARG_STYLE)) {
        const original = cp[name];
        if (typeof original !== 'function') continue;
        const patched = function (...args) {
            return original.apply(this, _withHide(style, args));
        };
        Object.defineProperty(patched, 'name', { value: name });
        cp[name] = patched;
    }

    Object.defineProperty(cp, FLAG, { value: true, enumerable: false });
    if (propagate) _propagate(_env);
    return true;
}

module.exports = { apply, _withHide, _optionsIndex, FLAG };

// Auto-aplicación al cargar. Necesaria para el modo precarga (`node --require`,
// que es como lo heredan los sub-procesos vía NODE_OPTIONS): ahí nadie llama
// `apply()`. Es idempotente, respeta `PIPELINE_NO_HIDE_PATCH=1` y es no-op
// fuera de Windows, así que también es inocua cuando el módulo se requiere
// como dependencia normal.
apply();
