# Entorno de los agentes hijos

> Parte 1 de #7598 (#7634), épico #7589. Inventario de qué recibe hoy cada proceso hijo que lanza el pipeline. Este doc es el destino del `Ver:` del error `CHILD_ENV_VIOLATION`.
>
> **Estado:** `env_isolation_enabled: false` (`.pipeline/config.yaml`). Producción sigue en el camino **legacy**. Las defensas nuevas de esta parte (sentinels de disco, `assertChildEnvMinimal`) sólo se ejecutan en el camino **ON** (`buildChildEnv`). Se encienden en la parte 3 (#7636).
>
> **Repo público:** este doc lleva sólo **nombres** de variables y **rutas genéricas**. No incluye valores, hashes (tampoco los de `logs/env-allowlist-audit.log`), account IDs, usuarios ni chat IDs.

Las referencias `archivo:línea` corresponden a `main` en la fecha de este doc. Si se mueven, buscá el nombre de la función.

## Tabla resumen: sitios de spawn

| Sitio | Tipo | Variables hoy | Archivos legibles | Necesita |
|---|---|---|---|---|
| [`lanzarAgenteClaude`](#lanzaragenteclaude) (camino ON) | Agente LLM | `SYSTEM_ALLOWLIST` + `PIPELINE_*` + key del provider del intento + vars de los scopes efectivos (skill ∩ techo de la fase) + `TELEGRAM_CHAT_ID` + extras de transporte | Neutralizados si el rol no tiene el scope: `~/.aws/*` y la config de `gh`. El resto del home queda legible | Lo que declara `requires_credentials` del skill |
| [`lanzarAgenteClaude`](#lanzaragenteclaude) (legacy, **vigente**) | Agente LLM | `process.env` completo del intento, menos `TELEGRAM_BOT_TOKEN`, + extras | Todo el home del operador | Ídem |
| [Commander](#commander) (ON / legacy **vigente**) | Agente LLM | ON: igual que arriba, con fase sintética `kernel`. Legacy: `process.env` completo menos Telegram, + `CLAUDE_PROJECT_DIR` | Legacy: todo el home | Scope `github` |
| [`summaryBaseEnv`](#summarybaseenv) | Agente LLM (**Sí**) | `process.env` completo menos Telegram, + `CLAUDE_PROJECT_DIR` (sin rama ON) | Todo el home | Sólo la sesión OAuth del CLI; ninguna credencial de AWS ni de GitHub |
| [QA: generación de casos](#qa) | Servicio de confianza (**No** invoca LLM) | `envDeHijo`: `process.env` completo + `QA_ISSUE`, `GH_PATH` | Todo el home | GitHub (lee el issue con `gh`) |
| [`envDeHijo` / `envDeLanzador` / `envDeServicio`](#envdehijo) | Servicio de confianza | `process.env` completo + `PIPELINE_REPO_ROOT` + extras. **No quita nada**, ni Telegram | Todo el home | Depende del script (ver sección) |
| [builder (`build`)](#builder) | Servicio de confianza (no LLM) | El env del hijo determinístico (camino de `lanzarAgenteClaude`) + `JAVA_HOME`, `PATH`, `GRADLE_LOCK_PATH` | Todo el home en legacy | Scope `gradle-android` |
| [`adbEnv`](#adbenv) | Servicio de confianza (no LLM) | `{ ...process.env }` completo, **sin strip**, + `MSYS_NO_PATHCONV`, `MSYS2_ARG_CONV_EXCL` | Todo el home | Sólo `PATH` para encontrar `adb` |
| [`sherlock-verifier.js`](#sherlock-verifier) (×3 spawns) | Agente LLM | En producción `inherit`: `process.env` completo menos Telegram, + `CLAUDE_PROJECT_DIR` / `CODEX_MODEL` / `ANTIGRAVITY_MODEL` | Todo el home | Sólo la sesión OAuth del CLI |
| [`semantic-dedup.js`](#semantic-dedup) | Agente LLM (juez) | `buildMinimalCliEnv`: `SYSTEM_ALLOWLIST` + `CODEX_HOME` + `CLAUDE_CONFIG_DIR` + extras | El home queda legible (no hay sentinels en este camino) | Sólo la sesión OAuth del CLI |
| [Otros spawns sin env explícito](#otros) | Servicio de confianza | Heredan `process.env` completo | Todo el home | — |

## Tabla de fuentes de credenciales en disco y del sistema operativo

| Fuente | Ruta genérica | ¿Neutralizada en esta parte? | Issue que la cubre |
|---|---|---|---|
| Credenciales de AWS | `~/.aws/credentials` | **Sí (camino ON)**: `AWS_SHARED_CREDENTIALS_FILE` → sentinel inexistente, para roles sin scope `aws` | #7634 (esta parte) |
| Config de AWS (perfil `default` = cuenta con privilegios) | `~/.aws/config` | **Sí (camino ON)**: `AWS_CONFIG_FILE` → sentinel; además se quitan `AWS_PROFILE`/`AWS_DEFAULT_PROFILE` y `AWS_EC2_METADATA_DISABLED=true` | #7634 |
| Caché de SSO de AWS | `~/.aws/sso/cache` | **Parcial**: sin `~/.aws/config` el CLI no tiene perfil SSO que la use, pero el archivo sigue legible con lectura directa | #7355 |
| Config de `gh` | `%APPDATA%/GitHub CLI/hosts.yml` (Windows), `~/.config/gh/hosts.yml` | **Sí (camino ON)**: `GH_CONFIG_DIR` → ruta sentinel **inexistente** (sin `mkdirSync`), para roles sin scope `github` | #7634 |
| Keyring del SO (token de `gh` ≥ 2.40) | Administrador de credenciales de Windows | **Parcial**: sin `hosts.yml`, `gh` no sabe qué usuario buscar; `gh auth status` y `gh api user` fallan (test de integración C6). Un proceso que lea el keyring directamente no queda bloqueado | #7355 |
| Credential helper de git (GCM) | Administrador de credenciales de Windows, vía `git credential` | **No**: un agente puede hacer `git push` con las credenciales del operador | #7640 |
| Store unificado de credenciales | `~/.claude/secrets/credentials.json` | **No**: sigue legible desde el home | #7355 |
| Config de Telegram | `telegram-config.json` | **No** (el token ya no viaja por env: `stripReservedChildSecrets`) | #7355 |
| Secretos del pipeline | `.pipeline/*secrets*` | **No** | #7355 |
| Sesiones OAuth de CLIs | `~/.claude`, `~/.codex` | **No** en productivo (los CLIs las necesitan). En pruebas, `CLAUDE_CONFIG_DIR`/`CODEX_HOME` apuntan a un sentinel (#7113) | — |

Ver también `docs/pipeline/inventario-credenciales.md`.

---

<a id="lanzaragenteclaude"></a>
## `lanzarAgenteClaude`

- **Tipo:** Agente LLM (CLI `claude`, `codex` o `agy` según el provider del intento).
- **Dónde:** `.pipeline/pulpo.js:12836` (camino ON, `buildChildEnv`) y `:12868` (legacy). El spawn real está en `lib/agent-launcher.js` (`launchAgent`).
- **Env hoy (legacy, flag OFF):** `stripReservedChildSecrets(conDeclaracionExplicita({ ...attemptProcessEnv, ...pipelineExtras }))`. Es el env completo del intento (snapshot de credenciales si está activo), menos `TELEGRAM_BOT_TOKEN` por nombre (cualquier grafía de mayúsculas) o por valor.
- **Env con flag ON:** `buildChildEnv`, en este orden fijo: allowlist → `PIPELINE_*` → key del provider → scopes efectivos → `GH_TOKEN` si el rol tiene `github` → merge de extras → declaración de ambiente → neutralización de disco de los scopes ausentes → strip de reservadas → purga en pruebas → `assertChildEnvMinimal`.
- **Extras (nombres):** `PIPELINE_ISSUE`, `PIPELINE_SKILL`, `PIPELINE_FASE`, `PIPELINE_PIPELINE`, `PIPELINE_TRABAJANDO`, `PIPELINE_WORKTREE`, `PIPELINE_REPO_ROOT`, `PIPELINE_PROJECT_ID`, `PIPELINE_PROJECT_BINDING`, `PIPELINE_HANDOFF_PATH`, `PIPELINE_HANDOFF_ENABLED`, `PROVIDER_RESOLUTION_LOG`, y los de QA (`QA_MODE`, `QA_ISSUE`, `QA_BASE_URL`, `QA_FLAVOR`, `QA_EMULATOR_SERIAL`).
- **Necesita:** los scopes de `requires_credentials` en `agent-models.json` (o `DEFAULT_REQUIRES_BY_SKILL`), acotados por el techo de la fase (`SCOPES_BY_FASE`).

<a id="commander"></a>
## Commander

- **Tipo:** Agente LLM (`claude`; en fallback, `codex` o `agy`).
- **Dónde:** `.pipeline/pulpo.js:16881` (ON, `buildChildEnv` con `fase: KERNEL_FASE`) y `:16899` (legacy). Spawns en `attemptAnthropicSpawn` y en el fallback de `commanderMP.safeBuildSpawn`.
- **Env hoy (legacy):** `{ ...attemptProcessEnv }` + `CLAUDE_PROJECT_DIR`, se borra `CLAUDECODE` y, como última operación, `stripReservedChildSecrets`. A diferencia de `lanzarAgenteClaude`, esta rama no pasa por `conDeclaracionExplicita`.
- **Necesita:** scope `github` (skill `telegram-commander`).

<a id="summarybaseenv"></a>
## `summaryBaseEnv` (resumen de turnos del Commander)

- **Tipo:** Agente LLM. **¿Invoca un LLM? Sí.**
- **Evidencia:** `summarizeCommanderOlderTurns` en `.pipeline/pulpo.js:15371`. El spawn de `:15394` lanza `CLAUDE_LAUNCHER` (resuelto por `detectClaudeLauncher()`, `pulpo.js:1049-1075`: `@anthropic-ai/claude-code` o `claude.exe`) con `-p --output-format stream-json --model COMMANDER_SUMMARY_MODEL` (`pulpo.js:15347`).
- **Env hoy:** `.pipeline/pulpo.js:15389-15410`, `{ ...process.env }` completo + `CLAUDE_PROJECT_DIR` + `stripReservedChildSecrets`. No tiene rama con aislamiento.
- **Necesita:** sólo la sesión OAuth del CLI. Ninguna credencial de AWS ni de GitHub.

<a id="qa"></a>
## QA: generación de casos de prueba

- **Tipo:** Servicio de confianza. **¿Invoca un LLM? No.**
- **Evidencia:** `preflightQaChecks` en `.pipeline/pulpo.js:11302` corre `execSync` en `:11419-11424` con `envDeHijo({ QA_ISSUE, GH_PATH })`, que lanza `node qa/scripts/qa-generate-test-cases.js`. Ese script sólo requiere `child_process`, `fs` y `path` (`:19-21`). Su único proceso hijo es `gh issue view ... --json title,body,labels` (`:43-46`). Los casos salen de parsear el cuerpo del issue, y no hay referencias a `claude`, `codex`, `gemini`, APIs HTTP ni `*_API_KEY`.
- **Env hoy:** `process.env` completo (vía `envDeHijo`) + `QA_ISSUE`, `GH_PATH`.
- **Necesita:** GitHub, para leer el issue.
- El **agente** QA (skill `qa`) es otro sitio: se lanza por [`lanzarAgenteClaude`](#lanzaragenteclaude) y ése sí es un Agente LLM.

<a id="envdehijo"></a>
## `envDeHijo` / `envDeLanzador` / `envDeServicio`

- **Tipo:** Servicio de confianza (scripts propios del pipeline).
- **Qué hace:** `envDeHijo(extra)` (`.pipeline/pulpo.js:1298-1300`) y `envDeServicio(extra)` (`.pipeline/restart.js:122-124`) delegan en `envDeLanzador` (`.pipeline/lib/launcher-env.js:62-70`). Copia `process.env` **completo**, agrega `PIPELINE_REPO_ROOT` y los extras y fija la declaración de ambiente con `conDeclaracionExplicita`. **No quita ningún secreto, ni siquiera `TELEGRAM_BOT_TOKEN`.**
- **Usos:**

| Uso | Qué lanza | ¿LLM? |
|---|---|---|
| `pulpo.js:4090` · `rotateDiskCaches` | `node .claude/hooks/rotate-caches.js` | No |
| `pulpo.js:4182` · `diskGuardSpawn` | `rotate-caches.js` o `ghostbusters.js --worktrees --run --no-cap` | No |
| `pulpo.js:13973` · exit de `lanzarAgenteClaude` (muerte prematura) | `node rejection-report.js` (usa `gh` y TTS edge-tts, no LLM) | No |
| `pulpo.js:14415` · exit de `lanzarAgenteClaude` (rechazo) | `node rejection-report.js` | No |
| `pulpo.js:14694` · `brazoGhostbusters` | `node ghostbusters.js --worktrees` | No |
| `pulpo.js:18475` · `cmdRestart` | `cmd.exe /c` → `restart.js` (antepone un dir a `PATH`) | Indirecto: relanza el Pulpo |
| `pulpo.js:11419` · `preflightQaChecks` | ver [QA](#qa) | No |
| `restart.js:567` · `lanzarComponente` | cada componente de `COMPONENTS` (Pulpo, listener y servicios de Telegram, GitHub, Drive, emulador, reconciler, dashboard) + `NODE_PATH` | Indirecto: el Pulpo lanza LLMs con sus propios envs |
| `restart.js:881` · `launchRollbackOrphan` | `node rollback.js pipeline-stable` + `NODE_PATH`, `ROLLBACK_STDIO_IS_LOG` | No |

<a id="builder"></a>
## builder (`build`)

- **Tipo:** Servicio de confianza. No es LLM: `DETERMINISTIC_SKILLS` en `.pipeline/lib/agent-launcher/providers/deterministic.js` ("no van al LLM").
- **Dónde:** `skills-deterministicos/build.js:188` (`spawnGradle`), env en `:427`.
- **Env hoy:** `{ ...process.env }` del propio `build.js`, que ya es el env del hijo determinístico armado en [`lanzarAgenteClaude`](#lanzaragenteclaude) (legacy o ON) + `JAVA_HOME`, `PATH` (antepone `JAVA_HOME/bin`), `GRADLE_LOCK_PATH`.
- **Lanza:** `./gradlew ...` o `bash scripts/smart-build.sh`. Ninguno de los dos llama a un CLI de LLM.
- **Necesita:** scope `gradle-android`.

<a id="adbenv"></a>
## `adbEnv`

- **Tipo:** Servicio de confianza (no LLM).
- **Dónde:** `.pipeline/pulpo.js:14158`; `execSync` en `:14159` (`adb pull`) y `:14164` (`adb shell rm`), después de QA.
- **Env hoy:** `{ ...process.env }` **completo, sin strip** (hereda todo, incluido el token de Telegram) + `MSYS_NO_PATHCONV`, `MSYS2_ARG_CONV_EXCL`.
- **Necesita:** sólo `PATH`, para encontrar `adb`.

<a id="sherlock-verifier"></a>
## `sherlock-verifier.js`

- **Tipo:** Agente LLM. Hay tres spawns, uno por provider:
  - `spawnAnthropicComplete`: spawn en `:906`, env en `:873-880` (+ `CLAUDE_PROJECT_DIR`).
  - `spawnCodexComplete`: spawn en `:1091`, env en `:1061-1071` (+ `CODEX_MODEL`, `CLAUDE_PROJECT_DIR`).
  - `spawnAntigravityComplete`: spawn en `:1272`, env en `:1243-1253` (+ `ANTIGRAVITY_MODEL`, `CLAUDE_PROJECT_DIR`).
- **Env hoy:** los tres pasan por `resolveSpawnBaseEnv` (`:836-841`). Con `envPolicy: 'minimal'` usan `buildMinimalCliEnv` (`:838`); si no, heredan `env || process.env` (`inherit`, el default de `:821`). Los dos caminos terminan en `stripReservedChildSecrets`. **En producción** el Pulpo llama a `sherlockVerifier.verify` (`pulpo.js:20234`, `:20278`) sin `envPolicy`, así que Sherlock corre con `process.env` completo menos Telegram.
- **Necesita:** sólo la sesión OAuth del CLI.

<a id="semantic-dedup"></a>
## `semantic-dedup.js`

- **Tipo:** Agente LLM (juez de duplicados, sin agencia).
- **Dónde:** `dispatchComplete` (`:168`) llama a `sherlock._spawnCodexComplete` o `_spawnAnthropicComplete` con `JUDGE_SPAWN_POLICIES = { sandbox: 'read-only', envPolicy: 'minimal' }` (`:142`). Eso lleva a `buildMinimalCliEnv` (`lib/build-child-env.js`). Si el provider no se lanza por spawn, va por HTTP con `completionClient.complete`. Lo consumen `lib/commander/doc-create.js` y `lib/duplicate-detector.js`.
- **Env hoy:** `SYSTEM_ALLOWLIST` + `CODEX_HOME` + `CLAUDE_CONFIG_DIR` + extras, con nombres normalizados sin distinguir mayúsculas (#7634), y `stripReservedChildSecrets` al final. No tiene sentinels de disco: el home sigue legible.
- **Necesita:** sólo la sesión OAuth del CLI.

<a id="otros"></a>
## Otros spawns sin env explícito

No pasan `env`, así que heredan `process.env` completo sin strip:

- `pulpo.js:24819` · `runReclaimChild`: `node skills-deterministicos/delivery.js --reclaim` (no LLM).
- `pulpo.js:12609`: `adb shell screenrecord` durante QA.
- `lib/agent-launcher/providers/openai-codex.js:281` · `probeCodexHealth`: `codex --version` (lanza el binario, sin prompt).
- `lib/commander-deterministic.js:2258`: `dashboard.js` con `{ ...process.env }` explícito.
- Los `execSync` / `execFileSync` de `gh`, `git`, `adb`, `taskkill`, `wmic` y `tasklist` en `pulpo.js` y `restart.js`, y `edge-tts` en `multimedia.js`.

---

## Qué agrega #7634 (camino ON, flag todavía apagado)

- **`lookupEnvCI`**: los nombres se buscan sin distinguir mayúsculas y la salida usa el nombre canónico (`Path` → `PATH`, `windir` → `WINDIR`). Aplica a la allowlist, los scopes, la key del provider y `buildMinimalCliEnv`, y también del lado que **bloquea**: `stripReservedChildSecrets` quita `telegram_bot_token` en cualquier grafía, incluso en el camino legacy.
- **Sentinels** (`lib/credential-sentinel.js`): para un rol **sin** scope `aws`, se quitan `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN` y `AWS_CONTAINER_CREDENTIALS_*`, `AWS_SHARED_CREDENTIALS_FILE`/`AWS_CONFIG_FILE` apuntan al sentinel y se fija `AWS_EC2_METADATA_DISABLED=true`. Para un rol **sin** scope `github`, se quitan `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` y `GITHUB_ENTERPRISE_TOKEN`, y `GH_CONFIG_DIR` apunta a una ruta inexistente que nunca se crea. Un rol **con** scope `github` recibe `GH_TOKEN` antes de la neutralización, y a ése nunca se le redirige `GH_CONFIG_DIR`.
- **`assertChildEnvMinimal`** + **`ChildEnvViolation`** (`lib/child-env-error.js`, code `CHILD_ENV_VIOLATION`): ver abajo.

## Cómo leer un `CHILD_ENV_VIOLATION`

```
[entorno-hijo] Lanzamiento bloqueado · rol=<skill> · fase=<fase> · intento=<provider>
Motivo: <frase> → NOMBRE_A, NOMBRE_B (<kind>)
Cómo seguir: si el rol la necesita, declarar el scope en agent-models.json (requires_credentials). Detalle en docs/pipeline/entorno-agentes-hijos.md.
Ver: docs/pipeline/entorno-agentes-hijos.md#<sitio>
```

| `kind` | Frase | Qué significa |
|---|---|---|
| `undeclared` | variable no declarada para este rol | La clave no está en la allowlist, ni es `PIPELINE_*`, ni es la key del provider del intento, ni es de un scope efectivo, del neutralizador, de transporte o una excepción |
| `reserved-alias` | credencial reservada bajo otro nombre | Una credencial de AWS, GitHub, provider o Telegram (`ISOLATION_RESERVED_NAMES`) aparece fuera de su scope efectivo. Se compara sin distinguir mayúsculas |
| `case-duplicate` | la misma variable aparece dos veces con distinta grafía de mayúsculas | En Windows el ganador es indefinido |
| `unknown-phase` | fase desconocida | La fase no está en `SCOPES_BY_FASE` |
| `unknown-skill` | rol sin declaración de entorno | El skill no está en `agent-models.json` ni en `DEFAULT_REQUIRES_BY_SKILL` |
| `invalid-exception` | excepción inválida (comodín o credencial reservada) | Las reservadas ganan sobre las excepciones y no se aceptan comodines |
| `expired-exception` | excepción vencida (requiere revisión humana) | La variable sólo estaba cubierta por una excepción de `env-exceptions.yaml` cuya `revisar_el` ya pasó. El mensaje muestra la fecha y el aprobador |
| `aws-access-key`, `github-token`, `provider-key`, `telegram-token`, `jwt` | valor con forma de secreto (…) en | Un valor con forma de credencial bajo un nombre que no es de su scope |

El mensaje sólo lleva nombres (ordenados alfabéticamente). Nunca incluye valores, prefijos, largos, hashes ni máscaras. `JSON.stringify(err)` serializa sólo `{ name, code, message, details }`.

El encendido y la telemetría llegan en #7636.

<a id="excepciones-declaradas-y-gate-de-permisos"></a>
## Excepciones declaradas y gate de permisos

Agregado en #7635. Cada excepción al entorno mínimo queda escrita con su motivo, un responsable y una fecha de revisión. Ningún cambio de permisos entra a `main` sin que el operador lo mire.

### Formato de `.pipeline/env-exceptions.yaml`

Es una lista YAML. Cada entrada lleva estos campos, todos obligatorios:

| Campo | Valor |
|---|---|
| `tipo` | `agente` (un skill del pipeline) o `servicio` (un servicio de confianza del inventario de arriba) |
| `rol` | nombre del skill o del servicio |
| `scope` **o** `variable` | exactamente uno de los dos: un scope de `CREDENTIAL_SCOPES` o el nombre de una variable |
| `fundamento` | por qué el rol la necesita (texto libre, no vacío) |
| `aprobador` | usuario de GitHub, `^@?[A-Za-z0-9-]{1,39}$` |
| `revisar_el` | fecha ISO `AAAA-MM-DD`, entre comillas |

Lo lee `lib/child-env-exceptions.js` (`loadExceptions`, `forAgent`, `forService`) con estas reglas:

- **La ruta sale de `__dirname`**, es decir, del repo principal que ejecuta el Pulpo. Nunca sale de `process.cwd()` ni de una variable de entorno. Así, un agente que edita el YAML en su worktree no consigue nada hasta que el cambio se mergea.
- **Vencimiento:** con `revisar_el` igual a hoy o posterior, la entrada está vigente. Si es anterior, está vencida. "Hoy" se calcula en `America/Argentina/Buenos_Aires`. Una variable cubierta sólo por una excepción vencida frena el lanzamiento con `expired-exception`, y el mensaje muestra la fecha y el aprobador. El `fundamento` no se muestra nunca.
- **Tope de 180 días:** una `revisar_el` que pasa de hoy + 180 días hace que la entrada se descarte.
- **Reservadas:** una entrada que da AWS, GitHub, keys de providers o Telegram (`ISOLATION_RESERVED_NAMES` ∪ `RESERVED_CHILD_SECRET_NAMES`, más un piso propio del loader) se descarta al cargar. Esos permisos sólo los da `SCOPES_BY_FASE`.
- **Fail-closed:** una entrada con un campo faltante, una clave desconocida, `scope` y `variable` a la vez, o una fecha inválida (incluido `2026-02-30` o un `Date`) se descarta. Si el archivo está roto, se descartan todas: pasa con un YAML ilegible, con claves duplicadas, con una raíz que no es lista o con más de 64 KB. En ese caso se aplican cero excepciones y `buildChildEnv` avisa con un warn.
- **Servicio ≠ agente:** `forAgent` sólo mira `tipo: agente`. Un skill que se llame igual que un servicio no hereda su excepción. Las entradas `tipo: servicio` son **declarativas** hasta #7636, porque esos servicios no pasan por `assertChildEnvMinimal`.

El archivo real declara el inventario de servicios de confianza: `envDeHijo`, `envDeServicio`, `adbEnv`, `builder`, `vault` y `notificadores`. `lib/__tests__/env-exceptions-inventory.test.js` verifica que estén todas vigentes y con fundamento. Si ese test se pone en rojo porque venció una fecha, la excepción hay que revisarla y renovarla con un PR. La fecha del test no se toca.

Las excepciones se aplican sólo en el camino ON (`env_isolation_enabled: true`). Con el flag apagado, nada cambia en producción.

### Datos de permisos fuera del código

`SYSTEM_ALLOWLIST`, `CREDENTIAL_SCOPES`, `SCOPES_ALWAYS_ON`, `SCOPES_BY_FASE`, `CLI_OAUTH_ALLOWLIST` y `DEFAULT_REQUIRES_BY_SKILL` viven en `.pipeline/lib/child-env-scopes.json`. `build-child-env.js` los carga y los congela en profundidad, y conserva los mismos nombres de export. Así el gate los protege por path, sin hacer `require()` del código del PR.

### Gate de permisos en delivery (paso 4b)

`lib/permission-change-guard.js` (`detectPermissionChanges`) corre en `attemptMergeWithGates` justo después del paso de CODEOWNERS, dentro del mismo intento. Ante un `head-changed` se vuelve a evaluar. Un PR queda frenado con `needs-human` y gate `permisos` cuando:

- toca **por path** (alta, baja, cambio o renombre, incluido `previous_filename`) `env-exceptions.yaml`, `lib/child-env-scopes.json`, `lib/child-env-exceptions.js`, `lib/permission-change-guard.js` o `lib/build-child-env.js`. Este último es el motor que arma el env del hijo: transporte, reservadas y assert;
- cambia **por contenido** `requires_credentials` de algún skill, o `credentials_env`/`auth_mode` de algún provider, en `agent-models.json`. Cambiar sólo el provider o el modelo de un skill **no** frena. Crear o borrar el archivo también frena;
- cambia `pipeline.env_isolation_enabled` en `config.yaml`;
- quita la invocación del guard en `skills-deterministicos/delivery.js` (autoprotección).

El contenido se lee con `git show origin/main:<path>` y `git show <headRefOid>:<path>`, con `spawnSync` y sin shell. La lista de archivos sale de `gh api --paginate .../pulls/N/files`, que trae los renombres. Si la API falla, se usa la del snapshot, que se marca incompleta a partir de 100 archivos.

**Fail-closed:** una lista incompleta, un `git show` que falla, un JSON o YAML que no parsea, un `checkPermissions` que tira o que no está inyectado dan `needs-human` o `blocked`. Nunca se leen como "sin cambios".

**Cómo se destraba:** delivery aplica el label `needs-human`, comenta el PR con los motivos y escala como bloqueo humano, sin rebote a dev y sin `rev++`. El operador revisa el diff y **mergea a mano**. No existe un label que lo apruebe: el pipeline opera con la misma cuenta que el operador (#5986), así que un agente podría ponérselo solo. El campo `aprobador` del YAML es declarativo y no es una firma. Cuando GATE 2 (firma humana) esté enforzado, este gate lo va a usar.

**Límite conocido:** el gate protege el camino de `delivery`. Un agente con token de GitHub que ejecute `gh pr merge` a mano lo saltea. El respaldo es la protección de rama de `main`, que queda fuera de este alcance.
