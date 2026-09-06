# Watcher de mergeabilidad de PRs (#4966)

> **Estado:** entregado y **apagado** (`pr_mergeability_watcher.enabled: false`).
> Observa y emite; **no** ejecuta transiciones. El enganche al barrido periódico del
> Pulpo es #4968.

## 1. Qué problema resuelve

Un PR de la ola que queda `CONFLICTING` contra `main` —porque otro PR mergeó
antes y le movió el piso— hoy es **invisible** para el pipeline. El issue se
congela en su fase y sólo se descubre cuando un humano lo mira (escape #4569).

Este módulo detecta ese estado, lo **confirma** con dos observaciones separadas
por un poll real, y deja un **evento candidato** más una **línea de auditoría**
que el operador puede consultar.

## 2. Qué hace y qué NO hace

| Hace | No hace |
|---|---|
| Barre los PRs abiertos del repo | Cerrar, mergear o modificar un PR |
| Confirma el conflicto con dos muestras | Rebotar el issue a `dev` (eso es #4967) |
| Emite un evento tipado | Engancharse solo al Pulpo (eso es #4968) |
| Escribe una línea por decisión en un JSONL | Escribir una identidad humana en ningún artefacto |

El consumidor canónico del evento es
`pipeline-rewind.rewindFromMergeConflict` (#4967, ya en `main`), que además
**revalida el conflicto contra la API dentro de su lock**: el evento del watcher
es una señal, no la última palabra.

## 3. Por qué dos observaciones

GitHub calcula `mergeable` de forma **diferida**. Una consulta `gh pr list`
devuelve `UNKNOWN` y *ceba* el cálculo; el `gh pr view <N>` siguiente lo
resuelve. Un watcher de una sola muestra vería `UNKNOWN` casi siempre → falso
negativo permanente.

De ahí el flujo:

```
gh pr list  (barato, 1 por poll)  →  ceba y barre el universo
        ↓  sólo los sospechosos (no-sanos)
gh pr view <N>                    →  confirma
```

Se emite **sólo si** las dos últimas observaciones cumplen **todas**:

1. ambas conflictivas (`mergeable === CONFLICTING` **o** `mergeStateStatus === DIRTY`),
2. mismo `headRefOid`,
3. `pollSeq` estrictamente creciente, **y**
4. `ts₂ − ts₁ ≥ min_poll_interval_ms`.

> **Reloj no monótono.** El timestamp solo no alcanza: NTP y la suspensión de la
> máquina lo mueven hacia atrás. Por eso se exige **también** el contador
> `pollSeq`, que es monótono y se persiste. Un delta negativo reinicia la
> secuencia (`clock_not_monotonic`) y **nunca** emite.

## 4. Los dos artefactos son distintos (no colapsarlos)

| Artefacto | Para quién | Forma |
|---|---|---|
| **Evento** | `pipeline-rewind.js` (#4967) | Shape **cerrado** de 6 campos: `{source, repo, pr, issue, headRefOid, detected_at}`. Una clave extra es **rechazo** (`EVENT_UNEXPECTED_FIELDS`), no un campo ignorado. |
| **JSONL de auditoría** | El **operador** | `.pipeline/audit/pr-mergeability-events.jsonl`, append-only. Incluye `decision`, `reason` y `observations` — justo lo que el shape cerrado no admite. |

Reusar el shape cerrado también para el JSONL dejaría al operador sin `reason`
ni `observations`, y la observabilidad quedaría cumplida sólo de forma nominal.

## 5. Cómo consultarlo

```bash
# Últimas 20 decisiones
tail -20 .pipeline/audit/pr-mergeability-events.jsonl | jq -c '{ts:.timestamp, pr, issue, decision, reason}'

# Sólo los conflictos confirmados
grep '"decision":"emit"' .pipeline/audit/pr-mergeability-events.jsonl | jq .

# Por qué el watcher NO hizo nada con un PR
grep '"pr":4610' .pipeline/audit/pr-mergeability-events.jsonl | jq -r '.reason' | sort | uniq -c

# Estado vivo de la secuencia de observaciones
jq '.entries' .pipeline/state/pr-mergeability-watcher.json
```

## 6. Leyenda de motivos (`reason`)

Todo lo dudoso es **no-op con motivo**, nunca un evento y nunca un silencio.

### Emisión

| `reason` | Significado |
|---|---|
| `confirmed_conflict` | **El único que emite.** Dos observaciones conflictivas consecutivas, mismo HEAD, separadas por un poll real. |

### Secuencia de observación

| `reason` | Significado |
|---|---|
| `unknown_state` | GitHub todavía no resolvió `mergeable` (o el estado no es concluyente: `BLOCKED`, `BEHIND`). Rompe la consecutividad. |
| `single_sample` | Primera muestra conflictiva. Falta la confirmación. |
| `flapping` | El PR pasó por un estado sano después de uno conflictivo. Secuencia reiniciada. |
| `recovered` | El PR está sano y no venía de un conflicto. |
| `head_changed` | Hubo un push nuevo: la secuencia anterior ya no habla de este HEAD. |
| `clock_not_monotonic` | El timestamp o el `pollSeq` retrocedieron. Se descarta la secuencia. |
| `same_poll` | No pasó un poll real entre las dos muestras (mismo `pollSeq`, o delta menor a `min_poll_interval_ms`). |
| `already_emitted` | Dedupe por `{repo, pr, headRefOid}`: ya se emitió para este HEAD. |

### Universo de candidatos

| `reason` | Significado |
|---|---|
| `ambiguous_association` | 0 o más de 1 PR abierto para el mismo issue. **No se elige uno**: se descartan todos. |
| `not_in_active_wave` | El issue de la rama no pertenece a la ola activa. |
| `fork_or_cross_repo` | El HEAD viene de un fork o de otro repositorio. |
| `unexpected_base` | La base del PR no es la esperada (`main`). |
| `unexpected_repo` | La `url` del PR no corresponde al repo configurado. |
| `not_open` | El PR ya no está abierto. |
| `no_agent_branch` | **Limitación declarada** — ver §7. |
| `invalid_id` | Número de PR o de issue no entero positivo. |
| `no_active_wave` | No hay ola activa: no hay universo que observar. |

### Fallos de GitHub, datos y entorno

| `reason` | Significado |
|---|---|
| `gh_timeout` | `gh` excedió `gh_timeout_ms`; el hijo se mata. |
| `rate_limited` | Exit distinto de 0 con señal de rate limit en el `stderr`. |
| `non_zero_exit` | Otro fallo de `gh`. El `stderr` va recortado a 200 chars y **redactado**. |
| `json_parse_failed` | Respuesta no parseable. |
| `schema_invalid` | Respuesta parcial o con campos fuera de forma (ej. sin `headRefOid`). |
| `state_corrupt` | El archivo de estado no valida. Se arranca de cero **sin emitir**. |
| `path_escape` | Una ruta resolvió fuera de `.pipeline/`, o el destino es un symlink. **No se escribe.** |
| `disabled` | `enabled: false`. No se toca ni GitHub ni el disco. |
| `internal_error` | Excepción capturada. `runWatcherPoll` **nunca** propaga. |

## 7. Limitación de cobertura (decisión de diseño registrada)

`waves.json` guarda `{number, status}` por issue, **sin campo PR**. La única
vinculación issue↔PR posible es la convención de rama `agent/<issue>-`.

**Consecuencia:** un PR abierto y conflictivo cuya rama no sigue esa convención
queda **fuera** del universo observado.

Caso vivo al momento de la entrega: **PR #3839**, rama
`agent/api-pelada-agents-parity` — `CONFLICTING/DIRTY`, sin `<issue>` numérico.
Se audita como `no_agent_branch`. **No es un bug silencioso**: aparece en el
JSONL en cada poll.

Levantar la limitación exige que `waves.json` (o algún índice equivalente) guarde
la asociación issue↔PR. Fuera de alcance de este issue.

## 8. Configuración

```yaml
pr_mergeability_watcher:
  enabled: false            # nace apagado; sólo el booleano true enciende
  expected_repo: intrale/platform
  expected_owner: intrale
  expected_base: main
  poll_interval_minutes: 10
  min_poll_interval_ms: 60000
  candidate_limit: 20       # clampeado a [1,100] en código
  gh_timeout_ms: 5000
  state_entry_ttl_hours: 72
```

Dos reglas que valen más que el YAML:

- **Los límites se clampean en código** (`normalizeConfig`). Un
  `candidate_limit: 100000` editado a mano degrada a 100, no dispara 100k
  llamadas.
- **`enabled` es estrictamente booleano.** `'true'`, `1` y `yes` **no** encienden
  (fail-closed).

La sección está declarada en `.pipeline/lib/config-schema.js` (raíz cerrada desde
#5173) con lado `kernel` en `SIDE_MAP` y en la tabla §2.4 de
`docs/pipeline/contrato-kernel-adaptador.md`. **Agregar una sección al
`config.yaml` sin declararla ahí hace que el pipeline arranque pausado.**

## 9. Estado persistido

`.pipeline/state/pr-mergeability-watcher.json`, escrito con
`waves.atomicWriteFile` (tmp + `fsync` + `rename` con reintentos
`EPERM`/`EBUSY`/`EACCES` — imprescindible en Windows).

```jsonc
{
  "version": 1,
  "pollSeq": 3,                                  // monótono, sobrevive al restart
  "entries": {
    "intrale/platform#4610": {
      "repo": "intrale/platform", "pr": 4610, "issue": 4509,
      "headRefOid": "e75753d2…",
      "observations": [ /* máx 2 */ ],
      "emitted": true, "emittedAt": 1788670107486,
      "lastHealthyAt": null, "lastSeenPollSeq": 3, "lastSeenAt": 1788670110703
    }
  }
}
```

- **La clave es `repo#pr`, no `repo#pr@oid`.** Con el `oid` en la clave, un push
  nuevo sería indistinguible de un PR nuevo y el archivo crecería una entrada por
  push. Con el `oid` **dentro** de la entrada, el cambio de HEAD es *detectable*
  (`head_changed`) y la semántica de dedupe por la tripleta se conserva igual.
- **La barrera dura de idempotencia del rebote NO vive acá**: es
  `.pipeline/lib/rewind-merge-dedupe.js` (#4967 · CA-9), del lado del consumidor
  y dentro de su lock. El watcher persiste su *secuencia de observaciones*.
- **Poda**: por TTL, y por ausencia del PR en el barrido — esto último **sólo si
  la página no vino truncada** por `--limit`, porque con la lista llena no se
  puede distinguir "cerrado" de "quedó afuera de la página".

## 10. Seguridad

- Toda invocación de `gh` usa `execFile` con **argv array**: sin `shell: true`,
  sin concatenar strings.
- `owner/repo` se valida contra charset y los IDs contra entero positivo **antes**
  de que lleguen al argv. Con un repo o un PR inválido, `gh` **no se invoca**
  (hay tests que asertan que el runner no fue llamado).
- Timeout, `maxBuffer: 1MB` y clamp del `--limit` en todas las llamadas.
- El `stderr` se recorta a 200 chars y pasa por un **redactor** de tokens
  (`ghp_*`, `github_pat_*`, `Bearer …`, `Authorization:`, `GH_TOKEN=`). El argv
  nunca se loguea.
- Las rutas salen de **constantes internas**, jamás de `repo`, branch o PR. Hay
  guarda de contención bajo `.pipeline/` y rechazo de symlink (`lstatSync`) antes
  de reemplazar el archivo.

## 11. Aislamiento operativo

`runWatcherPoll` envuelve **todo** su cuerpo en `try/catch` y devuelve
`{ ok: false, reason }`. **Jamás propaga una excepción al caller**: un fallo del
watcher no puede frenar el barrido del Pulpo, el lanzamiento de agentes ni el
avance de la ola. Hay un test por cada dependencia inyectada que verifica que una
excepción arbitraria no se escapa.

Un fallo al escribir el JSONL tampoco tumba el poll: se reporta en
`auditWriteErrors` del resultado.

## 12. Rollout

1. Mergeado con `enabled: false` (este issue).
2. #4968 engancha el brazo periódico en el Pulpo y lo enciende con observación.
3. Recién con evidencia de que el JSONL no produce falsos positivos, se conecta
   la salida al consumidor de #4967.

Para encenderlo a mano y mirar sin efectos: poner `enabled: true` y leer el
JSONL. El watcher **no** ejecuta transiciones por sí mismo, así que encenderlo es
seguro por construcción.

## 13. Evidencia de aceptación (2026-09-06)

**Universo real barrido** (`gh pr list --state open`, 4 PRs abiertos):

```
6932 agent/6931-destrackear-qa-evidence          MERGEABLE/CLEAN
6930 agent/6929-guardian-disco-limpieza…         MERGEABLE/CLEAN
4610 agent/4509-pipeline-dev                     CONFLICTING/DIRTY
3839 agent/api-pelada-agents-parity              CONFLICTING/DIRTY
```

**Poll real contra la ola activa 10** (210 issues, `4509 in wave: false`):

```
POLL REAL: ok=true pollSeq=1 wave=10 events=0
  PR 6932 -> noop / not_in_active_wave
  PR 6930 -> noop / not_in_active_wave
  PR 4610 -> noop / not_in_active_wave     ← caso vivo del no-op por ola
  PR 3839 -> noop / no_agent_branch        ← caso vivo de la limitación §7
```

**Emisión.** Hoy no hay ningún PR abierto `CONFLICTING` cuyo issue esté en la ola
activa, así que la rama de emisión se demuestra con los **datos reales de GitHub
del PR #4610** y lo único controlado —la pertenencia a la ola— sustituido:

```
POLL 1: pollSeq=1 events=0   PR 4610 -> observe / single_sample
POLL 2: pollSeq=2 events=1   PR 4610 -> emit    / confirmed_conflict
POLL 3: pollSeq=3 events=0   PR 4610 -> noop    / already_emitted
```

Línea resultante en `.pipeline/audit/pr-mergeability-events.jsonl`:

```json
{
  "timestamp": "2026-09-06T04:48:27.486Z",
  "repo": "intrale/platform", "pr": 4610, "issue": 4509,
  "head_ref_oid": "e75753d2553cd9acec93b624847286c51434bb25",
  "wave": 10, "decision": "emit", "reason": "confirmed_conflict",
  "observations": [
    { "mergeable": "CONFLICTING", "merge_state_status": "DIRTY", "ts": "2026-09-06T04:48:24.175Z", "poll_seq": 1 },
    { "mergeable": "CONFLICTING", "merge_state_status": "DIRTY", "ts": "2026-09-06T04:48:27.486Z", "poll_seq": 2 }
  ],
  "event": {
    "source": "mergeability-watcher", "repo": "intrale/platform", "pr": 4610,
    "issue": 4509, "headRefOid": "e75753d2553cd9acec93b624847286c51434bb25",
    "detected_at": 1788670107486
  }
}
```

Y el evento pasa el validador del consumidor mergeado:

```
rewind.validateMergeConflictEvent(evento)
-> {"ok":true,"issueNum":4509,"repo":"intrale/platform","pr":4610,
    "headRefOid":"e75753d2553cd9acec93b624847286c51434bb25"}
```

## 14. Tests

```bash
node --test .pipeline/lib/__tests__/pr-mergeability-watcher.test.js
node --test .pipeline/lib/__tests__/pr-info-fetcher-mergeability.test.js
node --test .pipeline/lib/__tests__/pr-info-fetcher.test.js   # no-regresión, sin editar el archivo
```

Cobertura del módulo nuevo: **100 % líneas · 92,6 % branches**, con las ramas de
emisión y de idempotencia cubiertas.

## 15. Referencias

- `.pipeline/lib/pr-mergeability-watcher.js` — el módulo.
- `.pipeline/lib/pr-info-fetcher.js` — extensión aditiva (`fetchOpenPrCandidatesAsync`, `fetchPrMergeabilityAsync`).
- `.pipeline/lib/pipeline-rewind.js` — consumidor del evento (#4967).
- `.pipeline/lib/rewind-merge-dedupe.js` — barrera dura de idempotencia del rebote (#4967).
- `docs/pipeline/rewind-operador.md` → "Segundo frente".
- Issues: #4637 (padre) · #4967 (transición, cerrada) · #4968 (enganche en el Pulpo) · #5012 (exponer el estado en el dashboard).
