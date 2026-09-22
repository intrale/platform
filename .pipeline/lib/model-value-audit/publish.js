'use strict';

// =============================================================================
// model-value-audit / publish — puerto `publish(proposal, ctx)` (#7520, P8)
// =============================================================================
//
// `createPublisher({ adapter, deps })` resuelve el adaptador por nombre:
//
//   - `none`            ⇒ `{ ok: true, reason: 'adaptador_none' }` sin cargar
//                         ni invocar ningún módulo (CA-26).
//   - `telegram-plain`  ⇒ `require('./publish-telegram')` (perezoso).
//   - `registry`        ⇒ `deps.registryModule` (#6807). Mientras #6807 no esté
//                         mergeado no existe ⇒ `{ ok: false, reason:
//                         'adaptador_no_disponible' }` y NUNCA cae a
//                         `telegram-plain` (SEC-15: cambiar el canal elegido por
//                         el operador sin su firma no es una opción).
//   - cualquier otro    ⇒ `adaptador_no_disponible` (el schema ya lo bloquea antes).
//
// `ctx` = `{ productor, report, hash, hash8, propagationEnabled, cfgRoot,
// pipelineRoot, logger, now }`; `deps` se suma al `ctx` como `ctx.deps` para
// que el adaptador reciba sus hooks de test (dropfile, audio, reloj).
//
// Puro: sin `fs`.

const ADAPTERS = Object.freeze(['telegram-plain', 'registry', 'none']);
const REASON_NONE = 'adaptador_none';
const REASON_NO_DISPONIBLE = 'adaptador_no_disponible';

function noneAdapter() {
    return { ok: true, reason: REASON_NONE, items: 0, audio: 'no', audioTask: null };
}

/**
 * @param {{adapter:string, deps?:object}} p
 * @returns {{adapter:string, publish:(proposal:object, ctx:object)=>object}}
 */
function createPublisher({ adapter, deps } = {}) {
    const name = typeof adapter === 'string' ? adapter : 'none';
    const extra = (deps && typeof deps === 'object') ? deps : {};
    const withDeps = (ctx) => ({ ...(ctx || {}), deps: { ...((ctx && ctx.deps) || {}), ...extra } });

    if (name === 'none') {
        return { adapter: name, publish: () => noneAdapter() };
    }
    if (name === 'telegram-plain') {
        const loader = typeof extra.telegramModule === 'function'
            ? extra.telegramModule
            : () => require('./publish-telegram');
        return {
            adapter: name,
            publish: (proposal, ctx) => loader().publish(proposal, withDeps(ctx)),
        };
    }
    if (name === 'registry') {
        return {
            adapter: name,
            publish: (proposal, ctx) => {
                const mod = extra.registryModule;
                if (!mod || typeof mod.publish !== 'function') {
                    if (ctx && typeof ctx.logger === 'function') ctx.logger('adaptador registry no disponible (#6807 sin mergear); no se degrada a otro canal');
                    return { ok: false, reason: REASON_NO_DISPONIBLE, items: 0, audio: 'no', audioTask: null };
                }
                return mod.publish(proposal, withDeps(ctx));
            },
        };
    }
    return {
        adapter: name,
        publish: () => ({ ok: false, reason: REASON_NO_DISPONIBLE, items: 0, audio: 'no', audioTask: null }),
    };
}

module.exports = { ADAPTERS, REASON_NONE, REASON_NO_DISPONIBLE, createPublisher };
