#!/usr/bin/env node
'use strict';
const rollout = require('./lib/model-propagation-rollout');
const configResolver = require('./lib/config-resolver');
const pipelineDir = __dirname;
const argv = process.argv.slice(2); const command = argv.shift();
const arg = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const config = (configResolver.resolve({ pipelineDir }).model_propagation_rollout || {});
try {
  if (command === 'baseline') console.log(JSON.stringify(rollout.captureBaseline(pipelineDir, { from: arg('from'), until: arg('until') }), null, 2));
  else if (command === 'status') console.log(JSON.stringify(rollout.readState(pipelineDir), null, 2));
  else if (command === 'enable') console.log(JSON.stringify(rollout.enablePair(pipelineDir, arg('actor'), arg('provider'), config, { actor: arg('by') }), null, 2));
  else if (command === 'evaluate') {
    const { notifyTelegram } = require('./lib/notify-telegram');
    console.log(JSON.stringify(rollout.evaluateEnabled(pipelineDir, config, { from: arg('from'), until: arg('until'), notify: notifyTelegram }), null, 2));
  }
  else if (command === 'reenable') console.log(JSON.stringify(rollout.reenablePair(pipelineDir, arg('actor'), arg('provider'), arg('by')), null, 2));
  else throw new Error('uso: model-rollout.js baseline|status|enable|evaluate|reenable [opciones]');
} catch (e) { console.error(e.message); process.exitCode = 1; }
