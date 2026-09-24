# Revalidación del rebote de infraestructura — 2026-09-24

La implementación previa se conserva. El respaldo devolvió
`{"ok":true,"created":false,"reason":"no-unpushed-commits","branch":"agent/7595-pipeline-dev"}`.
`git fetch origin main` y `git merge origin/main --no-edit` devolvieron
`Already up to date.`. La referencia remota del desarrollo era
`3aa9b44d1f51f8796998b36d57ba042fd47ad5ab`.

## Claim del rebote: «Agente terminó con código 1»

El archivo procesado leído en esta pasada contiene:

```yaml
resultado: rechazado
motivo: Agente terminó con código 1
veredicto_sintetizado_por: pulpo
agente_exit_code: 1
```

Eso confirma el código registrado, no su causa raíz. Los logs disponibles de
pipeline-dev ya contienen eventos del turno actual, por lo que no permiten
atribuir con certeza el cierre anterior a un error concreto. No se modifica el
orquestador por conjetura ni se interpreta un rechazo funcional como éxito.

En esta pasada `bash .pipeline/smoke-test.sh` y `bash ./gradlew check --no-daemon`
fallaron antes de iniciar por resolución del ejecutable:

```text
<3>WSL (10 - Relay) ERROR: CreateProcessCommon:818: execvpe(/bin/bash) failed: No such file or directory
```

`Get-Command bash` devuelve `C:\windows\system32\bash.exe`. Se repitieron ambos
comandos con `C:\Program Files\Git\bin\bash.exe`, sin cambiar configuración global.

## Evidencia empírica de esta pasada

```text
$ node --test .pipeline/tests/verify-repo-post-change.test.js .pipeline/hooks/__tests__/screenshots-mockup-gate.test.js
tests 42
pass 42
fail 0
cancelled 0
skipped 0
exit 0

$ & 'C:\Program Files\Git\bin\bash.exe' .pipeline/smoke-test.sh
pulpo: OK 8184
dashboard: OK 21268
svc-telegram: OK 21192
OK dashboard HTTP 200
WARN last-restart.json tiene 52428s (esperado < 300)
OK [agy-catalog] OK: 6 id(s) configurados y 14 id(s) en total
=== SMOKE TEST OK ===
exit 0

$ node .pipeline/lib/verify-repo-post-change.js --repo intrale/codex --visibility public --archived true --profile legacy
"name": "archived", "ok": false, "evidence": false
"ok": false
exit 1

$ gh api repos/intrale/users/actions/workflows --jq '.workflows[] | {name,state}'
{"name":"CI users","state":"active"}

$ rg -l 'https://[^@/ ]+@github.com' C:\Workspaces\Intrale\platform\.pipeline\logs\rejection-4968-pipeline-dev.html
C:\Workspaces\Intrale\platform\.pipeline\logs\rejection-4968-pipeline-dev.html
```

`gh repo list intrale --limit 100 --json name,visibility,isArchived` devolvió
23 repos: 22 públicos, `kernel` privado y todos con `isArchived:false`.
CA-1/CA-4 siguen sin cumplirse. El issue reserva el archivado al owner humano.
El Project Intrale sigue en `Blocked`; no se cambió su estado.

Se repitió Gitleaks en los tres mirrors existentes con hallazgos, usando
`git <mirror> --log-opts=--all --redact=100 --ignore-gitleaks-allow
--gitleaks-ignore-path <directorio externo> --config <scan.toml> --timeout 180
--report-format json --report-path <reporte externo> --no-banner`:

```text
{"repo":"users","exitCode":1,"findings":2,"rules":["jwt","generic-api-key"]}
{"repo":"intrale-mobile","exitCode":1,"findings":8,"rules":["gcp-api-key","generic-api-key"]}
{"repo":"intrale-notifications","exitCode":1,"findings":1,"rules":["private-key"]}
```

La repetición verifica los mirrors disponibles, no nuevas refs remotas ni
vigencia de credenciales. No acredita rotación o revocación. No se publican
valores. No hay comentarios posteriores del owner que acrediten resolución;
el único comentario posterior al reporte previo anuncia el reintento infra.
La coincidencia de URL tampoco prueba por sí sola una credencial real: queda
pendiente de revisión, sin exponerla ni modificar reportes de otros agentes.

El resultado sigue siendo **rechazado, gravedad grave**: falta resolver CA-3,
aceptar el retiro de workflows/consumidores y ejecutar el archivado humano con
evidencia final. El cierre del agente debe conservar este resultado en
`trabajando/` y terminar normalmente; no corresponde provocar un exit 1 para
comunicar el rechazo.
