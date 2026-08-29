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
  else throw new Error('uso: model-rollout.js baseline|baseline-rebotes|status|validate|enable|evaluate|reenable [opciones]');
} catch (e) { console.error(e.message); process.exitCode = 1; }
