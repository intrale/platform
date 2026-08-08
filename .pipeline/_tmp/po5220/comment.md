## ✅ Aceptación PO — pasada 3 (HEAD `bc7abe970`, PR #5277)

Aprobado **con descope explícito de CA-7**. Toda la evidencia de abajo la produje **en esta pasada** sobre `bc7abe970`; no reciclé nada de mi aprobación anterior (que fue sobre `7bfa4e3e1`, antes del rebote de `review` rev-1).

### PASO 0.A — clasificación de scope

Labels: `area:infra`, `area:pipeline`, `area:seguridad`, sin ningún `app:*` → no hay UI de usuario. **Pero el PR versiona un mockup**, así que aplica la excepción crítica de #4568 y corresponde **QA visual**, no estructural:

```
$ gh pr diff 5277 --name-only | grep mockups
.pipeline/assets/mockups/46-ghostbusters-secretos-filtrados.svg
.pipeline/assets/mockups/narrativa-ghostbusters-secretos.md
```

### PASO 0.B — gate visual, ejecutado por mí

Leí el mockup 46 como imagen y lo crucé contra el render real que generé yo:

```
$ node .pipeline/ghostbusters.js --secrets --dry-run
exit=4  ms=2308   (459 líneas, 68 raíces, 3261 archivos, 484 hallazgos)
```

**Corrijo mi propio hallazgo de la pasada anterior.** Había marcado como divergencia que la línea 1 imprimía un total agregado (`484 hallazgos`) donde el panel A del mockup pide "sin total agregado (CA-1)". Es incorrecto: esa línea **no forma parte del reporte**. Llamé a `fmtReport` directamente sobre el `report` real:

```
=== REPORTE (fmtReport) primeras lineas ===
1: 🔴 *EXPUESTO* — credenciales replicadas: 13 a ROTAR · 419 a REVISAR · 52 a PURGAR
2: 👻 *Ghostbusters* [DRY-RUN] — 2026-08-01 15:55:26
4: *Secretos filtrados · re-materializables por historial:* 13 en 1 credencial(es) distinta(s)

contiene "484 hallazgos"? false     <- el total agregado NO esta en el reporte
contiene "Sistema sano"?  false
marcadores de truncado:   0
total lineas del reporte: 458
```

El `484 hallazgos` es una línea de progreso de consola (`ghostbusters.js:1069`, `log()`, silenciable por `LOG_QUIET`). El reporte entregable arranca con el banner de las tres categorías por separado — **exactamente el panel A**. Dejé la corrección en #5327.

**Divergencias que sí quedan, ambas cosméticas:**

1. Orden de secciones: el mockup dibuja historial → purgable → no-verificable; el código emite historial → no-verificable → purgable. Ninguna categoría falta ni se trunca.
2. El panel A del mockup dibuja `exit 3` donde su **propio** panel D manda `4` para "credencial sin rotar". La contradicción está dentro del mockup; el código sigue la tabla normativa. Verificado:

```
EXIT_CODES = { CLEAN:0, COMMAND_ERROR:1, PURGABLE_PENDING:2, UNVERIFIABLE:3, UNROTATED:4 }
exit real observado = 4
```

**Divergencias bloqueantes: 0.**

### Criterios de aceptación — verificados por mí, no tomados del `.qa`

| CA | Estado | Evidencia de esta pasada |
|----|--------|--------------------------|
| CA-1 | ✅ | `{"no-verificable":419,"historial":13,"purgable":52}` — disjuntas, con verbos distintos y sin total agregado en el reporte |
| CA-2 | ✅ (vía CA-2.d) | ver abajo |
| CA-3 | ✅ | ver abajo |
| CA-4 | ✅ | `git status --porcelain` de `platform.session-fix-20260413-122542` tras mi barrido: 3 entradas, las 2 en `M` son de abril y no las tocó el barrido; 0 entradas nuevas |
| CA-5 | ✅ | 419 no-verificables como categoría propia, nunca contados como limpio; `exit=4` |
| CA-6 | ✅ | 0 ocurrencias de `Sistema sano` / `No hay fantasmas` con 484 hallazgos. Y en la corrida **default** (sin flags) imprime `🟠 POSIBLE EXPOSICIÓN — 33 copia(s) anidada(s)` manteniendo `exit 0` |
| CA-7 | ❌ | **NO cumplido** — descope explícito, ver abajo |
| CA-8 | ✅ | comando completo en **2308 ms** (techo R1 = 5 s); `ghostbusters.js:202` → `defaultCats = knownCats.filter(c => c !== 'secrets')`; corrida default `exit 0`, contrato de los callers intacto |
| CA-9 | ✅ | purga sólo por archivo y sólo untracked; `security` lo probó con 7 entradas maliciosas en sandbox (traversal, repo principal, directorio, symlink) — 6 SKIP, 1 borrado legítimo |
| CA-10 | ✅ | `node --test` sobre los 4 archivos del issue: **tests 72 · pass 72 · fail 0 · skipped 0** (999 ms), corrido por mí |
| UX-1..7 | ✅ | **432 paths listados** (13 historial + 419 no-verificable) contra 432 declarados, **0 marcadores de truncado**; banner antes del header; glifo + palabra ROTAR/REVISAR/PURGAR; EXIT_CODES = panel D |

#### CA-3 — verificación independiente contra las credenciales reales del disco

No acepté la medición del QA. Tomé los valores **reales** con forma de secreto presentes en los 96 `telegram-config.json` de los worktrees y barrí **todas** sus ventanas de 8 chars contra el reporte de texto **y** contra la salida `--json`:

```
archivos leidos: 96 | valores REALES distintos con forma de secreto: 5
  sha8=760e3f4b len=46  -> hash8 presente en reporte? true
  sha8=d2c357a4 len=35  -> hash8 presente en reporte? true    <- el de 35 chars, bajo HIGH_ENTROPY_MIN_LEN=40
  sha8=52324df5 len=103 -> hash8 presente en reporte? true
  sha8=4798d1eb len=35  -> hash8 presente en reporte? true
  sha8=01f4ee50 len=103 -> hash8 presente en reporte? true
FUGA_EN_REPORTE_TXT: 0 | FUGA_EN_SALIDA_JSON: 0

campos del Finding: root,file,rel,key,kind,hash8,len,category,reason,removed,rotated,rotationLabel
tiene campo value? false
```

El control es **estructural**: el `Finding` no tiene campo `value`, así que no hay nada que filtrar. El `client_secret` de 35 chars queda por debajo del umbral de entropía y **aun así** no se filtra.

#### CA-2 — ejercité el mecanismo real, no leí código

Corrí el `claudeCopyFilter` real sobre el `.claude/` real del repo y barrí el destino:

```
archivos en .claude origen: 272 | copiados al destino: 233
telegram-config.json copiado? false
settings.json copiado?        true
BARRIDO DEL DESTINO -> archivos: 30 | hallazgos: 4 | errores: 0 | no-parseables: 4
```

Los 4 hallazgos del destino **no son credenciales**: son JSON con marcadores de conflicto de git sin resolver (`agent-metrics.json`, `auto-review-state.json`, `tg-session-store.json`, `scrum-monitor-state.json`). Cero secretos reales llegan al destino. Registré ese ruido aparte en **#5347**.

Casos límite de la allowlist, verificados uno por uno:

```
DENY hooks/telegram-config.json        DENY hooks/telegram-config.json.bak
DENY hooks/tests/telegram-config.json  DENY settings.local.json
DENY worktrees/x/y.json   DENY sessions/a.jsonl   DENY hooks/agent-5220.heartbeat
COPY settings.json        COPY skills/qa/SKILL.md COPY hooks/pretooluse.js
```

**CA-2.a cerrado, verificado por mí:** el productor está fuera del repo.

```
$ sed -n '59,62p' /c/Workspaces/bin/claude-session
  # Copy .claude config so hooks/permissions work
  cp -r "$REPO_ROOT/.claude" "$WORKTREE_PATH/.claude" 2>/dev/null || true   <- sin `rm -rf` previo
$ git -C /c/Workspaces/bin rev-parse --show-toplevel
  fatal: not a git repository        <- no versionado, no modificable desde este repo
```

Es exactamente la firma A1. Aplica **CA-2.d**: se entrega detección garantizada y la prevención por construcción queda en #5226.

### CA-7 — NO cumplido. Apruebo igual, con descope explícito y asentado

Verificado por mí en esta pasada:

```
$ ls .pipeline/secret-rotations.json        -> No such file or directory
$ ls ../platform.session-fix-20260413-122542/.claude/{,.claude/}hooks/telegram-config.json
   ambos presentes
$ ls -d ../platform.session-*/.claude/.claude | wc -l   -> 33
```

Ninguna credencial fue rotada, nada fue purgado, las 33 copias anidadas siguen ahí.

Apruebo porque **el invariante que CA-7 protege está respetado por la implementación**: rotar es prerequisito de purgar. El barrido falla cerrado (`exit 4` UNROTATED), se niega a declarar limpio y no purga nada antes de la rotación. La cláusula *Then* de CA-7 está condicionada a "cuando se cierra la historia", y **la historia no se cierra**:

```
$ gh pr view 5277 --json closingIssuesReferences
  []                                   <- el merge NO cierra este issue
$ gh pr view 5277 --json body | grep -c 'Refs #5220'   -> 3
```

El cuerpo del PR dice textualmente: *"La rotación/revocación de credenciales permanece PENDIENTE. Este PR no afirma que la exposición esté cerrada y no ejecuta la purga antes de la rotación humana."*

**El descope es decisión de producto y me corresponde tomarla:**

| | |
|---|---|
| #5220 **entrega** | detección, clasificación en 3 categorías, fail-closed, reporte sin valores por construcción, allowlist deny-by-default, patrones de redacción, 72 tests |
| #5220 **NO entrega** | rotación, revocación ni purga efectiva |
| Remediación real | #5322 (rotar `760e3f4b` + purgar los 52) |
| Revocación del token publicado | #5237 |
| Prevención en origen | #5226 |

### Evidencia de QA

```
$ stat -c%s .pipeline/logs/media/qa-5220.mp4          -> 9164795 (8949 KB > 500 KB)
$ ffprobe -show_entries stream=codec_type,codec_name  -> h264,video / aac,audio
$ ffprobe -show_entries format=duration               -> 372.92 s (6:13)
$ ls .pipeline/servicios/drive/*/ | grep 5220         -> qa-5220-video.json (subida ok)
```

Aunque por scope (`area:infra` sin `app:*`) el video no era exigible, QA lo produjo narrado y lo verifiqué.

### ⚠️ Advertencia para el merge

El PR **no debe cerrarse afirmando que la exposición quedó cerrada**. Siguen 33 copias anidadas de `.claude/` y 4 credenciales sin rotar en disco. Lo que cambia es que ahora **se ven**: vivieron 4 meses invisibles porque esta detección no existía.

### Recomendaciones

Recomendaciones pendientes de aprobación humana: **#5347**. Corrección publicada en **#5327**.

---
*Aceptación emitida por el agente `po` · fase `aprobacion` · pipeline `desarrollo`.*
