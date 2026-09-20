# Ambiente de pruebas del pipeline — provisión (#7111)

Comando que levanta, verifica y descarta un `pipelineDir` de pruebas **completo,
reproducible y desechable**, fuera del checkout, que no comparte un solo archivo
con el `.pipeline` productivo. Es la primera pieza tangible del épico #7102 y el
destino que el resolvedor único de ambiente (`lib/pipeline-env.js`, #7110) deja
en `dir: null` cuando el proceso corre en modo `pruebas`.

El modelo de los dos ambientes, las capas que impiden el derrame y el
procedimiento de promoción de un cambio del CORE están en
[`ambientes.md`](ambientes.md) (#7114).

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

El módulo de bloqueos humanos resuelve **por llamada** (nunca en una const de
módulo) el directorio de cada cosa que escribe, a través de `write-target`:

| Qué escribe | canal | destino (inventario `lib/write-points.json`) |
|---|---|---|
| markers `<issue>.<skill>` + sidecars `.reason.json` / `.guidance.txt` / reconciler | `estado` | `<pipeline>/<fase>/bloqueado-humano` |
| órdenes `label` / `remove-label` / `comment` para el servicio-github | `colas` | `servicios/github/pendiente` |
| audit de acciones rápidas (`auditQuickAction`, `emitAutoReleased`) | `logs` | `audit/*.jsonl` |
| cache de títulos (`enriquecerConTitulo`) — **sólo lectura** | `estado` (`safeWriteDir`) | `.issue-title-cache.json` |

No hay canal `bloqueos`: los bloqueos humanos quedan cubiertos bajo
`estado`/`colas`/`logs` con `destino` granular. El recordatorio
(`lib/human-block-reminder.js`) recibe el `pipelineDir` por parámetro desde el
Pulpo (`pulpo.js::PIPELINE()`), que ya es un punto migrado.

Un **harness manual** (p. ej. ejercitar los gates de decisión desde un worktree)
tiene que declarar `PIPELINE_DIR_OVERRIDE` — **nunca** `PIPELINE_REPO_ROOT`,
que es contexto heredado y anula el override (SEC-9):

```bash
PIPELINE_DIR_OVERRIDE="$(mktemp -d)/.pipeline" node -e "
  require('./.pipeline/lib/human-block').reportHumanBlock({
    issue: 7113, skill: 'intake', phase: 'validacion', pipeline: 'definicion',
    reason: 'x', question: 'y?', moveFromActive: false })"
```

Marker, `.reason.json` y la orden de `needs-human` quedan bajo el tmp; el
`.pipeline` productivo no se toca. Las lecturas del mismo flujo
(`findActiveMarker`, `listBlockedIssues`) usan la **misma** raíz que la
escritura: un harness no puede "encontrar" un work-file real y sacarlo del
pipeline.

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
- **Bloqueos humanos (#7456):** sin ambiente declarado (ni `PIPELINE_AMBIENTE=productivo`
  ni `PIPELINE_DIR_OVERRIDE`), `reportHumanBlock`, `unblockIssue`,
  `enqueueNeedsHumanLabel`, `enqueueGithub` y las lecturas de markers lanzan
  `EscrituraBloqueadaError` con el aviso de tres líneas `[pipeline-env]` en
  stderr. La resolución ocurre **fuera** de los `try/catch` best-effort de los
  encoladores: un bloqueo de ambiente nunca se traga como fallo de disco. No
  existe escape hatch (`opts.pipelineDir`, `opts.force`, variable nueva);
  `deps.auditDir` sólo alcanza al audit de acciones rápidas. Los segmentos
  `skill`/`phase`/`target_phase` se validan como nombre simple
  (`^[a-z0-9][a-z0-9_-]*$`), `pipeline` contra la whitelist y el destino final
  se confina a la raíz resuelta. Test: `lib/__tests__/human-block-env-isolation.test.js`.

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
