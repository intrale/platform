# Operación del Pipeline V2 — Flujos Operativos

Referencia rápida para operadores y desarrolladores sobre los flujos nuevos introducidos por el issue #2405 (fail-fast JAVA_HOME, backup tags, circuit breaker `needs-human`).

---

## Allowlist JDK (JAVA_HOME) {#allowlist-jdk}

### Por qué

El rol `build` compila con Gradle contra un Temurin 21 específico. Si el host desarrolla drift en `JAVA_HOME` (ej. IntelliJ desinstalado, JDK nuevo en otro path), el build falla con errores oscuros y el pipeline los clasificaba como errores de código, consumiendo budget del circuit breaker.

Desde #2405, el rol `build` tiene un **paso 0** que valida `$JAVA_HOME` contra una allowlist parametrizada en `.pipeline/config.yaml`. Si no matchea, falla con exit 78 (sysexits EX_CONFIG) y el Pulpo lo clasifica automáticamente como `rebote_tipo: infra` — no consume budget de código.

### Agregar un JDK nuevo a la allowlist

```bash
# 1. Editar config.yaml
$EDITOR .pipeline/config.yaml
```

Appendear una entrada bajo `build.java_home_allowlist`:

```yaml
build:
  java_home_allowlist:
    - "C:/Users/Administrator/.jdks/temurin-21.0.7"
    - "C:/Users/Administrator/.jdks/temurin-21.0.8"
    - "C:/Users/Administrator/.jdks/temurin-21.0.9"   # <-- nuevo
```

```bash
# 2. Verificar localmente antes de commitear
JAVA_HOME="C:/Users/Administrator/.jdks/temurin-21.0.9" \
  node .pipeline/validate-java-home.js
# → OK: JAVA_HOME aceptado (...)

# 3. Commitear
git add .pipeline/config.yaml
git commit -m "chore(pipeline): agrega temurin-21.0.9 a la allowlist de JAVA_HOME"
```

### Comparación

El validador normaliza antes de comparar:

- Separadores `/` ↔ `\` (Windows).
- Case-insensitive (FS Windows default).
- Resuelve symlinks/junctions (`fs.realpathSync`).
- Acepta match por subdirectorio (`.../jdk/bin` matchea si `.../jdk` está en la allowlist).

Rechaza:

- Paths con `..` (directory traversal).
- Paths con shell-metachars (`;`, `&&`, `|`, backticks, `$(`).
- Paths con whitespace en los bordes (un path mal-sanitizado que llegó trimeado).

---

## Backup/restore de ramas `agent/*` {#backup-restore}

### Por qué

Un incidente histórico (#1952) perdió commits de una rama `agent/*` tras un reset automático del pipeline. Desde #2405, el Pulpo inyecta en el prompt del rebote un **paso 0** que llama a `backup-agent-branch.js` **antes** del `git merge origin/main`.

Si hay commits locales no pusheados (`git rev-list <upstream>..HEAD` > 0), el helper crea un tag local `backup/agent-<issue>-<skill>-<timestamp>-<rand4>` y loggea la operación.

### Listar tags de backup

```bash
git tag -l "backup/*"
```

### Restaurar de un backup

```bash
# 1. Encontrar el tag relevante
git tag -l "backup/agent-2405-*" --format='%(refname:short) %(creatordate:iso)'

# 2. Recuperar commits (reset destructivo — asegurate de no tener cambios pendientes)
git reset --hard backup/agent-2405-pipeline-dev-20260421T152311Z-a3f2
```

### Audit log

Cada operación de backup/restore/cleanup queda registrada en `.pipeline/logs/audit-<issue>.log` con formato grep-friendly:

```
2026-04-21T15:23:11Z [BACKUP] issue=2405 skill=pipeline-dev branch=agent/2405-pipeline-dev
  tag=backup/agent-2405-pipeline-dev-20260421T152311Z-a3f2
  tip=8f2c91d unpushed=3 upstream=origin/agent/2405-pipeline-dev
  revert: git reset --hard backup/agent-2405-pipeline-dev-20260421T152311Z-a3f2
```

El comando de reverso (`revert: ...`) es copiable tal cual.

### TTL 30 días (cleanup automático)

Los tags `backup/*` tienen TTL 30 días. El cleanup se puede ejecutar manualmente:

```bash
# Dry-run (sólo reporta)
node .pipeline/backup-agent-branch.js --clean --dry-run --ttl-days 30

# Borrar tags expirados
node .pipeline/backup-agent-branch.js --clean --ttl-days 30
```

Cada borrado queda loggeado en el audit:

```
2026-05-21T00:00:00Z [CLEANUP] tag=backup/agent-2405-pipeline-dev-... age=31d
```

### Los tags no se pushean

Por diseño los tags `backup/*` son **locales**. Nunca se hace `git push --tags` desde el helper. Eso evita exponer referencias al remote y mantiene `refs/tags/` limpio upstream.

---

## Circuit breaker `needs-human` {#needs-human}

### Por qué

Un issue que falla por infra repetidamente (JDK drift, network flaky, storage lleno, etc.) puede consumir tokens y slots indefinidamente. Desde #2405, el Pulpo tiene un threshold blando (`circuit_breaker.infra_escalate_threshold`, default 5) que escala el issue a un humano con label `needs-human` antes de alcanzar el cap duro `MAX_REBOTES_INFRA` (20).

### Qué hace el escalado

Cuando un issue acumula N rebotes infra consecutivos (N = threshold):

1. Aplica label `needs-human` (color `#B60205`, auto-creado en primera aplicación).
2. Comenta en el issue con:
   - Frase única explicando qué pasó.
   - Causa raíz (motivo del último rechazo, redactado por el sanitizer — sin tokens, sin paths internos).
   - 3 acciones sugeridas al humano.
   - Links a los logs relevantes.
3. Archiva los archivos del issue (mueve de `pendiente/trabajando/procesado` a `archivado/`).
4. Envía notificación Telegram.
5. Filtra el issue de la cola de intake hasta que un humano quite el label.

### Cómo destrabar un issue `needs-human`

```bash
export PATH="/c/Workspaces/gh-cli/bin:$PATH"

# 1. Revisar qué pasó
gh issue view <N> --comments | tail -50
cat .pipeline/logs/audit-<N>.log
cat .pipeline/logs/<N>-*.log | tail -100

# 2. Corregir el problema de entorno / definición del issue
# (ej. agregar JDK a allowlist, reiniciar servicio, dividir historia)

# 3. Quitar el label — el issue reentra al intake en el próximo ciclo (~5 min)
gh issue edit <N> --remove-label needs-human
```

Al quitar el label:

- El intake filtra `-label:needs-human` en la consulta a GitHub, así que vuelve a aparecer.
- Los archivos antiguos están en `archivado/` — el contador de rebotes infra empieza desde 0.

### Configurar el threshold

En `.pipeline/config.yaml`:

```yaml
circuit_breaker:
  infra_escalate_threshold: 5   # arranca en 5 (conservador)
```

Recomendación: bajar a 3 tras una semana de observación operativa estable.

### Diferencia con `MAX_REBOTES_INFRA`

| Concepto | Valor | Semántica |
|---|---|---|
| `circuit_breaker.infra_escalate_threshold` | 5 (config.yaml) | Escalado blando a humano (label + comment). |
| `MAX_REBOTES_INFRA` | 20 (código) | Cap duro antisabotaje. Si la clasificación infra fuera saboteada y hubiera loop infinito, este cap detiene todo. |

---

## Tabla de exit codes del rol `build`

| Exit code | Significado | Clasificación |
|---|---|---|
| 0 | Build OK | éxito |
| 78 | JAVA_HOME fuera de allowlist (sysexits EX_CONFIG) | `rebote_tipo: infra` |
| otros != 0 | Fallo de Gradle/test | `rebote_tipo: codigo` (o infra si el motivo matchea patrones ENOTFOUND/ETIMEDOUT/etc.) |

---

## Token `gh` del Pulpo — scope mínimo

El Pulpo interactúa con GitHub vía `gh` CLI. El token debe tener:

- `repo` — para `issue edit --add-label`, `issue edit --remove-label`, `label create`, `issue comment`, `issue view`, `pr create`.
- `write:discussion` — sólo si en el futuro se usa `gh api /repos/:owner/:repo/discussions`.

El token **NO** debe tener:

- `admin:org` — no gestionamos la organización desde el pipeline.
- `delete_repo` — nunca borramos repos.
- `workflow` — el pipeline no modifica GitHub Actions programáticamente.

Revisar scope:

```bash
gh auth status
```
