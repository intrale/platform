# Issue #6563 — diagnóstico del rebote 3

Verificación realizada el 2026-09-17 sobre `c907bfa41`.

El rechazo sintetizado por el Pulpo informa `agente_exit_code: 1`. El log
de esa misma ejecución identifica un timeout del proveedor NVIDIA NIM, sin
un nuevo informe de auditoría. No hay evidencia de un defecto nuevo del código.

## Evidencia del rechazo

Comando PowerShell:

```powershell
Get-Content -Encoding utf8 C:/Workspaces/Intrale/platform/.pipeline/logs/6563-security.log
```

Output completo:

```text
--- security:#6563 fase:verificacion pipeline:desarrollo intento:1 2026-09-17T14:28:14.265Z ---
{"error":{"status":0,"code":"network_error","message":"NVIDIA NIM request timeout (120s)"}}
```

Se leyeron ambos `agent-models.json` con Node. Resultado:

```text
worktree providers: anthropic, openai-codex, gemini-google, deterministic
worktree security: anthropic -> openai-codex
runtime providers: anthropic, openai-codex, gemini-google, cerebras, nvidia-nim, kimi-moonshot, deterministic
runtime security: anthropic -> openai-codex -> nvidia-nim
```

El runtime canónico conserva el proveedor retirado por esta rama. Cambiar el
código del worktree no modifica ese ruteo activo. No se reinició ni modificó
la configuración de producción, ni se alteraron archivos de otros skills.

El informe `assets/docs/6563/security-verificacion-6563.md` corresponde a la
pasada 2, auditada sobre `aae9902db`; no corresponde al timeout de la pasada 3.

## Verificación de la corrección anterior

```text
$ node --test .pipeline/tests/semantic-dedup-judge-no-agency-6563.test.js
tests 16 / pass 16 / fail 0 / skipped 0
```

Los tests ejecutados verifican rechazo antes del spawn para launchers
`cmd-shim` y `path-fallback` con shell, orden final de `--tools` y su valor
vacío, aislamiento del entorno y directorio temporal, y políticas cerradas.
También verifican que el fiscal conserva el comportamiento previo.

```text
$ node --test .pipeline/tests/agent-launcher.test.js .pipeline/tests/build-child-env.test.js .pipeline/tests/provider-retirement-6563.test.js .pipeline/tests/pulpo-nonanthropic-early-detect.test.js .pipeline/tests/semantic-dedup-judge-no-agency-6563.test.js
tests 118 / pass 118 / fail 0 / skipped 0

$ node .pipeline/lib/agent-models-validate.js
[validate] OK .pipeline\agent-models.json

$ node .pipeline/lib/multi-provider/validate-chains.js
[validate-chains] Cadenas validadas: 23 skills — 2026-09-17T14:48:04.463Z

$ bash .pipeline/smoke-test.sh
pulpo: OK 12684
dashboard: OK 13340
svc-telegram: OK 1916
OK dashboard HTTP 200
WARN last-restart.json tiene 17423s (esperado < 300)
OK [agy-catalog] OK: 4 id(s) configurados y 14 id(s) en total (config + 3 barreras) están en el catálogo de agy (14 modelos)
=== SMOKE TEST OK ===
```

El smoke comprueba el runtime canónico vivo; no demuestra un despliegue de
esta rama. Las pruebas unitarias no sustituyen una auditoría security nueva.
Para cerrar el bloqueo falta reejecutar security sobre el HEAD de esta rama
con un proveedor operativo de la cadena conservada y obtener su informe.

## Verificación Gradle solicitada

```text
$ bash ./gradlew check --no-daemon
BUILD SUCCESSFUL in 2m 18s
343 actionable tasks: 168 executed, 175 from cache
```

Exit code 0. No se agregaron exclusiones de tests. Gradle marcó por su propia
configuración algunas tareas como `SKIPPED` (entre ellas iOS y browser Wasm);
este resultado no equivale a haber ejecutado esas plataformas.
