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
