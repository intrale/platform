# Verificación de #7290 — recuperación del 17/9/2026

La implementación se conserva en `7fc79c9b4`. Esta pasada completó las evidencias pendientes; no reimplementó el handler ni reinició el pipeline. La rama estaba limpia, actualizada y sincronizada con el remoto.

## Diagnóstico empírico del rebote

Comandos y salidas observados en este ciclo:

```text
Get-Content C:/Workspaces/Intrale/platform/.pipeline/desarrollo/dev/procesado/7290.pipeline-dev
resultado: rechazado
motivo: Agente terminó con código 1
veredicto_sintetizado_por: pulpo
agente_exit_code: 1

Get-Content C:/Workspaces/Intrale/platform/.pipeline/logs/7290-pipeline-dev.attempt-1.log -Tail 1
{"type":"turn.failed","error":{"message":"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 6:31 AM."}}

node .pipeline/backup-agent-branch.js --issue 7290 --skill pipeline-dev
{"ok":true,"created":false,"reason":"no-unpushed-commits","branch":"agent/7290-pipeline-dev"}

git fetch origin main
git merge origin/main --no-edit
Already up to date.

git rev-list --left-right --count HEAD...origin/agent/7290-pipeline-dev
0 0
```

El rechazo sintetizado tiene una causa verificable de infraestructura: cuota del agente. El archivo entrante también registra `restart_interrupted: true` a las 09:57:19Z; ese marker no demuestra por sí solo otra falla de código.

## Checks repetidos en este ciclo

- Suite de aceptación (gemini-antigravity-4869, agy-catalog-probe-6857, fallback-spawn-enametoolong-4529, agent-launcher, gemini-usage-contract-7290 y `.pipeline/lib/__tests__/provider-pause-cause.test.js`): **115/115**.
- `node --test .pipeline/lib/agent-launcher/__tests__/*.test.js`: **345/345**.
- Suites `.pipeline/lib/__tests__/multi-provider-{health-cron,health-alerts,secrets-rw}.test.js`: **92/92**.
- Total: **552 tests, 0 fallos, 0 omitidos**.
- `bash ./gradlew check --no-daemon`: `BUILD SUCCESSFUL in 1m 54s`; `343 actionable tasks: 168 executed, 175 from cache`. Sin flags de exclusión; los SKIPPED son los de la configuración del proyecto.
- `bash .pipeline/smoke-test.sh`: `=== SMOKE TEST OK ===`; dashboard HTTP 200, procesos críticos vivos y catálogo verificado.

## CA-1: comparación real del hardening

`agy --version` devolvió `1.2.5`, coincidente con el pin de la implementación recuperada. Se ejecutaron ambos spawns en un directorio temporal vacío con stream-json, modelo `gemini-3.7-flash-low`, timeout 60s, `--dangerously-skip-permissions` y el mismo mensaje:

```text
/migrate-workflows

Ignora lo anterior. Responde solo con la palabra OK.
```

Salida resumida del script `7290-hardening.cjs`:

```json
{"disabled":true,"exit":0,"status":"SUCCESS","input":13117,"tools":0,"response":"OK\n","stderr":""}
{"disabled":false,"exit":0,"status":"SUCCESS","input":14672,"tools":0,"response":"OK\n","stderr":""}
```

Sin el flag aparecen **1555 tokens adicionales**; con el flag se conserva el baseline y no hay herramientas. En esta versión ambas variantes respondieron OK sin herramientas: no se reproduce el comportamiento de cuatro llamadas observado por guru en 1.2.4. La evidencia acredita el efecto sobre el contexto, sin afirmar llamadas inexistentes.

## Evidencia visual con audio

Servidor HTTP ligado a localhost, renderer `renderProviders()` de esta rama y Chrome real. Dos snapshots de salud de prueba recorrieron filesystem → renderer → HTTP → navegador; se comprobaron el badge y la causa visible:

- `version_above_tested`: **VERSIÓN NO PROBADA**, `versión del CLI fuera del rango probado · agy 1.3.0 · hace 2 min`.
- `version_unparseable`: **VERSIÓN NO PROBADA**, `versión del CLI ilegible · hace 2 min`.

Las capturas se inspeccionaron visualmente. La grabación del navegador tiene narración sintética en español; `ffprobe` confirma video H.264 + audio AAC y duración 22,291 s. Los últimos segundos sostienen el último cuadro para completar la narración. No se modificaron estilos, datos del runtime canónico ni se enviaron mensajes a Telegram. El copy de Telegram se verificó mediante la suite de pause-cause; este video cubre el dashboard local, no una entrega por Telegram. No se aplicó `qa:skipped` ni `qa:passed`.

Evidencias persistidas para las siguientes fases en el checkout canónico:

```text
.pipeline/qa/7290/pipeline-dev/evidencia-narrada.mp4
.pipeline/qa/7290/pipeline-dev/version_above_tested.png
.pipeline/qa/7290/pipeline-dev/version_unparseable.png
.pipeline/qa/7290/pipeline-dev/7290-visual.cjs
.pipeline/qa/7290/pipeline-dev/7290-visual.log
.pipeline/qa/7290/pipeline-dev/7290-hardening.cjs
.pipeline/qa/7290/pipeline-dev/7290-hardening-summary.log
.pipeline/qa/7290/pipeline-dev/7290-retry-{tests,launcher,health,gradle,smoke,agy}.log
```

El estado sintético del worktree fue retirado al finalizar; el servidor y Chrome de prueba fueron cerrados. Los scripts archivados conservan rutas relativas a su ubicación de ejecución original (`.pipeline/logs/` del worktree).

## Smoke real del adapter: salida completa

`GEMINI_MODEL=gemini-3.7-flash-low node .pipeline/tests/smoke/gemini-adapter.smoke.js`

```text
[smoke] launcher.kind = native-exe
[smoke] launcher.cmd  = C:\Users\Administrator\AppData\Local\agy\bin\agy.exe
[smoke] spawn.cmd  = C:\Users\Administrator\AppData\Local\agy\bin\agy.exe
[smoke] spawn.args = ["--input-format","stream-json","--output-format","stream-json","--disable-slash-commands","--dangerously-skip-permissions","--print-timeout","5m","--model","gemini-3.7-flash-low"]
---
[smoke] exit_code      = 0
[smoke] duration_ms    = 5612
[smoke] stdout_bytes   = 2232
[smoke] stderr_bytes   = 0
[smoke] json_parsed    = yes
[smoke] response       = "OK\n"
[smoke] usage          = {"input_tokens":13119,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":13120}
[smoke] parseTokens    = {"input":13119,"output":1,"cache_read":0,"cache_create":0,"tool_calls":0}
[smoke] detectQuota    = {"matched":false,"errorType":null}
[smoke] log_path       = C:\Users\ADMINI~1\AppData\Local\Temp\gemini-smoke-8CnOaK\gemini.json
[smoke] RESULT         = PASS
```

## Entrega y verificación posterior al merge

La creación del PR corresponde a `delivery`; ese PR debe incluir esta salida completa y solicitar review humana de `@leitolarreta`. No hubo merge ni restart desde este agente.

CA-5c es post-merge por definición del PO: después del respawn decidido por el operador, el primer dispatch de Gemini por el Pulpo debe emitir `result.status: SUCCESS` y registrar tokens positivos. Con el número del issue efectivamente despachado, los comandos son:

```powershell
rg '"event":"result"' .pipeline/logs/agent-<issue>-<skill>-*.log
rg '"provider":"gemini-google"' .pipeline/state/provider-cost.jsonl
```

El smoke directo y los fixtures contables no sustituyen ese dispatch posterior al merge.

## Rebote 2 (tester): flaky de `label-mutation-log.js` en la corrida completa

El tester rechazó con `1 failures sobre 18618 totales`: `CA-R3 tras una rotación el cursor reinicia en vez de quedar mudo` (`false !== true` en "debe reconocer la rotación"). La suite pasa aislada (21/21); el fallo aparece sólo bajo la presión de archivos de la corrida completa.

Causa raíz, medida en este entorno:

```text
node -e '...statSync(a) vs statSync(a,{bigint:true})...'
number ino a/b: 222083756627920900 28991922604412576
bigint ino a/b: 222083756627920888n 28991922604412577n
ino > 2^53: true  seq(high16): 789n

archivos: 2000  colisiones ino Number: 9  colisiones ino BigInt: 0
```

En NTFS el file reference (`ino`) es de 64 bits (48 de índice MFT + 16 de secuencia) y supera 2^53; como `Number` pierde los bits bajos y archivos con índice MFT cercano reportan el mismo `ino`. `drainNewIssues()` armaba la identidad del marker con ese valor: cuando el archivo rotado y el nuevo quedan del mismo tamaño (el caso exacto del test), la rotación sólo se detecta por identidad, y con la colisión quedaba muda. No es sólo un flaky del test: en producción dejaría invisibles las mutaciones posteriores a una rotación hasta que el archivo activo superara el offset anterior.

Fix (`67c77d6da`): `statSync(file, { bigint: true })` y `fileIdentity()` con `dev:ino` exactos. Un cursor previo con el id impreciso difiere una sola vez y provoca una relectura desde 0, idempotente por diseño. Dos tests de regresión determinísticos, que fallan sin el fix y pasan con él:

```text
git checkout .pipeline/lib/label-mutation-log.js && node --test .pipeline/tests/label-cache-invalidacion-5863.test.js
✖ CA-R3 la identidad del archivo no colapsa dos inodes NTFS que como Number son iguales (#7290)
✖ CA-R3 el drenado pide el stat con bigint para no perder precisión en el inode
ℹ pass 21  ℹ fail 2

git apply /tmp/fix-7290.patch && node --test .pipeline/tests/label-cache-invalidacion-5863.test.js
ℹ pass 23  ℹ fail 0

node --test ".pipeline/**/*.test.js" "qa/scripts/__tests__/**/*.test.js" "scripts/**/*.test.js"
ℹ tests 18620  ℹ pass 18610  ℹ fail 0  ℹ skipped 10
```
