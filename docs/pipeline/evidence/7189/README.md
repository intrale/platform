# Evidencia del ensayo en seco del cutover del estado operativo — #7189

Ensayo ejecutado el **2026-09-14** desde la rama `agent/7189-pipeline-dev`
(base `origin/main @ fe48aefe0`, post-merge de #5113), **con el flag
`operational_state.durable` APAGADO** y sin tocar `.pipeline/config.yaml`.
Todo lo que corrió contra AWS real fue **de sólo lectura o idempotente**, con la
identidad del runtime (`kernel.runtimePrincipal`, perfil `kernel.runtimeProfile`),
y toda salida pasó por `redactAll` (secretos + account-ids). Los flips, el
`apply` contra AWS, el R8 medido y el aborto en ventana real **no ocurrieron
acá**: son de la hija H0 (#7194), con gate humano.

La herramienta es `node .pipeline/scripts/opstate-cutover-probe.js <subcomando>`
(runbook `docs/pipeline/runbook-cutover-estado-operativo.md` §10). Las corridas
contra el host del pipeline se lanzaron con `--pipeline-dir <host>/.pipeline`
para leer el estado real (`waves.json`, `.partial-pause.json`, audit) desde el
worktree del agente; el `pipelineDir` que figura en cada JSON es ése.

| Archivo | Qué es | Comando | Contra | Veredicto |
|---|---|---|---|---|
| `preconditions.json` | CA-1 · sonda de precondiciones (CA-B1, CA-B2, CA-B3, CA-B5, D-9, `describeMode`) | `--preconditions --json --pipeline-dir <host>/.pipeline` | AWS real (`sts get-caller-identity`), audit local, `--status` del migrador de namespace. **Sólo lectura.** | **ROJO — diagnóstico esperado**: `CA-B1` `strict_auth_apagado` (grace mode vigente, D-10 → H0 paso 0) y `CA-B5` `namespaceado_apagado` (`migrated:false`, layout plano → H0 paso 1). CA-B2 y CA-B3 en verde. |
| `cas-probe.json` | CA-2 · sonda del CAS contra la tabla real | `--cas-probe --json --pipeline-dir <host>/.pipeline` | AWS real, `driver.kind = aws-cli-sync`. **Idempotente**: escribe sólo `coord#opstate-cas-probe` por `compareAndSet`. | **VERDE**: 1ª escritura `v1→v2` (la primera corrida del día creó `v1`), 2ª con la misma `expectedVersion` ⇒ `conflict:true`, readback `get-item --consistent-read` coincide (versión + sha256). |
| `positive-probe.json` | CA-3 · sonda positiva por dos caminos | `--positive --json --pipeline-dir <host>/.pipeline` | AWS real. **Sólo lectura** (camino A: backend con `PIPELINE_OPSTATE_DURABLE=1` en el proceso; camino B: `get-item --consistent-read`). | **ROJO con causa `estado_vacio`** por los dos caminos y las dos claves: la tabla no tiene `coord#waves` ni `coord#partial-pause` para `intrale-platform` porque nada migró todavía. Es la evidencia de fail-closed sobre vacío que pide CA-3 (como #5208 §8). El verde con estado sembrado y los negativos (hash distinto, `in-memory`, degradación) están en la suite. |
| `migration-dry-run.txt` | CA-4 · dry-run del migrador contra las fuentes reales | `--migration-dry-run --pipeline-dir <host>/.pipeline` | Filesystem del host. **No toca el store**; escribe un backup timestampeado bajo `<host>/.pipeline/backup/` (gitignored). | **VERDE**: `olas: 12 · allowlist: 54`, backup verificado contra su propio `manifest.json` (sha256 + conteo). `apply` **no** se ejecutó contra AWS (D-4): está probado contra el fake en la suite (paridad + `integrity_mismatch`). |
| `export-drill.txt` | CA-5 · export store→FS | `--export-to-fs --pipeline-dir <host>/.pipeline` | Host real **sin** `.paused`. | **ROJO `freno_ausente`**, como corresponde: se niega **antes** de leer el store y dice el comando exacto para frenar. El camino verde (con `.paused`, estado sembrado, conteos y sha256 FS = store, R8 `avance perdido: 0`) está en la suite contra el fake, listado al pie del archivo. |
| `abort-drill.txt` | CA-6 · ensayo del aborto con el sink real | `--abort-drill --window true` / `'"true"'` / `1` / `absent` / sin `--window` | Sandbox temporal (`mkdtemp`, se borra al terminar). Sink real `createDegradationSink` + `halt` inyectado; **no envía Telegram**; nunca toca el `.pipeline/.paused` real. | `true (boolean)` ⇒ **VERDE**: `.paused` en disco con `source: kernel-cutover-degraded-halt`, sin `process.exit`, sin `throw`, sin fallback. `"true"` / `1` / ausente / `false` (config) ⇒ **ROJO `ventana_cerrada`** con literal **y tipo**, y sin `.paused` (SEC-4). |
| `tests.txt` | CA-7 · suite nueva + regresión §8.4 + lints | ver archivo | Driver fake; sin AWS. | 62 tests de la sonda (uno por causa `[FALLA]`), regresión 680/680 **sin editar un test existente**, `operational-state-lint` 0 violaciones, `test-env-lint` 0 nuevas. |
| `tests-final.txt` | CA-7 · re-corrida de la suite con la evidencia ya escrita | `node --test .pipeline/lib/__tests__/opstate-cutover-probe-7189.test.js` | — | 62/62. |
| `redaction-check.txt` | SEC-7 · chequeo de redacción de esta carpeta y del runbook | `grep -nE "[0-9]{12}\|arn:aws[:]\|AKIA[0-9A-Z]{16}\|ASIA[0-9A-Z]{16}" …` | — | Vacío (el comando está arriba del resultado para que "vacío" pruebe algo). |

## Lo que esta evidencia NO acredita

- Que el estado operativo esté encendido, migrado o leyéndose del store: **no lo está**
  (`describeMode()` ⇒ `mode: fs · source: config`; `preconditions.json` lo registra).
- Multi-instancia (CA-C6): fuera de alcance (D-6 → #7198 y sus prerrequisitos
  #7195, #7196, #7197).
- R8 medido en minutos ni fase completa post-flip: son de H0 (#7194).

## Nota sobre la clave de sonda del CAS

`coord#opstate-cas-probe` queda en la tabla (un ítem chico; cada corrida
incrementa `body.version`). El store no borra claves conocidas por diseño; si el
operador quiere purgarla, es la purga manual excepcional documentada en
`docs/pipeline/kernel-tablas-cutover-5210.md` §"Purga manual", nunca desde la sonda.
