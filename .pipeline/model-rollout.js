#!/usr/bin/env node
'use strict';
const rollout = require('./lib/model-propagation-rollout');
const configResolver = require('./lib/config-resolver');
const pipelineDir = __dirname;
const argv = process.argv.slice(2); const command = argv.shift();
const arg = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const fullConfig = configResolver.resolve({ pipelineDir });
const config = (fullConfig.model_propagation_rollout || {});
// Actores realmente despachables por el pulpo. Es la lista contra la que se
// validan los escalones: nombrar un actor que no se despacha deja el rollout
// permanentemente trabado en n=0 (review de #6274).
const actores = rollout.dispatchableActors(fullConfig);
// Modelo declarado del par, tal como lo resolveria el spawn real. Best-effort:
// si el resolver no puede responder, `preview` exige `--model` explicito.
function resolveProviderModel(actor, provider) {
  try {
    const { resolveProviderForSkill } = require('./lib/agent-launcher/resolve-provider');
    const res = resolveProviderForSkill(actor, { pipelineDir });
    if (res && res.provider === provider && res.model) return res.model;
  } catch { /* se cae al error de abajo */ }
  throw new Error(`no se pudo resolver el modelo de ${actor}@${provider}; pasar --model explicito`);
}
try {
  if (command === 'baseline') console.log(JSON.stringify(rollout.captureBaseline(pipelineDir, { from: arg('from'), until: arg('until') }), null, 2));
  else if (command === 'baseline-rebotes') console.log(JSON.stringify(rollout.captureReboundBaseline(pipelineDir, config, { from: arg('from'), until: arg('until') }), null, 2));
  else if (command === 'status') {
    let escalones = 'ok';
    try { rollout.validateWaves(config, actores); } catch (e) { escalones = e.message; }
    console.log(JSON.stringify({ escalones, rebotes_medibles_desde: rollout.reboundSince(pipelineDir),
      ...rollout.readState(pipelineDir) }, null, 2));
  }
  else if (command === 'validate') { rollout.validateWaves(config, actores); console.log('escalones válidos'); }
  else if (command === 'enable') console.log(JSON.stringify(rollout.enablePair(pipelineDir, arg('actor'), arg('provider'), config, { actor: arg('by'), dispatchableActors: actores }), null, 2));
  else if (command === 'evaluate') {
    const { notifyTelegram } = require('./lib/notify-telegram');
    console.log(JSON.stringify(rollout.evaluateEnabled(pipelineDir, config, { from: arg('from'), until: arg('until'), notify: notifyTelegram }), null, 2));
  }
  else if (command === 'reenable') console.log(JSON.stringify(rollout.reenablePair(pipelineDir, arg('actor'), arg('provider'), arg('by')), null, 2));
  // `preview` responde, sin spawnear nada, "que comando y que env le tocarian a
  // este actor hoy". Usa exactamente la misma decision que el launcher
  // (`model-propagation.plan`): mismo canal, mismo saneo por whitelist y misma
  // validacion de catalogo. Sirve para verificar los dos extremos del contrato:
  // con el par apagado los `args` salen byte-identicos a los de entrada, y con
  // el par encendido se ve el canal real (`--model` en argv, o la env var del
  // provider) y la traza que va a quedar en el log del spawn.
  else if (command === 'preview') {
    const actor = arg('actor'); const provider = arg('provider');
    if (!actor || !provider) throw new Error('preview requiere --actor y --provider');
    const { readAgentModels } = require('./lib/agent-launcher/resolve-provider');
    const resolution = { provider, model: arg('model') || resolveProviderModel(actor, provider) };
    const base = ['-p', '<prompt>'];
    const out = rollout.applyToSpawn(pipelineDir, actor, resolution, base, {}, {
      config: fullConfig, agentModels: () => readAgentModels(pipelineDir),
    });
    console.log(JSON.stringify({
      actor, provider, modelo_declarado: resolution.model,
      encendido: rollout.shouldPropagate(pipelineDir, actor, provider),
      args_entrada: base, args_salida: out.args, env_agregado: out.env,
      propagado: out.propagated,
      canal: out.plan ? out.plan.target : null,
      motivo_rechazo_modelo: out.plan ? out.plan.rejectedReason : null,
      error_de_config: out.plan ? out.plan.configError : null,
      traza: out.plan ? out.plan.trace : null,
    }, null, 2));
  }
  else throw new Error('uso: model-rollout.js baseline|baseline-rebotes|status|validate|enable|evaluate|reenable|preview [opciones]');
} catch (e) { console.error(e.message); process.exitCode = 1; }
