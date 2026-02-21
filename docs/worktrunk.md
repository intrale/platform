# Desarrollo paralelo con Worktrunk

## Qué resuelve

Permite tener **múltiples agentes Claude trabajando en paralelo**, cada uno en su
propio directorio aislado (worktree), sin riesgo de que se pisen entre sí.

```
platform/                          ← main (coordinación, nunca se codea)
platform.codex-42-auth/            ← Claude #1 trabajando en issue #42
platform.codex-43-catalogo/        ← Claude #2 trabajando en issue #43
platform.codex-44-pagos/           ← Claude #3 trabajando en issue #44
```

Cada worktree comparte el mismo `.git/` (objetos, refs), pero tiene su propio
working tree completo. No hay conflictos de branches ni stash.

## Comandos del día a día

Solo 6 comandos, todos empiezan con `dev`:

| Comando | Qué hace |
|---------|----------|
| `dev 42 auth-2fa` | Crear worktree + branch `codex/42-auth-2fa` |
| `dev-list` | Ver todos los worktrees activos |
| `dev-go 42` | Ir a un worktree existente |
| `dev-done` | Mergear a main (squash) + limpiar |
| `dev-clean` | Eliminar worktree actual sin merge |
| `dev-home` | Volver al worktree principal (main) |

### Flujo típico — Feature en paralelo

```bash
# Terminal 1: crear worktree y lanzar agente
dev 42 auth-2fa
claude "Implementar autenticación 2FA - Closes #42"

# Terminal 2: otro agente en paralelo
dev 43 catalogo
claude "Implementar catálogo de productos - Closes #43"

# Terminal 3: ver estado de todos
dev-list

# Cuando un agente terminó:
dev-go 42
dev-done          # squash merge a main + cleanup
```

### Flujo típico — Feature con PR

```bash
# Crear worktree
dev 42 auth-2fa
claude "Implementar auth 2FA - Closes #42"

# Claude pushea y crea PR (via /delivery)
# PR se mergea en GitHub
# Limpiar worktree local:
dev-go 42
dev-clean
```

## Qué hace `dev` por debajo

```
dev 42 auth
  ├─ git fetch origin main
  ├─ git-wt switch --create codex/42-auth
  │    └─ crea worktree en ../platform.codex-42-auth
  ├─ copia .claude/settings.local.json (permisos de Claude Code)
  └─ imprime instrucciones
```

El paso de copia de settings es clave: sin él, cada worktree nuevo pediría
permisos desde cero.

## Instalación (ya hecha)

```bash
# Worktrunk
winget install max-sixty.worktrunk

# Shell integration (en ~/.bashrc)
git-wt config shell install

# Dev functions (en ~/.bashrc)
source "/c/Workspaces/Intrale/platform/scripts/dev-functions.sh"
```

### Archivos de configuración

| Archivo | Qué configura |
|---------|---------------|
| `~/.bashrc` | Carga dev-functions.sh + shell integration |
| `scripts/dev-functions.sh` | Funciones `dev*`, PATH, JAVA_HOME |
| `.config/wt.toml` | Config de proyecto (compartida via git) |
| `~/.config/worktrunk/config.toml` | Config de usuario (worktree-path, merge) |

## Convención de branches

| Origen | Formato | Ejemplo |
|--------|---------|---------|
| Agente Claude | `codex/<issue>-<slug>` | `codex/42-auth-2fa` |
| Feature manual | `feature/<desc>` | `feature/dark-mode` |
| Bugfix manual | `bugfix/<desc>` | `bugfix/login-crash` |

## Disco

Cada worktree ocupa ~100 MB (sin builds).
Un `./gradlew build` puede sumar ~500 MB-1 GB.

Recomendación: **no más de 5-6 worktrees activos** simultáneamente.

```bash
dev-clean-all     # elimina TODOS los worktrees (excepto main)
```

## Notas técnicas

- En Windows, `wt` colisiona con Windows Terminal. Usar siempre `git-wt`.
- Las funciones `dev*` usan la shell integration de worktrunk para hacer `cd`
  automáticamente al worktree.
- Los worktrees comparten `.git/` pero NO archivos gitignoreados como
  `settings.local.json`, `.gradle/`, `build/`. Por eso `dev()` copia los
  settings de Claude Code automáticamente.
