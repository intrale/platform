# kernel-bootstrap — commit 1 del repo del kernel (issue #4662 · Ola 9.1)

Tooling **del pipeline** (Node.js puro) que materializa el staging del **repo del
kernel** y ejecuta el **escaneo de secretos fail-closed** como precondición del
primer commit. Vive en el repo del producto porque reutiliza la primitiva de
detección del runtime (`.pipeline/sanitizer.js`); el **artefacto entregado** es el
repo del kernel (`intrale/kernel`, privado), que nace vacío y al lado.

## Qué produce

Estructura mínima del kernel (per `docs/pipeline/kernel-repo-design.md §1`):

```
core/.gitkeep        # motor de orquestación (vacío en este paso)
lib/.gitkeep         # utilidades transversales (vacío)
contracts/.gitkeep   # interfaz kernel↔adaptador + JSON Schema (vacío)
README.md            # layout + frontera de secretos + equivalencia §3.3
.gitignore           # defensa en profundidad (RS-4)
```

## Escáner fail-closed (`scan-staging.js`)

Reutiliza `sanitize()` de `.pipeline/sanitizer.js` (patrones Anthropic/OpenAI/AWS/
GitHub/JWT/password/private-key). Itera **todos** los archivos staged. Bloquea si:

- la salida de `sanitize()` difiere del input (patrón redactado → secreto), **o**
- `sanitize()` devuelve `[SANITIZER_ERROR:...]`, **o**
- el archivo no se puede leer.

**"No pudo correr" ≠ "verde"** (RS-1). No se usa `precommit-secret-scan.js` directo:
su glob solo cubre paths de estado del pipeline y daría un falso verde sobre el kernel.

### Equivalencia con `kernel-migration-plan.md §3.3`

El plan menciona `gitleaks` + `trufflehog` (no instalados en la máquina). Decisión
cerrada (Guru RS / Security RS-2): **opción (a)** — reusar el sanitizer del runtime,
suficiente como red fail-closed para un repo que nace vacío y sin secretos por
diseño, documentando esta equivalencia. `gitleaks` queda como paridad literal opcional.

## Uso

```bash
# 1) Materializar el staging + escaneo (precondición). Falla si aparece un secreto.
node .pipeline/kernel-bootstrap/bootstrap-kernel.js <destino-fuera-del-producto>

# 2) Escaneo directo sobre un directorio ya materializado (idempotente, exit 1 si HIT).
node .pipeline/kernel-bootstrap/scan-staging.js --dir <destino>

# 3) Recién con escaneo VERDE → historia git del kernel + repo privado:
cd <destino> && git init && git add -A && git commit -m "Commit 1: estructura base del kernel"
gh repo create intrale/kernel --private --source=. --remote=origin --push
```

Orden estricto (RS-1 · §3.3): **scaffold → escaneo verde → frontera confirmada →
commit 1**. El escaneo es precondición, nunca post-check.

## Tests

```bash
node --test .pipeline/tests/kernel-scan-staging.test.js
```

Cubre: staging limpio verde, acentos español sin falso positivo, token/JWT inyectado
bloquea (red fail-closed), `assertClean` tira, archivo ilegible bloquea, y el rechazo
de destino no vacío (el kernel nace sin historia heredada).
