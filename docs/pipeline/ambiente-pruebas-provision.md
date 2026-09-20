# Ambiente de pruebas del pipeline — provisión (#7111)

Comando que levanta, verifica y descarta un `pipelineDir` de pruebas **completo,
reproducible y desechable**, fuera del checkout, que no comparte un solo archivo
con el `.pipeline` productivo. Es la primera pieza tangible del épico #7102 y el
destino que el resolvedor único de ambiente (`lib/pipeline-env.js`, #7110) deja
en `dir: null` cuando el proceso corre en modo `pruebas`.

## Comandos

```bash
npm run pruebas:env                 # provisiona (idempotente: completa lo faltante)
npm run pruebas:env -- --fresh      # borra y recrea
npm run pruebas:env -- --json       # salida para `| jq`
npm run pruebas:env -- --print-env  # dos líneas para `eval`
npm run pruebas:env:verify          # aislamiento contra el productivo
npm run pruebas:env:destroy         # borra el ambiente entero
node .pipeline/scripts/provision-test-env.js --help
```

Todos aceptan `--root <dir>` para usar otro directorio (el padre debe existir y
estar fuera del repo). Un flag desconocido o mal tipeado (`--destory`,
`--fresh=1`) sale `2` sin provisionar ni borrar nada.

### Salida y exit codes

Sin `--json`, stdout lleva el prefijo `[pruebas:env]` y una palabra clave que
mapea 1:1 al exit code:

| Palabra | Exit | Significado |
|---|---|---|
| `OK` | 0 | el estado final es el pedido |
| `INCOMPLETO` | 1 | quedó residuo tras `--destroy`, o `--verify` encontró entradas compartidas / enlaces |
| `ABORTADO` | 2 | fail-closed: no se creó ni se borró nada (destino no habilitado, root es un enlace, sin marcador, flag desconocido) |

Caso feliz:

```
[pruebas:env] OK · ambiente provisionado en C:\Users\Administrator\AppData\Local\Temp\intrale-pipeline-pruebas
[pruebas:env] 115 colas · 26 archivos copiados · productivo fuera del root: C:\Workspaces\Intrale\platform\.pipeline
[pruebas:env] para apuntar un proceso: npm run pruebas:env -- --print-env
```

Los diagnósticos van a **stderr**; stdout es sólo el resultado. Con
`--print-env`, stdout son exactamente dos líneas:

```
PIPELINE_AMBIENTE=pruebas
PIPELINE_DIR_OVERRIDE=<root>/.pipeline
```

La declaración fija el **modo**; el **directorio** viaja por
`PIPELINE_DIR_OVERRIDE` (la misma variable con la que el provisionador validó el
destino, D1). `--print-env` **no emite `PIPELINE_REPO_ROOT`**: desde #7112
(SEC-9 estricto) esa variable es el contexto heredado del checkout productivo
—el Pulpo la fija con su propio `ROOT` para todos sus hijos— y en modo
`pruebas` **nunca aporta directorio**, ni siquiera acompañada de
`PIPELINE_AMBIENTE=pruebas`. Además su `.pipeline` integra la unión que SEC-3
protege: si se emitiera con el root de pruebas, el propio override quedaría
anulado por "apunta al productivo". El shell que hace `eval` conserva el
`PIPELINE_REPO_ROOT` que ya tenía (si es el de un agente, el del repo
principal), y así el `.pipeline` real sigue protegido mientras se escribe en
el de pruebas.

Los paths siempre salen **canónicos** (`fs.realpathSync.native`): la forma 8.3
(`ADMINI~1`) que devuelve `os.tmpdir()` en Windows nunca aparece en la salida.

## Layout provisionado

```
<root>/                                 default: <tmpdir real>/intrale-pipeline-pruebas
├── pipeline.config.json                copia byte a byte del manifiesto de producto
└── .pipeline/
    ├── config.yaml                     productivo + overlay (ver abajo)
    ├── ambiente-pruebas.json           marcador { modo: 'pruebas', provisionerVersion, origen: { repoRoot, sha } }
    ├── waves.json.template             copia
    ├── waves.json                      sembrado desde el template; NO se pisa en corridas siguientes
    ├── .partial-pause.json             { allowed_issues: [], source } — allowlist vacía == running; NO se pisa
    ├── agent-models.json / agent-models.schema.json
    ├── descriptors/  roles/            copia con walk + lstat
    ├── <pipeline>/<fase>/<subestado>/  90 colas: 10 fases × 9 subestados, derivadas de config.yaml
    ├── servicios/<svc>/<subestado>/    25 colas: 5 servicios × 5 subestados
    └── logs/ state/ rejections/ metrics/ audit/ events/ locks/ …   vacíos
```

- `.paused` (halt total) se garantiza **ausente**.
- El layout es fiel al productivo: `<root>/.pipeline` + manifiesto en el padre,
  tal como lo ubica `config-resolver.productPathFor()`. Por eso alcanza con
  `PIPELINE_REPO_ROOT=<root>` para apuntar un proceso.

### Qué se copia y qué no

**Allowlist** (lo único que se copia del productivo): `config.yaml`,
`pipeline.config.json`, `waves.json.template`, `agent-models.json`,
`agent-models.schema.json`, `descriptors/`, `roles/`.

**Todo lo demás se crea vacío.** En particular NUNCA se copian `logs/` (2,2 GB
de transcripts de agentes), `state/`, `commander-session.json`,
`listener-offset.json`, `connectivity-state.json` ni el `waves.json` de runtime.

**Overlay sobre `config.yaml`** (load → mutate → dump con `js-yaml`; se pierden
los comentarios, el resto es semánticamente igual):

| Clave | Valor | Por qué |
|---|---|---|
| `operational_state.durable` | `false` | no tocar DynamoDB del estado operativo |
| `kernel.durable` | `false` | no encender el store DynamoDB del kernel |
| `vault.enabled` | `false` | no leer/escribir parámetros del vault |

Canales (telegram, github, proveedores) no se tocan acá: es alcance de #7113.

## Cómo apuntar un proceso

```bash
eval "$(npm run -s pruebas:env -- --print-env)"
node .pipeline/lib/pipeline-env.js   # o cualquier lector que reciba env
```

`pipelineEnv.resolve({ PIPELINE_AMBIENTE: 'pruebas', PIPELINE_DIR_OVERRIDE: '<root>/.pipeline' })`
devuelve `{ modo: 'pruebas', dir: '<root>/.pipeline', origen: 'PIPELINE_DIR_OVERRIDE' }`.
En cambio `pipelineEnv.resolve({ PIPELINE_AMBIENTE: 'pruebas', PIPELINE_REPO_ROOT: '<root>' })`
devuelve `dir: null` (SEC-9 estricto): un escritor migrado a `write-target`
falla ruidoso en vez de escribir.

### Bloqueos humanos (`lib/human-block.js`, #7456)

Un harness manual que ejercite los gates de decisión (`reportHumanBlock`,
`unblockIssue`, `executeQuickAction`, el recordatorio) necesita declarar el
ambiente **antes** de la primera llamada — no hace falta antes del `require`,
porque desde #7456 el módulo resuelve su `.pipeline` **por llamada** vía
`write-target`, pero sí antes de invocar cualquier función que lea o escriba:

```bash
# desde un worktree o desde el repo principal, da igual: nunca toca el .pipeline productivo
PIPELINE_DIR_OVERRIDE="$(mktemp -d)/.pipeline" node -e "
  require('./.pipeline/lib/human-block').reportHumanBlock({
    issue: 7113, skill: 'intake', phase: 'validacion', pipeline: 'definicion',
    reason: 'x', question: 'y?', moveFromActive: false })"
```

- El dir viaja **sólo** por `PIPELINE_DIR_OVERRIDE` (o `PIPELINE_STATE_DIR`).
  `PIPELINE_REPO_ROOT` es contexto heredado del Pulpo y **no** habilita nada
  (SEC-9): fijarlo al mismo tmp anula el override ("dir de pruebas apunta al
  productivo").
- Sin ambiente declarado la llamada **lanza** `EscrituraBloqueadaError` con las
  tres líneas `[pipeline-env]` en stderr y no escribe en ningún lado. Es el
  comportamiento buscado: el incidente del 20/09 (#7113/#7114 frenados ~7 h
  desde un harness) no puede repetirse.

## Garantías de seguridad (fail-closed)

El único riesgo real del comando es **borrar o contaminar el productivo**. Se
cierra por código, verificable por test:

- El destino lo valida el resolvedor único: el candidato viaja **sólo** por
  `PIPELINE_DIR_OVERRIDE` en el env que recibe `pipelineEnv.resolve()` y se exige
  `modo === 'pruebas' && dir !== null`. Nunca `opts.pipelineDir`.
- Antes de resolver se **eliminan** del env heredado `PIPELINE_AMBIENTE`,
  `PIPELINE_ALLOW_PROD_SIDE_EFFECTS`, `PIPELINE_DIR_OVERRIDE`,
  `PIPELINE_STATE_DIR`, `PIPELINE_REPO_ROOT` y `PIPELINE_RUNTIME_DIR`.
- Defensa en profundidad por `realpath`: el root no puede ser, contener ni estar
  contenido en el repo ni en el productivo (tampoco por short-path 8.3 ni por
  junction); no puede ser el home ni un ancestro del home; no puede ser raíz de
  drive.
- Recorridos con `lstat`, nunca `stat` ni `fs.cpSync`: cualquier enlace en el
  origen o en el ambiente **aborta**. Tras el `mkdir` del root se re-verifica
  por realpath (race por nombre fijo en `%TEMP%`).
- `destroy` sólo borra si el root no es enlace, está en ubicación segura y tiene
  el marcador `ambiente-pruebas.json` con `modo: 'pruebas'`. Sin marcador no se
  borra nada y se dice. El residuo (EPERM/EBUSY) se lista por nombre.
- Sólo APIs `fs`. Única excepción: `execFileSync('git', ['rev-parse', 'HEAD'])`
  con argv literal y best-effort (`sha: null` si falla).
- Ni el marcador ni `--json` ni `--print-env` contienen valores del env.

### Bloqueos humanos (`lib/human-block.js`, #7456)

Los markers de bloqueo humano, sus sidecars, las órdenes que emite al
servicio-github y el audit de acciones rápidas quedan cubiertos por el
resolvedor único **sin canal nuevo** (D-1): se usan los canales existentes con
`destino` granular en `lib/write-points.json`.

| Qué escribe `human-block.js` | canal | destino |
|---|---|---|
| markers `<issue>.<skill>` + sidecars `.reason.json` / `.guidance.txt` / reconciler (`markersRoot()`) | `estado` | `<pipeline>/<fase>/bloqueado-humano` |
| órdenes `label` / `remove-label` / `comment` para el servicio-github (`ghQueueDir()`) | `colas` | `servicios/github/pendiente` |
| audit de acciones rápidas y auto-destrabe (`auditRoot()`) | `logs` | `audit/human-block-actions-*.jsonl` |
| cache de títulos (`titleCacheDir()`, **sólo lectura**, `safeWriteDir`: nunca lanza) | `estado` | `.issue-title-cache.json` |

Garantías, verificadas por `lib/__tests__/human-block-env-isolation.test.js`:

- **Resolución por llamada** (SEC-10 / V4 de #7112): ninguna const de módulo ni
  closure creada al `require` guarda el dir. Un override declarado después de
  cargar el módulo se respeta igual.
- **Lecturas y escrituras por la misma raíz** (SEC-HB-1): `findActiveMarker`,
  `findBlockedMarker`, `listBlockedMarkers`, `listPhaseMarkers` y
  `listBlockedIssues` resuelven igual que `reportHumanBlock` / `unblockIssue`.
  Si no fuera así, un harness con override **movería** (`renameSync`) un
  work-file real del pipeline productivo hacia un tmp.
- **Confinamiento del destino** (SEC-HB-2): `pipeline` ∈ {`desarrollo`,
  `definicion`}; `phase` / `skill` / `target_phase` son segmentos simples
  (`^[a-z0-9][a-z0-9_-]*$`, sin `/`, `\` ni `..`) y el path final se verifica
  contenido en el `pipelineDir` resuelto. Fallo → `throw`, nunca sanitización
  silenciosa.
- **Sin degradación muda** (SEC-HB-3): `enqueueNeedsHumanLabel` y
  `enqueueGithub` resuelven la cola **fuera** de su `try/catch` best-effort, así
  el bloqueo de ambiente lanza en vez de devolver `false` como un fallo de disco.
- **Sin escape hatch propio** (SEC-HB-4): no hay `opts.pipelineDir`,
  `opts.force` ni variable de entorno nueva; `deps.auditDir` es inyección de
  tests y sólo alcanza al audit. `PIPELINE_ALLOW_PROD_SIDE_EFFECTS` tampoco
  habilita nada sin declaración productiva.
- **Recordatorio** (D-3): `human-block-reminder.js` no fija ningún dir; recibe
  `pipelineDir` del llamador (`pulpo.js::PIPELINE()`, migrado en #7112) y sin él
  devuelve `{ error: 'sin pipelineDir' }` sin escribir.

Fuera de alcance (con issue propio): `trace.appendEvent` →
`.claude/activity-log.jsonl` productivo (#7462); el ledger de reclaim que este
módulo requiere (#7461); el punto ciego del escáner sobre `trace.REPO_ROOT`
(#7460).

## API (para tests y helpers)

```js
const prov = require('.pipeline/lib/provision-test-env');
const r = prov.provision({ env: {}, root, repoRoot, fresh });  // { root, pipelineDir, manifestPath, marker, creados, colas, copiados, … }
prov.verifyIsolation({ root, productivo });                    // { ok, compartidos, links, marcador, … }
prov.destroy({ root });                                        // { ok, existia, borrado, residuo, motivo? }
prov.layoutFor(configObj);                                     // { fases, servicios, fijos }
prov.snapshotTree(dir);                                        // [{ rel, tipo, size, mtimeMs }]
```

`fs`, `os` y `execFileSync` se inyectan por `deps` (segundo parámetro). La lib no
lee `process.env` en ningún lugar.

## Límites conocidos

- **Un `pulpo.js` real apuntado al ambiente todavía no arranca**: carga código
  (`roles/`, providers, `delivery.js`) y escribe `logs/pulpo.log` vía
  `__dirname`, o sea desde el productivo. Los CAs de #7111 son estructurales; el
  gap está registrado en #7408 y en el inventario de #7112.
- Canales y credenciales de pruebas (telegram, github, vault namespace) → #7113.
- Inversión del default (`pruebas` salvo declaración) y guardrail → #7112 /
  #7114.
- Bypass 8.3 dentro del resolvedor → #7407 (por eso el provisionador compara por
  realpath por su cuenta).
- Ambientes nombrados (`--name`) para correr varios en paralelo → #7422.

## Tests

`.pipeline/lib/__tests__/provision-test-env.test.js` — `node:test`, root por
`mkdtempSync`, sin asignar `process.env`, cobertura 100 % de líneas / ramas /
funciones de la lib y del CLI.

```bash
node --test --experimental-test-coverage .pipeline/lib/__tests__/provision-test-env.test.js
```
