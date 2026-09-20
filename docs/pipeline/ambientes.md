# Ambientes del pipeline: productivo y pruebas (#7114)

Doc paraguas de la **Ola 9.4.1 · Ambiente de pruebas del CORE** (épico #7102).
Explica el modelo de los dos ambientes, qué comparten y qué no, las capas que
impiden que una corrida de pruebas toque el productivo, **cómo se promueve un
cambio del CORE** de un ambiente al otro, y qué hacer cuando el guardrail frena
un commit.

Es pública: nombra variables, paths y namespaces; nunca valores, tokens, chat
IDs ni hostnames. Para levantar/verificar/borrar el ambiente de pruebas, la
referencia es [`ambiente-pruebas-provision.md`](ambiente-pruebas-provision.md)
(#7111): acá se enlaza, no se repite.

## 1. Los dos ambientes en un vistazo

```
                 PIPELINE_AMBIENTE=productivo            (default: nada declarado)
                          │                                        │
                          ▼                                        ▼
               ┌──────────────────────┐                 ┌──────────────────────┐
   Pulpo y     │  PRODUCTIVO          │   código,       │  PRUEBAS             │  runner, tester
   servicios ─►│  <repo>/.pipeline    │◄─ config ──────►│  dir efímero / root  │◄─ determinístico,
               │  colas · logs ·      │   (copiados)    │  provisionado fuera  │  provision-test-env
               │  estado · .paused    │                 │  del repo            │
               └──────────────────────┘                 └──────────────────────┘
                 Telegram/GitHub/vault REALES             canales APAGADOS, vault `intrale-pruebas`
```

| Qué | Productivo | Pruebas |
|---|---|---|
| Código del CORE (`.pipeline/*.js`, `lib/`, skills) | el checkout del repo principal | el mismo código (worktree o checkout); **no se edita el productivo** |
| `config.yaml`, `pipeline.config.json` | los del repo | **copiados** al dir de pruebas, nunca enlazados |
| Colas (`servicios/*`, `definicion/`, `desarrollo/`) | las reales | propias, vacías al nacer |
| `logs/` | reales | propios |
| Estado operativo (`sessions/`, `agent-registry.json`, snapshots) | real | propio |
| Marcadores de pausa (`.paused`, pausas parciales) | reales | propios |
| Canal Telegram | real (`TELEGRAM_CHAT_ID`, `credentials.json`) | **apagado** (`TELEGRAM_CHAT_ID_PRUEBAS`, valores en curso: #7113) |
| Escrituras a GitHub | reales | **apagadas** |
| Vault | prefijo `/intrale`, proyecto `intrale` | proyecto `intrale-pruebas` |
| Quién fija el directorio | nadie: `DEFAULT_PRODUCTIVE_DIR` está en código | `PIPELINE_DIR_OVERRIDE` (runner, `--print-env`) |

### Regla de decisión (resolvedor único, `lib/pipeline-env.js`)

- **Productivo** sólo con `PIPELINE_AMBIENTE=productivo` **y** directorio
  resuelto exactamente igual a `DEFAULT_PRODUCTIVE_DIR` (el `.pipeline` del
  repo). Cualquier otro dir degrada la declaración a `pruebas`.
- **Sin declaración ⇒ `pruebas`**, y sin variable de directorio ⇒ `dir: null`
  (fail-closed: nunca cae a `__dirname/..`). Un escritor migrado a
  `lib/write-target` con `dir === null` **no escribe y falla ruidoso**.
- Precedencia del directorio: `PIPELINE_DIR_OVERRIDE` > `PIPELINE_STATE_DIR` >
  `PIPELINE_REPO_ROOT` (+ `/.pipeline`). La variable aporta *directorio*, nunca
  *modo*.
- SEC-9: en `pruebas`, `PIPELINE_REPO_ROOT` **no** es fuente de dir (es el
  contexto productivo que el Pulpo hereda a sus hijos). Y "dentro del
  productivo" es la **unión** `{ DEFAULT_PRODUCTIVE_DIR, PIPELINE_REPO_ROOT/.pipeline }`:
  un módulo cargado desde un worktree sigue protegiendo el `.pipeline` del repo
  principal.
- Señales de corrida de prueba (`NODE_TEST_CONTEXT`, `PULPO_NO_AUTOSTART=1`,
  `NODE_ENV=test`) le ganan a la declaración productiva. El escape hatch
  `PIPELINE_ALLOW_PROD_SIDE_EFFECTS=1` sólo anula la señal, y cuando cambió el
  resultado queda escrito en `motivo`.

## 2. Quiero levantar un ambiente de pruebas

```bash
npm run pruebas:env                           # provisiona (idempotente) fuera del repo
eval "$(npm run -s pruebas:env -- --print-env)"   # exporta PIPELINE_AMBIENTE / PIPELINE_DIR_OVERRIDE
npm run pruebas:env:verify                    # aislamiento contra el productivo
```

Comandos, layout, garantías fail-closed y límites: [`ambiente-pruebas-provision.md`](ambiente-pruebas-provision.md).

## 3. Quiero correr tests sin tocar el productivo

```bash
npm run test:pipeline          # runner canónico: scripts/test-pipeline.js
```

- El runner provee el dir de pruebas en **un único punto**
  (`lib/test-run-dir.js` → `ensureTestRunDir()`): `PIPELINE_DIR_OVERRIDE` a un
  `mkdtemp` bajo `os.tmpdir()`, con `config.yaml` y `pipeline.config.json`
  copiados. Los hijos lo heredan; se borra al terminar (también ante fallo o
  señal). Si `PIPELINE_DIR_OVERRIDE` ya venía seteado, se respeta y no se borra.
- El otro lanzador es el tester determinístico (`skills-deterministicos/tester.js`,
  fase `verificacion`); usa el mismo helper.
- Un test que necesita un directorio propio usa `fs.mkdtempSync(path.join(os.tmpdir(), …))`
  o `ensureTestRunDir()`. **Nunca** `path.join(__dirname, …)` como destino de
  `PIPELINE_DIR_OVERRIDE` / `PIPELINE_STATE_DIR` / `PIPELINE_REPO_ROOT` /
  `pipelineDir:` — es lo que el guardrail (§5) frena.

## 4. Defensa en profundidad: qué impide el derrame

Cinco capas, y la reconciliación entre las de runtime es **AND**: una escritura
sale sólo si el resolvedor habilita el canal **y** el guard del Pulpo devuelve
`null`. Ninguna capa relaja a otra.

| Capa | Dónde | Qué hace |
|---|---|---|
| `pipelineEnv.resolve()` + `lib/write-target` | runtime, por llamada | sin ambiente declarado, `dir: null` ⇒ no se escribe; canales de pruebas apagados |
| `corridaDePrueba()` | `pulpo.js` | detecta señal de test; el hatch la anula |
| `efectoProductivoBloqueado(destino)` | `pulpo.js` | bloquea efectos sobre la unión productiva durante una corrida de prueba |
| `ghWritesBloqueadas()` | `pulpo.js` | trata `PIPELINE_DIR_OVERRIDE` como señal de pruebas **y** exige `canales.github.escrituras === true` |
| `lib/test-env-lint.js` (#6260) | estático: pre-commit + CI | un test no escribe `process.env` fuera de `withEnv`; `PIPELINE_AMBIENTE` y `PIPELINE_ALLOW_PROD_SIDE_EFFECTS` están registradas como variables de control (R0 de #7114) |
| `lib/write-target-lint.js` (#7114) | estático: pre-commit + CI | **destinos**: inventario sincronizado (R1), ratchet de `pendiente` (R2), tests que resuelven al productivo (R3) |

Los dos lints estáticos existen porque ningún workflow corre la suite completa
y el pre-commit no puede correr 1000+ tests: verifican el **fuente**. La
verificación dinámica de "dónde terminó el byte" queda en los lanzadores
(#7414 / #7457).

## 5. El guardrail por destino (`write-target-lint`)

```bash
node .pipeline/lib/write-target-lint.js --check            # 0 limpio / 1 rojo / 2 config
node .pipeline/lib/write-target-lint.js --write-baseline   # sólo cuando el baseline ENCOGIÓ
```

Corre en `.husky/pre-commit` cuando hay archivos `.pipeline/` staged (universo
completo, sin `--only`: R1 y R2 son propiedades del inventario entero) y en CI
por `.github/workflows/write-target-lint.yml` (advisory hasta #6265). El job
instala las dependencias de la **raíz** con `npm ci --ignore-scripts` antes de
correr: el lint carga `pipeline-env` → `config-resolver` → `js-yaml`, que vive
en el `package.json` raíz, y sin ese paso muere con exit 2. Fail-closed:
inventario, baseline o `pipeline-env` que no cargan ⇒ exit 2; cero módulos o
cero tests escaneados ⇒ exit 1.

Formato de cada rojo (archivo relativo al repo, línea, destino, canal):

```
LINT R3: .pipeline/tests/foo.test.js:42 -> .pipeline/logs (canal logs)
    variable: PIPELINE_DIR_OVERRIDE [directa]
    reason: el test fija PIPELINE_DIR_OVERRIDE a un destino dentro del .pipeline productivo
    snippet: process.env.PIPELINE_DIR_OVERRIDE = path.join(__dirname, '..', 'logs');
```

| Regla | Qué mira | Qué es rojo |
|---|---|---|
| **R1** inventario | `lib/write-points-scan` vs `lib/write-points.json` | módulo escritor sin entrada, entrada sin punto en el fuente, `migrado|safe` cuya línea no usa `write-target`, `lectura|externo` sin `nota` o cuyo identificador escribe (anti-tampering) |
| **R2** ratchet | puntos `pendiente` (clave `modulo::funcion`, nunca por línea) | un `pendiente` **nuevo** respecto de `lib/write-target-lint.baseline.json` |
| **R3** tests | los 4 orígenes del runner | `PIPELINE_DIR_OVERRIDE` / `PIPELINE_STATE_DIR` / `PIPELINE_REPO_ROOT` / `pipelineDir:` con valor resoluble (`path.join(__dirname, …)`, `` `${__dirname}…` ``, `__dirname + …`, literal absoluto) dentro del productivo, en cualquiera de las 6 formas (`process.env.X =`, `process.env['X'] =`, `Object.assign(process.env, {X})`, `withEnv({X})`, `env: {…}` de spawn/exec/fork, `pipelineDir:`) |

Detalles que importan:

- `PIPELINE_REPO_ROOT` aporta la **raíz del repo**, no el dir de estado: R3
  compara `<valor>/.pipeline` (la misma semántica que el resolvedor y que la
  unión SEC-9). Fijarla a la raíz del repo (`path.join(__dirname, '..', '..')`
  desde `.pipeline/tests/`) es rojo con destino `.pipeline`, aunque la raíz no
  esté *dentro* de `.pipeline`; es el vector real de los skills determinísticos
  (`build.js`, `delivery.js`, `linter.js`, `tester.js`), que resuelven
  `REPO_ROOT = process.env.PIPELINE_REPO_ROOT || …` y escriben debajo.
- La comparación es **canónica** (realpath del ancestro existente, minúsculas
  en Windows, sin `\\?\`): un drive en minúscula o una junction no evaden.
- **La inexistencia del destino no exime**: `path.join(__dirname, 'no_existe')`
  dentro del productivo es rojo (un `mkdirSync({recursive:true})` lo crearía).
- Valor no resoluble (`mkdtemp`, una variable, `ensureTestRunDir()`) **no** es
  rojo: lo cubre el resolvedor en runtime (dir de pruebas dentro del productivo
  ⇒ `null`).
- El verde es una sola línea `OK` más los conteos por estado del inventario y
  las **transiciones de estado vs HEAD**, para que `review` las vea en CI.
- Alcance del escáner (CA-4 / #7451): raíz de `.pipeline`, `lib/`, `metrics/`,
  `skills-deterministicos/` y `kernel-bootstrap/`. No hay módulos escritores
  fuera de alcance.

## 6. Quiero promover un cambio del CORE

El productivo **sólo cambia por PR mergeado a `main` + respawn del Pulpo**.
Nunca editando el checkout productivo: en cada respawn se hace `reset --hard`
y un hotfix local se pierde (ver `docs/pipeline` y la memoria operativa del
repo principal).

1. **Rama** `agent/<issue>-<slug>` desde `origin/main` (worktree aislado; el
   pipeline lo crea solo en fase `dev`).
2. **Tests en pruebas**: `npm run test:pipeline` (dir efímero) y, si el cambio
   toca escritores o tests de destino:
   `node .pipeline/lib/write-target-lint.js --check` y
   `node .pipeline/lib/test-env-lint.js --check` → ambos `0`.
3. **Commit**: el pre-commit corre los cuatro lints del pipeline
   (`operational-state-lint`, `test-env-lint`, `write-target-lint`,
   `ghost-artifact-lint`). Un rojo se resuelve con §7, **no con `--no-verify`**.
4. **PR** contra `main` con `Closes #<issue>`, asignado a `leitolarreta`
   (CODEOWNERS obliga review humana en `.pipeline/`). CI corre los mismos lints
   (advisory hasta #6265) y sus suites.
5. **Gates**: QA (`qa:skipped` con justificación para infra pura, sin `app:*`),
   tester, PO, review. Sin `qa:passed`/`qa:skipped` no hay merge.
6. **Merge a `main`** → **respawn del Pulpo** (`node .pipeline/restart.js`
   desde PowerShell, nunca desde Git Bash): el `reset --hard` despliega el
   código nuevo sobre el productivo. Si el smoke test pasa, el tag
   `pipeline-stable` avanza; si falla, `rollback.sh` vuelve al tag y avisa.
7. **Verificación post-promoción**: `logs/pulpo.log` sin `CONFIG INVÁLIDA`,
   cola de Telegram sin ruido, dashboard levantado.

Herramientas del operador, no del código: `PIPELINE_ALLOW_PROD_SIDE_EFFECTS=1`
anula la señal de corrida de prueba **con rastro en `motivo`** del resolvedor;
se usa a mano, con declaración productiva, y nunca queda en un test.

## 7. El guardrail me frenó

Los remedios, en este orden (el rojo los imprime tal cual):

1. **R1 · inventario desincronizado** — regenerar el JSON con el dir
   **explícito** (sin dir, el default `pruebas` de `write-target` lanza) y
   curar `estado`/`nota` de lo que aparezca:
   ```bash
   node .pipeline/lib/write-points-scan.js --sync .pipeline
   ```
2. **R1/R2 · falso positivo o escritura fuera de `.pipeline`** — curar
   `estado: lectura|externo` + `nota` en `.pipeline/lib/write-points.json`. Un
   escritor real se **migra** a `lib/write-target` (`writeDir`/`safeWriteDir`),
   no se cura.
3. **R3 · destino estático en un test** — apuntarlo a
   `fs.mkdtempSync(path.join(os.tmpdir(), …))`, a `ensureTestRunDir()` de
   `lib/test-run-dir.js`, o al `PIPELINE_DIR_OVERRIDE` que el runner ya provee.
4. **`--write-baseline` sólo si el baseline ENCOGIÓ** (el diff va en el PR).
   Rechaza crecer: un `pendiente` o un destino de test nuevos se arreglan, no
   se congelan. Con archivos nuevos untracked en el mismo commit: `--allow-dirty`.
5. `--no-verify` **no es la salida**: mueve el rojo al CI (y al productivo) en
   vez de resolverlo.

## 8. Glosario de canales

Vocabulario único de `lib/write-target.js`, `lib/write-points.json` y el
guardrail:

| Canal | Qué agrupa |
|---|---|
| `colas` | `servicios/*/pendiente|trabajando|listo`, `definicion/`, `desarrollo/`, outbox |
| `logs` | `logs/*.log`, `*.jsonl`, reportes, snapshots de métricas |
| `estado` | `sessions/`, `agent-registry.json`, estado operativo, JSON de configuración regenerados |
| `pausa` | `.paused` y marcadores de pausa parcial |

Estados del inventario: `migrado` (usa `writeDir`/`writePath`), `safe`
(`safeWriteDir`/`safeWritePath`, nunca lanza), `pendiente` (resuelve ad-hoc;
migra por goteo, #7464), `lectura` (falso positivo: sólo alimenta lecturas),
`externo` (escribe fuera del árbol `.pipeline`: `qa/`, `.claude/`, `docs/`).
