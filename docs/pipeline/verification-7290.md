# Verificación de #7290 — 17/9/2026

El intento anterior terminó por cuota del agente, conservando los cambios sin commit. En esta pasada se recuperó la implementación y se agregó verificación SSR de la versión fuera de contrato y de la versión ilegible. No se reinició el Pulpo.

## Evidencia del rebote

`Get-Content C:\Workspaces\Intrale\platform\.pipeline\desarrollo\dev\procesado\7290.pipeline-dev`:

```yaml
resultado: rechazado
motivo: Agente terminó con código 1
veredicto_sintetizado_por: pulpo
agente_exit_code: 1
```

Último evento de `7290-pipeline-dev.attempt-1.log`, leído en esta pasada:

```json
{"type":"turn.failed","error":{"message":"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 6:31 AM."}}
```

`node .pipeline/backup-agent-branch.js --issue 7290 --skill pipeline-dev`: `ok: true`, `created: false`, `reason: no-unpushed-commits`.

`git fetch origin main` y `git merge origin/main --no-edit`: `Already up to date.`

## Verificaciones locales

- Suite específica de los CA (4869, 6857, 4529, agent-launcher, 7290, provider-pause-cause): 115/115.
- `node --test .pipeline/lib/agent-launcher/__tests__/*.test.js`: 345/345.
- Suites multi-provider-health-cron, multi-provider-health-alerts y multi-provider-secrets-rw: 92/92.
- Después de extender el render SSR, `node --test .pipeline/tests/agy-catalog-probe-6857.test.js`: 35/35 (incluidos en los 552 tests, no adicionales).
- `./gradlew check --no-daemon`: `BUILD SUCCESSFUL in 1m 24s`; `343 actionable tasks: 168 executed, 175 from cache`. Las tareas que Gradle marca SKIPPED corresponden a la configuración existente; no se pasaron flags de exclusión.
- `bash .pipeline/smoke-test.sh`: `=== SMOKE TEST OK ===`; pulpo, dashboard y Telegram vivos, HTTP 200, catálogo verificado. Advertencia no fatal: last-restart antiguo.
- `agy --version`: `1.2.5`. El pin recuperado acepta hasta esta versión, verificada con el smoke real de abajo.

## Pendientes de aceptación

Falta la comparación real con/sin `--disable-slash-commands` de CA-1 con el vector corregido por guru (slash command al inicio). El smoke simple no demuestra esa comparación.

Falta E2E visual con audio narrado de dashboard/Telegram exigido por las instrucciones operativas actuales del rol. Los tests SSR verifican el copy aprobado por UX, pero no sustituyen esa evidencia. No se aplicó `qa:skipped`.

CA-5c permanece post-merge: dispatch del Pulpo luego de su respawn por el operador, con result SUCCESS y tokens positivos en el libro contable. No fue ejecutado por este agente.

## Smoke real del adapter

`GEMINI_MODEL=gemini-3.7-flash-low node .pipeline/tests/smoke/gemini-adapter.smoke.js`

```text[smoke] launcher.kind = native-exe
[smoke] launcher.cmd  = C:\Users\Administrator\AppData\Local\agy\bin\agy.exe
[smoke] spawn.cmd  = C:\Users\Administrator\AppData\Local\agy\bin\agy.exe
[smoke] spawn.args = ["--input-format","stream-json","--output-format","stream-json","--disable-slash-commands","--dangerously-skip-permissions","--print-timeout","5m","--model","gemini-3.7-flash-low"]
---
[smoke] exit_code      = 0
[smoke] duration_ms    = 6151
[smoke] stdout_bytes   = 2235
[smoke] stderr_bytes   = 0
[smoke] json_parsed    = yes
[smoke] response       = "OK\n"
[smoke] usage          = {"input_tokens":13113,"output_tokens":47,"thinking_tokens":46,"cache_read_tokens":0,"total_tokens":13160}
[smoke] parseTokens    = {"input":13113,"output":47,"cache_read":0,"cache_create":0,"tool_calls":0}
[smoke] detectQuota    = {"matched":false,"errorType":null}
[smoke] log_path       = C:\Users\ADMINI~1\AppData\Local\Temp\gemini-smoke-ka4Gx5\gemini.json
[smoke] RESULT         = PASS

```
