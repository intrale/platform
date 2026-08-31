# Rollout de propagación de modelos

Este control apaga o enciende la **propagación de modelo** por par actor/proveedor. No es el kill-switch de despacho: un rollback mantiene al proveedor recibiendo agentes, pero sin el modelo declarado.

## Encendido

1. Validar que todos los escalones nombren actores despachables: `node .pipeline/model-rollout.js validate`.
2. Congelar una sola vez el baseline: `node .pipeline/model-rollout.js baseline --from <ISO> --until <ISO>`.
3. Consultarlo con `node .pipeline/model-rollout.js status` y comprobar al menos 30 corridas **medibles** por par. Una tasa de rebotes `null` indica que el productor todavía no cubría esa ventana.

   Sólo cuenta como corrida la fila de `spawn-exit-*.jsonl` que trae `exit_code` **y** `duration_ms` como números finitos. Una fila a la que le falta alguno de los dos no se interpreta: se descarta entera y **no** suma a `n`, que es la muestra contra la que se miden `baseline_min_runs` y `evaluation_min_runs`. El `status` muestra `n` (medibles), `nRaw` (vistas) y `nUnmeasurable` (descartadas); si `nUnmeasurable` es alto, el encendido se demora, que es la dirección correcta. El motivo es que un `exit_code` ausente aparece justo cuando el proceso murió sin devolver código: contarlo como `0` lo convertía en un éxito y sesgaba el baseline hacia arriba de forma permanente, porque el baseline se congela.
4. Cuando el productor haya acumulado una ventana suficiente, completar solamente esa métrica: `node .pipeline/model-rollout.js baseline-rebotes --from <ISO> --until <ISO>`. El `--from` debe ser igual o posterior a `rebotes_medibles_desde`, mostrado por `status`.
5. Encender explícitamente: `node .pipeline/model-rollout.js enable --actor guru --provider anthropic --by <operador>`.
6. Observar al menos 20 corridas medibles. Los escalones declarados en `config.yaml` contienen sólo skills que el pulpo despacha: `guru, security`; luego `po, ux, architect, planner`; después `review, tester, qa`; finalmente los devs `backend-dev, pipeline-dev, android-dev, web-dev, dev`.

   La barrera para abrir el escalón siguiente es por proveedor y exige **todos** los actores, no alguno: cada actor del escalón tiene que estar encendido en ese proveedor **y** haber sido evaluado como sano en la misma pasada de evaluación. Alcanza con que uno esté sin encender, en `deferred` por muestra insuficiente o en rollback para que el escalón no genere evidencia y el siguiente quede cerrado. La evidencia además se recalcula en cada evaluación y se borra si deja de cumplirse, así que no queda "ganada" de una corrida anterior.
7. Cada salida de un agente ejecuta automáticamente la evaluación desde el instante de encendido. El comando `node .pipeline/model-rollout.js evaluate --from <ISO> --until <ISO>` queda disponible para diagnóstico manual; no es necesario para que ocurra el rollback.

## Umbrales y rollback

La evaluación requiere 20 corridas. Un delta absoluto mayor a 10 puntos porcentuales en rebotes o muertes tempranas atribuibles al agente dispara rollback. Las muertes `provider-death` y los rebotes de infraestructura se excluyen. Cada rebote de código se atribuye al actor que vuelve a correr, no al evaluador que emitió el rechazo. La comparación de rebotes queda desarmada mientras alguno de sus lados sea `null`. El evento se audita en `logs/model-propagation-rollout-audit.jsonl` y la notificación identifica par, métrica, baseline, observado, muestra y ventana.

El rollback sólo cambia el flag del par; nunca llama a `provider-disabled.js`.

## Reencendido

La recuperación de métricas no reenciende nada. Después de diagnosticar la causa, un humano ejecuta:

`node .pipeline/model-rollout.js reenable --actor <actor> --provider <provider> --by <operador>`

La identidad, hora y par quedan registrados de forma append-only.

## Cómo se aplica el modelo (una sola frontera)

El rollout **no** aplica el modelo por su cuenta: aporta la **precondición** y delega toda la decisión en `lib/model-propagation.js`, que es la misma frontera que usa el camino de #6272. Concretamente:

- El pulpo inyecta un gate `(actor, provider) → boolean` en `launchAgent` (`modelRolloutGate`), respaldado por `shouldPropagate()`.
- El launcher lo evalúa contra el proveedor **efectivo** (ya resuelto el fallback de la cadena) y lo pasa a `modelPropagation.plan({ …, rolloutEnabled })`.
- `plan()` resuelve el canal (`--model` en argv para los proveedores del launcher `claude`; la env var de `PROVIDER_MODEL_ENV` para el resto), sanea el id con la whitelist estricta (`sanitizeModelId`, SR-A.1) y lo cruza contra el catálogo de modelos permitidos.

Consecuencias operativas:

- Un id de modelo con metacaracteres **nunca** llega al argv, ni siquiera por la vía del rollout. `detectLauncher` puede devolver `shell:true` (tiers cmd-shim y path-fallback), y ahí un metacaracter escalaría a `cmd.exe`; la whitelist existe exactamente para ese argv y ahora también la atraviesa el rollout.
- Los proveedores del canal argv salen de `ARG_MODEL_PROVIDERS` y los del canal env de `PROVIDER_MODEL_ENV`; el rollout ya no mantiene una tabla propia que pudiera driftear.
- Encender el mismo par en el rollout y en `pipeline.model_propagation` agrega `--model` **una sola vez**: es una decisión única, no dos canales.
- `launchResult.modelPropagation` refleja también las propagaciones originadas en el rollout (`modeSource: 'rollout-pair'`), así que el log del spawn no queda mudo.
- Precedencia: el flag por par **gana** sobre `pipeline.model_propagation`. Es deliberado — esa sección es el interruptor grueso y está apagada por default; si no ganara el par, encender un escalón obligaría a abrir la propagación para todos, que es justo lo que el rollout escalonado viene a evitar. El apagado del rollout es su propio flag por par más el rollback automático.

### Providers sin canal de modelo

`enable` **rechaza** un par cuyo proveedor no declara canal de modelo, con error explícito. Encenderlo sería un no-op silencioso: el par figuraría activo en `status`, consumiría evidencia de escalón y podría comerse un `auto_rollback` con notificación de Telegram sin haber propagado un solo modelo. Si aparece un proveedor nuevo, primero se le declara el canal (`ARG_MODEL_PROVIDERS` o `PROVIDER_MODEL_ENV`) y recién después se lo enciende.

### Verificar antes de encender

`preview` responde, sin spawnear nada, qué comando y qué env le tocarían a un actor hoy — usando la misma decisión que el launcher:

```
node .pipeline/model-rollout.js preview --actor guru --provider anthropic
```

Devuelve `args_entrada` / `args_salida` (con el par apagado son idénticos), `env_agregado`, el `canal` resuelto, el `motivo_rechazo_modelo` si la whitelist lo cortó y la `traza` que va a quedar en el log del spawn.
