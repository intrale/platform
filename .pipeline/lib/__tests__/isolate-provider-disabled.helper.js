'use strict';

// isolate-provider-disabled.helper.js — aísla los tests de resolución de chain
// del kill-switch operacional LIVE (`provider-disabled.json` global, #3811).
//
// PROBLEMA (rebote #4801): los tests de `resolveSpawnWithFallback` /
// `commander/multi-provider` inyectan un `quotaModule` fake y NO ejercitan el
// kill-switch, pero el default interno de `resolveSpawnWithFallback` consulta el
// módulo real `provider-disabled`, que lee el estado GLOBAL de disco
// (`.pipeline/provider-disabled.json`). Cuando el pulpo drena un provider en
// runtime (health-probe / cuota agotada), esos tests flipeaban a rojo — p.ej.
// esperaban `openai-codex` y obtenían `gemini-google` / `cerebras` / `all-gated`
// según qué provider estuviera drenado en el instante de correr la suite. Un
// falso positivo puro dependiente del reloj/estado, no de un bug de producción.
//
// SOLUCIÓN: neutralizar SÓLO la lectura del estado GLOBAL live, respetando los
// tests que aíslan su propio estado. `resolveSpawnWithFallback` accede a
// `.isProviderDisabled` de forma dinámica en cada llamada sobre el mismo objeto
// de módulo (mismo path absoluto → misma entrada de caché), así que sobreescribir
// la propiedad acá surte efecto sin importar el orden require/patch.
//
// Un test que quiere ejercitar el kill-switch REAL escribe su propio
// `provider-disabled.json` en un sandbox y apunta `PIPELINE_DIR_OVERRIDE` a él
// (patrón del test #4313). En ese caso NO neutralizamos: delegamos al módulo
// real, que lee el flag-file del sandbox del test. Sólo cuando `PIPELINE_DIR_OVERRIDE`
// está ausente —el caso en que el módulo caería al estado GLOBAL live y se
// volvería flaky— devolvemos "nada deshabilitado".
//
// SEGURIDAD: cada archivo de `*.test.js` corre en su PROPIO subproceso de
// `node --test`, por lo que esta mutación NO filtra a otros tests ni muta el
// archivo de estado global real en disco (sólo cambia una referencia de función
// en memoria del subproceso).
const providerDisabled = require('../provider-disabled');

const _origIsProviderDisabled = providerDisabled.isProviderDisabled;
const _origGetDisabledEntry = providerDisabled.getDisabledEntry;

providerDisabled.isProviderDisabled = function (name, opts) {
    if (process.env.PIPELINE_DIR_OVERRIDE) {
        return _origIsProviderDisabled.call(this, name, opts);
    }
    return false;
};

providerDisabled.getDisabledEntry = function (name, opts) {
    if (process.env.PIPELINE_DIR_OVERRIDE) {
        return _origGetDisabledEntry.call(this, name, opts);
    }
    return null;
};

module.exports = providerDisabled;
