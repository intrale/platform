## 🔧 Implementación — fase `dev` (agente `pipeline-dev`)

Rama **`agent/5220-pipeline-dev`** · commit **`56c9326d2`** (sobre `origin/main` `07c5902b2` + `agent/5220-ux-assets` `a4bf875`).

Ningún valor de credencial fue impreso en esta pasada: los hallazgos se identifican por `sha256[0:8]` y longitud.

### ✅ CA-2.a — productor identificado (verificado por mí en esta pasada)

Ratifico el hallazgo de `guru` comprobándolo de nuevo sobre el disco real:

```
$ ls -l /c/Workspaces/bin/claude-session
-rwxr-xr-x 2346 bytes  abr. 4 17:34

$ sed -n '57,62p' /c/Workspaces/bin/claude-session
git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WORKTREE_PATH" origin/main --quiet
# Copy .claude config so hooks/permissions work
if [ -d "$REPO_ROOT/.claude" ]; then
  cp -r "$REPO_ROOT/.claude" "$WORKTREE_PATH/.claude" 2>/dev/null || true   <- SIN rm -rf previo

$ git -C /c/Workspaces/bin rev-parse --is-inside-work-tree
fatal: not a git repository        <- el productor NO esta versionado
```

**El issue se cierra por la vía CA-2.d**, no afirmando prevención: el archivo a corregir vive fuera del repo y sin versionar (#5264). Lo que entrega esta historia es **detección garantizada**.

### ✅ CA-2.b — verificación empírica sobre un worktree REAL (no inspección de código)

Reproduje el mecanismo exacto del productor en un repo git de prueba, con una credencial **sintética**. No repliqué la viva a propósito: crear una copia más de un token vigente sería agravar la exposición que la historia viene a cerrar.

```
$ git init main && ... && git add .claude && git commit     # .claude TRACKEADO, 3 archivos
$ git worktree add -b session/x ../main.session-repro main --quiet
$ cp -r .claude ../main.session-repro/.claude               # el mecanismo real, sin rm -rf

== anidamiento producido ==
../main.session-repro/.claude/.claude                       <- SI, anida en vez de fusionar
../main.session-repro/.claude/.claude/hooks/telegram-config.json

=== BARRIDO SOBRE ESE WORKTREE REAL ===
  historial       telegram_bot_token sha256:4dfca16b len=50 -> .claude/hooks/telegram-config.json
  purgable        telegram_bot_token sha256:4dfca16b len=50 -> .claude/.claude/hooks/telegram-config.json
no-verificables: 0
quickcheck: {"nestedClaudeCopies":1}
purgables detectados (dry-run): 1 | protegidos: 1
```

El barrido detecta la reaparición y clasifica bien las dos instancias de la misma credencial: la trackeada como `historial` (borrarla no remedia) y la anidada untracked como `purgable`.

Y el camino que **sí** modifiqué (allowlist de `dev-functions.sh`) no filtra:

```
=== copiado con allowlist ===
settings.json
skills/x.md
=== telegram-config.json presente? ===
NO — la credencial no se copio
```

### 📊 Estado real de la exposición (dry-run sobre el disco, `--secrets`)

```
🔐 secretos: 68 raíces, 3260 archivos
🔴 EXPUESTO — credenciales replicadas: 13 a ROTAR · 419 a REVISAR · 52 a PURGAR

Secretos filtrados · re-materializables por historial: 13 en 1 credencial(es) distinta(s)
  ● ROTAR telegram_bot_token sha256:760e3f4b · 46 chars · rotación PENDIENTE   (x13 worktrees)

Secretos filtrados · purgables: 52 en 5 credencial(es) distinta(s)
  ● PURGAR telegram_bot_token   sha256:760e3f4b ·  46 chars · x13
  ● PURGAR openai_api_key       sha256:012d9e18 · 164 chars · x13
  ● PURGAR google_client_secret sha256:d2c357a4 ·  35 chars · x11
  ● PURGAR google_refresh_token sha256:52324df5 · 103 chars · x11
  ● PURGAR google_client_secret sha256:4798d1eb ·  35 chars · x2     <- 2da generacion
  ● PURGAR google_refresh_token sha256:01f4ee50 · 103 chars · x2     <- 2da generacion

exit=4
```

**Confirmo empíricamente las 2 generaciones de las credenciales de Google** que advertía R8: hashes distintos (`d2c357a4` / `4798d1eb` y `52324df5` / `01f4ee50`). La rotación tiene que revocar **ambas**.

Sobre los **419 `no verificables`**: son 6 archivos de estado del pipeline (`agent-metrics.json`, `tg-session-store.json`, `auto-review-state.json`, `scrum-monitor-state.json`, `agent-registry.json`) replicados en worktrees abandonados, con **marcadores de conflicto de git sin resolver** (`<<<<<<<`). Son JSON genuinamente roto, así que CA-5 manda contarlos como no-verificables y así quedan. Además agregué un barrido de **texto crudo** sobre ellos: sin eso el operador leería «no pude verificar» y seguiría de largo, quedando ciego ante un secreto adentro. La pasada extra sólo agrega hallazgos, nunca reduce el conteo ni relaja el fail-closed.

### ⏱️ CA-8 — medición y decisión

| Corrida | Tiempo | Decisión |
|---|---|---|
| `--secrets` (barrido completo) | **~7 s** (scan 3,4 s + git 3,5 s) | por encima del techo de 5 s |
| default sin flags (chequeo barato) | **~34 ms** | 68 `stat`, sin parsear ni consultar git |

Tomo la **vía alternativa que CA-8 habilita**: la categoría queda detrás de `--secrets` y la corrida default hace sólo el chequeo barato, que cuenta copias anidadas `.claude/.claude` (**33**, idéntico a lo medido por `guru` y `po`) y avisa con un banner `🟠 POSIBLE EXPOSICIÓN`. Esto además disuelve **R1** de raíz: la categoría nueva no se enciende sola en cada corrida.

Antes de tomar esa vía bajé el costo de 11,5 s a 7 s resolviendo el toplevel de git por filesystem en lugar de spawnear `git rev-parse` por raíz.

### ✅ CA-4 — el barrido no degrada el estado git de ningún worktree

Sobre los 3 worktrees con más trabajo sin commitear del disco real:

```
platform.session-fixpipe-20260424-081815: IDENTICO (1177 entradas)
platform.session-fixpipe-20260415-111955: IDENTICO (5 entradas)
platform.session-fixpipe-20260413-172057: IDENTICO (5 entradas)
```

Cero entradas nuevas, cero trackeados nuevos en `M` / `D`.

### ✅ CA-5 / R10 — exit codes sin romper callers

`ghostbusters.js` no tenía **ningún** `process.exit` (A3). Ahora tiene códigos semánticos (UX-6): `2` purgables · `3` no-verificables · `4` historial sin rotación. **La corrida default sigue saliendo `0`** porque `secrets` no está en las categorías por default — R10 mitigado por construcción, ningún caller actual cambia de comportamiento. Verificado: `exit_default_path=0`.

### 🔴 CA-7 — pendiente, y el issue NO se puede cerrar afirmando lo contrario

La secuencia es **revocación → reprovisión en el store → purga**, y el paso 1 es una acción humana (BotFather, Google Cloud Console, dashboard de OpenAI) que un agente no puede ejecutar.

- **No corrí la purga real (`--run`)**, deliberadamente: purgar antes de rotar destruye la evidencia de qué hay que rotar (R8 / SEC-1). Toda la evidencia de arriba sale de `--dry-run`.
- Las 4 credenciales (2 con doble generación) figuran como **`rotación PENDIENTE`** en el reporte, y el registro `.pipeline/secret-rotations.json` todavía no existe — que es el default fail-closed.
- La revocación del bot token ya publicado en `origin/main` sigue coordinada con **#5237**.

Cuando la rotación ocurra se registra así, y recién ahí el barrido deja de marcarla pendiente:

```json
{ "rotations": [
  { "hash8": "760e3f4b", "kind": "telegram_bot_token",
    "rotated_at": "AAAA-MM-DD", "revoked": true, "verified_at": "AAAA-MM-DD" }
]}
```

### ✅ CA-3 / CA-6 / CA-10 — tests

`npm run test:pipeline`: **7803 tests, 0 fail, 4 skipped** (baseline de `guru`: 7760 con 0 fail → +43 tests, exactamente los que agregué).

Los tres bloqueantes están escritos como test, no como intención:

- **CA-3** — `classifyValue nunca devuelve el valor ni una subcadena suya` y `fmtReport no contiene ninguna subcadena de 8 o mas caracteres del valor sintetico`. Ambos iteran **todas** las subcadenas de 8+ chars, así que fallan ante prefijo o sufijo, no sólo ante el valor completo. El control es estructural: el `Finding` no tiene campo `value`.
- **CA-5** — `el CLI sale con codigo distinto de cero ante no verificables`.
- **CA-6** — `fmtReport no imprime Sistema sano cuando hay hallazgos de secretos`, en el mismo commit que agrega la categoría.

El diff **no** incluye ningún archivo con valores reales de credenciales (verificado por grep de las 5 formas sobre `git diff HEAD`: sin coincidencias fuera de los valores sintéticos de los tests).

### Archivos

| Path | Qué |
|---|---|
| `.pipeline/lib/secret-leak-scan.js` | **nuevo** — clasificador de dos ejes, barrido, 3 categorías, purga |
| `.pipeline/lib/claude-copy-allowlist.js` | **nuevo** — allowlist deny-by-default, fuente única de las listas |
| `.pipeline/ghostbusters.js` | categoría `secrets`, `otherCounts`, sección de reporte, exit codes |
| `.pipeline/lib/telegram-secrets.js` | export aditivo de `isLikelyToken` / `looksLikePlaceholder` (A2) |
| `.pipeline/lib/redact.js` | patrones `GOCSPX-`, `1//`, bot token — **sin** `topology` (R3) |
| `scripts/cli-branch.js` · `scripts/dev-functions.sh` | allowlist (el `rm -rf` previo se conserva) |
| `.claude/skills/ghostbusters/SKILL.md` | documentación del barrido, exit codes y registro de rotaciones |
| 4 archivos de test | 43 tests, incluidos los 3 bloqueantes |

> Implementación del agente `pipeline-dev` · pipeline `desarrollo`, fase `dev` · issue #5220.
