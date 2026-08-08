## ✅ QA · pasada 3 — los 2 bloqueantes de la review rev-1, verificados sobre `bc7abe970`

**Veredicto: aprobado** · modo `structural` + gate visual · **HEAD evaluado `bc7abe970`** (no `7bfa4e3e1`, que es lo que aprobó la pasada 2) · PR #5277.

No reciclé nada de la pasada anterior: volví a ejecutar todo sobre el HEAD nuevo. Ningún valor de credencial aparece en este comentario — los hallazgos se identifican por `sha256[0:8]` y longitud.

---

### BLOQUEANTE 1 — `purgeFindings` operaba por hallazgo pero borraba por archivo · **corregido**

Reproduje el escenario exacto de la review sobre el disco real, con un `fsImpl` inyectado que emula el borrado. **Ningún archivo real se tocó.**

```
raices= 68 archivos= 3261 hallazgos= 484
categorias= {"no-verificable":419,"historial":13,"purgable":52}
purgables= 52 | archivos distintos= 13 | archivos con >=2 credenciales= 13

--- simulacion --run (fsImpl fake, disco intacto) ---
purged con removed=true         = 52 / 52      <- la review medía 13 / 52
archivos realmente unlinkeados  = 13 / 13
SKIPPED de categoria purgable   = 0            <- la review medía 39 (ENOENT)
EXIT solo-purgables tras --run  = 0 (CLEAN)    <- la review medía 2 (PURGABLE_PENDING)
EXIT global tras --run          = 4 (UNROTATED, correcto: los 13 de historial siguen sin rotar)
archivos que SIGUEN en disco real = 13 / 13
```

El fix es `decidePurge` memoizado por archivo (`secret-leak-scan.js:551-596`): la decisión se toma una vez y se propaga a todos los hallazgos de ese archivo. Un ENOENT de un archivo ausente **antes** de la corrida sigue siendo skip legítimo.

**El tercer punto de la review también está cerrado:** los skips dejaron de ser mudos. Verificado con fixture:

```
seccion "Purgas omitidas" presente = true
  *Purgas omitidas:* 1
    ● REVISAR platform.session-y/.claude/hooks/telegram-config.json — openai_api_key · unlink: EPERM: operation not permitted
```

---

### BLOQUEANTE 2 — el test de CA-3 era tautológico · **corregido**

Leer el test nuevo no alcanza para saber si defiende algo. **Hice mutation testing yo mismo**: rompí el invariante a propósito en 3 puntos del código y exigí que la suite se pusiera roja.

| Mutante | Resultado |
|---|---|
| `walkJson` lleva el valor **+** `mkFinding` lo copia al `Finding` | ✖ 1 fail — `JSON.stringify(report) filtró una subcadena de 8 chars de "bot_token" (offset 0)` |
| se borra `process.exitCode = exitCode` (`ghostbusters.js:1482`) | ✖ 1 fail — `el proceso tiene que salir 3 (UNVERIFIABLE), salió 0` |
| se revierte la dedup por archivo de `purgeFindings` | ✖ 1 fail — `purgeFindings marca como eliminados todos los hallazgos de un archivo con varias credenciales` |

Dato que vale la pena registrar: mutar **un solo** punto no mata el test, porque el invariante está sostenido en **dos** lugares independientes (`walkJson` no carga el valor **y** `mkFinding` whitelistea campos). Eso es defensa en profundidad real, no un hueco de cobertura.

Después restauré el árbol byte a byte (`git status --porcelain` vacío para ambos archivos) y re-ejecuté: **72 tests, 72 pass, 0 fail, 0 skipped** (eran 64 en la pasada 2).

---

### CA-3 verificado contra las credenciales REALES en disco, no contra sintéticas

Son **6 credenciales distintas**, incluidas las **dos generaciones** de cada una de las dos de Google (el punto que R8 marcaba como obligatorio). De cada valor busqué **todas** sus subcadenas de 8+ caracteres en las 459 líneas del reporte:

```
telegram_bot_token    len=46   sha8=760e3f4b  hash_en_reporte=true  SUBCADENAS_8_FILTRADAS=0
openai_api_key        len=164  sha8=012d9e18  hash_en_reporte=true  SUBCADENAS_8_FILTRADAS=0
google_client_secret  len=35   sha8=d2c357a4  hash_en_reporte=true  SUBCADENAS_8_FILTRADAS=0
google_refresh_token  len=103  sha8=52324df5  hash_en_reporte=true  SUBCADENAS_8_FILTRADAS=0
google_client_secret  len=35   sha8=4798d1eb  hash_en_reporte=true  SUBCADENAS_8_FILTRADAS=0
google_refresh_token  len=103  sha8=01f4ee50  hash_en_reporte=true  SUBCADENAS_8_FILTRADAS=0
TOTAL_SUBCADENAS_FILTRADAS = 0
grep de las 4 formas de secreto sobre el reporte -> 0 / 0 / 0 / 0
```

El `client_secret` mide 35 chars, por debajo del `HIGH_ENTROPY_MIN_LEN = 40` de `redact.js` — precisamente el hueco de R3. No se filtra porque el control es **estructural**, no por redacción tardía.

---

### CA-2.b verificado ejercitando el mecanismo real, no leyendo el código

Ejecuté el **bloque real de copia** de `scripts/dev-functions.sh:107-131` (el camino que sí se ejecuta, productor de los `platform.agent-*`) sobre un `.claude` sembrado con credenciales en 4 formas, incluidas variantes que una allowlist por ruta exacta dejaría pasar (`.bak`, subcarpeta `hooks/tests/`):

```
ORIGEN  : 8 archivos (6 con credenciales)
DESTINO : 2 archivos  ->  ./settings.json  ·  ./skills/qa/SKILL.md
barrido del destino: 1 archivo escaneado · 0 hallazgos · 0 errores · 0 no parseables
```

---

### Gate visual — 13/13 reglas, 0 divergencias bloqueantes

El PR versiona el mockup 46, así que aplica gate visual aunque el issue sea `area:infra`. Capturé el render de **esta** pasada y lo comparé lado a lado.

```
$ node .pipeline/ghostbusters.js --secrets --dry-run
🔐 secretos: 68 raíces, 3261 archivos, 484 hallazgos
🔴 *EXPUESTO* — credenciales replicadas: 13 a ROTAR · 419 a REVISAR · 52 a PURGAR
EXIT=4   duración 1445 ms
```

R1..R12 como en la pasada 2, más **R13 (nueva)**: la sección `Purgas omitidas` respeta el vocabulario `REVISAR`, lleva glifo + palabra, imprime el motivo y no trunca.

3 divergencias cosméticas, ninguna bloquea: (1) la línea 1 imprime `484 hallazgos`, total agregado que el panel A no dibuja — ya en #5327; (2) el panel A ubica el skip `EPERM` bajo *no verificable*, el código lo pone en su propia sección con vocabulario `REVISAR`, coherente con el panel C; (3) el panel A dibuja `exit 3` donde su propio panel D manda `4` — la contradicción está en el mockup, el código sigue la tabla normativa.

---

### Resto de los criterios

| CA | Estado | Evidencia de esta pasada |
|---|---|---|
| CA-1 | ✅ | 13 / 419 / 52 disjuntas, con verbos distintos por categoría |
| CA-2 | ✅ | allowlist deny-by-default + worktree nuevo barrido con 0 hallazgos |
| CA-3 | ✅ | 0 subcadenas filtradas sobre 6 credenciales reales |
| CA-4 | ✅ | `git status` de `platform.session-fix-20260413-122542` **antes y después** del barrido: `diff` vacío. Los 2 trackeados en `M` son de abril, previos |
| CA-5 | ✅ | 419 no-verificables como categoría propia · CLI real sale **4**, nunca 0 |
| CA-6 | ✅ | 0 ocurrencias de `Sistema sano` / `No hay fantasmas` con 484 hallazgos |
| **CA-7** | ❌ | **`.pipeline/secret-rotations.json` no existe · `rotación PENDIENTE` · nada purgado** |
| CA-8 | ✅ | 1445 ms (techo 5 s) · `defaultCats` excluye `secrets` (`ghostbusters.js:192`) |
| CA-9 | ✅ | `isForbiddenTarget` en `:569` · `removeWorktree` y `rmSync` aparecen **sólo en comentarios**, 0 llamadas |
| CA-10 | ✅ | 72/72 tests · las 5 cadenas con forma de secreto del diff son sintéticas (`Fake`/`Synthetic`) y viven **sólo** en `__tests__/` · `telegram-config.json` no está en el diff |

---

### ⚠️ La exposición NO queda cerrada

Apruebo la **herramienta de detección**, no el cierre de la exposición. **CA-7 sigue en `falla`** y lo dejo explícito: los **52 purgables y los 13 por historial siguen en disco**, y el token `sha8 760e3f4b` sigue con rotación **PENDIENTE**. El código reporta ese estado con honestidad — por eso sale `4`.

El PR usa `Refs`, no `Closes`: el merge **no** cierra este issue. La remediación real (rotación + purga efectiva) vive en **#5322**.

**Evidencia:** video narrado 6:13 / 8949 KB (`qa/evidence/5220/qa-5220.mp4`, también en `.pipeline/logs/media/`) · comparación del gate visual `qa-5220-comparacion-pass3.png` · render crudo `render-real-pass3.txt` (459 líneas) · 9 frames.
