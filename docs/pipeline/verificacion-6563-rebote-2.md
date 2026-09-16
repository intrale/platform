# Verificación de #6563 — rebote 2

El bloqueo de CA-6 es de integración y operación. Esta pasada no encontró un
nuevo defecto de código que explique la falta de arranque del commit integrado.
La baja existente no se reimplementó.

Evidencia ejecutada el 2026-09-16:

```text
$ node .pipeline/backup-agent-branch.js --issue 6563 --skill pipeline-dev
{"ok":true,"created":false,"reason":"no-unpushed-commits","branch":"agent/6563-pipeline-dev"}
$ git fetch origin main; git merge origin/main --no-edit
Already up to date.
$ git rev-parse HEAD origin/main origin/agent/6563-pipeline-dev
e4d99f8c84560ccf60e5b976eec4c4d18a6a8d13
009fcf5e1bd5bc2616b3d00abb24a457fe2fe6d5
e4d99f8c84560ccf60e5b976eec4c4d18a6a8d13
$ git merge-base --is-ancestor HEAD origin/main
integrado_en_main_exit=1
$ gh pr list --head agent/6563-pipeline-dev --state all --json number,url,state,reviewDecision,headRefOid
[]
$ git -C C:/Workspaces/Intrale/platform rev-parse HEAD
009fcf5e1bd5bc2616b3d00abb24a457fe2fe6d5
$ Get-Content C:/Workspaces/Intrale/platform/.pipeline/last-restart.json
{"timestamp":"2026-09-16T09:59:29.511Z","pid":7648}
$ node .pipeline/lib/agent-models-validate.js
[validate] OK .pipeline\agent-models.json
$ node .pipeline/lib/multi-provider/validate-chains.js
[validate-chains] Cadenas validadas: 23 skills
$ node --test .pipeline/tests/provider-retirement-6563.test.js
tests 2
pass 2
fail 0
$ & 'C:/Program Files/Git/bin/bash.exe' .pipeline/smoke-test.sh
runtime_dir=/c/Workspaces/Intrale/platform/.pipeline
pulpo: OK 11888
dashboard: OK 17420
svc-telegram: OK 13560
OK dashboard HTTP 200
WARN last-restart.json tiene 49104s (esperado < 300)
=== SMOKE TEST OK ===
$ & 'C:/Program Files/Git/bin/bash.exe' ./gradlew check --no-daemon
BUILD SUCCESSFUL in 56s
344 actionable tasks: 11 executed, 333 up-to-date
```

El primer intento con `bash` resolvió el ejecutable de WSL y falló con
`execvpe(/bin/bash) failed: No such file or directory`. La ejecución explícita
con Git Bash completó Gradle y smoke con código 0.

La lectura de las últimas dos entradas de
`C:/Workspaces/Intrale/platform/.pipeline/logs/cross-provider-dispatch-2026-09-16.jsonl`
mostró `primary_inactive_by_schedule` para `pipeline-dev`, issue `6563`, y
`fallback_selected` con `fallback_provider: openai-codex` y
`chain_tried: [anthropic, openai-codex]` (created_at `1789601809108`). Es un
despacho real del runtime anterior; no demuestra CA-6 del commit integrado.

El smoke confirma salud del runtime anterior. No acredita arranque ni despacho
real de la rama: su commit todavía no está integrado en main. Los tests de
plantel y admisión futura son verificaciones locales, no despachos reales.

Precisión respecto del informe anterior: `.github/CODEOWNERS` sólo contiene
comentarios y declara que GitHub no exige aprobación de code owner. La exigencia
de revisión humana proviene del contrato operativo de Pipeline Developer de
esta ejecución, no de una regla activa de ese archivo. El mismo contrato reserva
la creación del PR a delivery y prohíbe el merge automático.

`restart.js` sincroniza main y termina procesos compartidos. Reiniciar ahora
no incorporaría la rama. CA-6 requiere que delivery prepare el PR, que se cumpla
la revisión humana indicada y que se integre el cambio antes del restart seguro
y del registro de una decisión de despacho real con el plantel reducido.

El resultado usa `rebote_categoria: human_block`, reconocido explícitamente por
`.pipeline/lib/rebote-classifier.js`, para distinguir esta dependencia de
integración de un defecto corregible por otra pasada de dev. No modifica el
clasificador, no promueve archivos de fase ni declara CA-6 cumplido.
