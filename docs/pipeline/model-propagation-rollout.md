# Rollout de propagación de modelos

Este control apaga o enciende la **propagación de modelo** por par actor/proveedor. No es el kill-switch de despacho: un rollback mantiene al proveedor recibiendo agentes, pero sin el modelo declarado.

## Encendido

1. Congelar una sola vez el baseline: `node .pipeline/model-rollout.js baseline --from <ISO> --until <ISO>`.
2. Consultarlo con `node .pipeline/model-rollout.js status` y comprobar al menos 30 corridas por par.
3. Encender explícitamente: `node .pipeline/model-rollout.js enable --actor po --provider anthropic --by <operador>`.
4. Observar al menos 20 corridas. Los escalones declarados en `config.yaml` son `po`, luego `guru/ux/architect`, y finalmente los devs pesados. Se eligieron actores con telemetría real; `sherlock` no es un actor del dispatcher.
5. Evaluar la ventana con `node .pipeline/model-rollout.js evaluate --from <ISO> --until <ISO>`. Sólo una evaluación sana con muestra suficiente habilita el escalón siguiente.

## Umbrales y rollback

La evaluación requiere 20 corridas. Un delta absoluto mayor a 10 puntos porcentuales en rebotes o muertes tempranas atribuibles al agente dispara rollback. Las muertes `provider-death` se excluyen. El evento se audita en `logs/model-propagation-rollout-audit.jsonl` y la notificación identifica par, métrica, baseline, observado, muestra y ventana.

El rollback sólo cambia el flag del par; nunca llama a `provider-disabled.js`.

## Reencendido

La recuperación de métricas no reenciende nada. Después de diagnosticar la causa, un humano ejecuta:

`node .pipeline/model-rollout.js reenable --actor <actor> --provider <provider> --by <operador>`

La identidad, hora y par quedan registrados de forma append-only.
