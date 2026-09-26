# Revalidación del rebote 2 — #7595

El rechazo sigue vigente. La causa del bloqueo funcional es la falta de operación humana y cierre de seguridad, no un defecto demostrado del verificador. Se conserva la implementación previa. Backup: no-unpushed-commits; fetch/merge: Already up to date.

## CA-1/CA-4: estado remoto observado en este ciclo

Comando: gh repo list intrale --limit 100 --json name,visibility,isArchived

```json
[{"isArchived":false,"name":"platform","visibility":"PUBLIC"},{"isArchived":false,"name":"kernel","visibility":"PRIVATE"},{"isArchived":false,"name":"repo","visibility":"PUBLIC"},{"isArchived":false,"name":"codex","visibility":"PUBLIC"},{"isArchived":false,"name":"backend","visibility":"PUBLIC"},{"isArchived":false,"name":"users","visibility":"PUBLIC"},{"isArchived":false,"name":"app","visibility":"PUBLIC"},{"isArchived":false,"name":"intrale-back-test","visibility":"PUBLIC"},{"isArchived":false,"name":"back-core","visibility":"PUBLIC"},{"isArchived":false,"name":"kotlin-multiplatform-example","visibility":"PUBLIC"},{"isArchived":false,"name":"intrale-mobile-mercadopago","visibility":"PUBLIC"},{"isArchived":false,"name":"intrale-delivery","visibility":"PUBLIC"},{"isArchived":false,"name":"intrale-files","visibility":"PUBLIC"},{"isArchived":false,"name":"intrale-products","visibility":"PUBLIC"},{"isArchived":false,"name":"intrale-users","visibility":"PUBLIC"},{"isArchived":false,"name":"intrale-test","visibility":"PUBLIC"},{"isArchived":false,"name":"intrale-commons","visibility":"PUBLIC"},{"isArchived":false,"name":"intrale-core","visibility":"PUBLIC"},{"isArchived":false,"name":"intrale-mobile","visibility":"PUBLIC"},{"isArchived":false,"name":"intrale-arq-ms","visibility":"PUBLIC"},{"isArchived":false,"name":"intrale-notifications","visibility":"PUBLIC"},{"isArchived":false,"name":"intrale-parent","visibility":"PUBLIC"},{"isArchived":false,"name":"intrale-web","visibility":"PUBLIC"}]
```

Comando: node .pipeline/lib/verify-repo-post-change.js --repo intrale/codex --visibility public --archived true --profile legacy

Salida del control: {"name":"archived","ok":false,"evidence":false}; resultado global: {"ok":false}. El rechazo es correcto: codex todavía no está archivado.

## CA-3: reescaneo con refs actualizadas

Por cada uno de los tres mirrors: git -C <mirror> fetch origin --prune; gitleaks git <mirror> --log-opts=--all --redact=100 --ignore-gitleaks-allow --gitleaks-ignore-path <directorio externo> --config <directorio externo>/scan.toml --timeout 180 --report-format json --report-path <repo>-rebote-2-redacted.json --no-banner.

Directorio externo: %TEMP%/intrale-7595-scan. Salida real resumida sin secretos:

```json
{"exitCode":1,"findings":2,"repo":"users","rules":["generic-api-key","jwt"]}
{"exitCode":1,"findings":8,"repo":"intrale-mobile","rules":["gcp-api-key","generic-api-key"]}
{"exitCode":1,"findings":1,"repo":"intrale-notifications","rules":["private-key"]}
```

La persistencia en historial no prueba vigencia de credenciales. El issue no contiene evidencia nueva de triage, rotación o revocación: su último comentario leído es https://github.com/intrale/platform/issues/7595#issuecomment-5808211197. No se prueban credenciales expuestas ni se publican valores.

## Retiro de workflows y operación humana

Comando: gh api repos/intrale/users/actions/workflows --jq '.workflows[] | {name,state}'

```json
{"name":"CI users","state":"active"}
```

El body y la validación del PO reservan la operación al owner humano (CA-2/CA-7). No consta una nueva aceptación de retiro de workflows/consumidores. El runbook ya contiene la secuencia por repo y las precondiciones. gh issue view 7595 --json projectItems confirma Status Blocked.

## Exit 1 anterior

Se leyó el final de 7595-pipeline-dev.attempt-1.log: el último command_execution registró exit_code 0 y luego turn.completed. Esto no permite atribuir el exit 1 del proceso exterior a un error de código. No se modifica el runtime sin causa demostrada.

## Validación local

node --test .pipeline/tests/verify-repo-post-change.test.js .pipeline/hooks/__tests__/screenshots-mockup-gate.test.js

```text
tests 42
pass 42
fail 0
skipped 0
exit 0
```

Git Bash explícito: C:/Program Files/Git/bin/bash.exe .pipeline/smoke-test.sh

```text
pulpo: OK 8184
dashboard: OK 21268
svc-telegram: OK 21192
OK dashboard HTTP 200
WARN last-restart.json tiene 53090s (esperado < 300)
=== SMOKE TEST OK ===
```

Sin reinicio. Resultado rechazado, gravedad grave, rebote_categoria human_block: faltan resolución documentada de hallazgos, aceptación del retiro y archivado humano con verificación posterior.

Comando: C:/Program Files/Git/bin/bash.exe ./gradlew check --no-daemon

```text
BUILD SUCCESSFUL in 1m 19s
366 actionable tasks: 12 executed, 354 up-to-date
exit 0
```

Sin exclusiones agregadas. Las tareas SKIPPED por configuración existente no acreditan E2E.
