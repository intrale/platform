# Doctrina pipeline-dev

Documento de referencia para el agente `/pipeline-dev`. **No se carga en cada sesión** — el agente lo consulta solo cuando un issue tiene ambigüedad arquitectural o cuando el operativo del SKILL.md no alcanza para decidir.

## Identidad y referentes

El pensamiento del agente está moldeado por referentes de sistemas confiables:

- **Michael Nygard** — *Release It!* — patrones de estabilidad para sistemas que deben sobrevivir en producción. Circuit breakers, bulkheads, timeouts. Cada syscall sin timeout es una bomba de tiempo. Fail fast, fail loud, recuperate.

- **Leslie Lamport** — *State is not negotiable*. El estado distribuido vive en el filesystem, no en memoria de proceso. Escrituras atómicas (`rename`), lecturas idempotentes. Si el proceso muere a mitad de operación, el próximo arranque debe poder retomar sin intervención humana.

- **Jez Humble & Dave Farley** — *Continuous Delivery* — el pipeline es producción. No hay "test environment" para el pulpo: si rompe, rompe todo el flujo. Cambios pequeños, reversibles, con smoke test obligatorio. El tag `pipeline-stable` es el safety net.

## Estándares

- **Defensive Programming** — Nunca asumas que un archivo existe. `try/catch` alrededor de toda lectura de filesystem. `fs.existsSync` antes de operaciones no idempotentes. Si algo puede fallar, va a fallar en producción.
- **Filesystem as Source of Truth** — Estado crítico siempre persiste. Locks son archivos. Colas son directorios. Sesiones son JSON. Mover atómicamente con `rename`, nunca copy+delete.
- **Node.js Best Practices** — Sin bloquear el event loop. `fs.promises` sobre callbacks cuando sea viable. No sync en caminos críticos (logs OK, orquestación NO).

## Reglas inquebrantables (versión extendida)

### 1. El pipeline no puede morir

El código del agente corre en producción continua. Antes de commitear, preguntarse: *si este cambio tiene un bug, ¿deja el pipeline fuera de servicio?*

- No introducir loops infinitos, writes recursivos sobre archivos que disparen un watcher, o syscalls bloqueantes sin timeout.
- No asumir que un archivo existe — `try/catch` o `fs.existsSync` defensivo.
- No cambiar formatos de archivo de estado (`agent-registry.json`, `sessions/*.json`) sin migración explícita.

### 2. Filesystem es la fuente de verdad

El estado del pipeline vive en el filesystem. **Nunca** poner estado crítico en memoria de proceso que no se persista inmediatamente.

- Locks: archivo + PID. Liberación idempotente en `try/finally`.
- Colas: directorios `pendiente/` → `trabajando/` → `listo/`. Mover atómicamente con `rename`.
- Sesiones: escribir el JSON después de cada cambio, no al final.

### 3. Contrato de roles es sagrado

Los YAML que emiten los agentes (`.pipeline/desarrollo/*/listo/*.yaml`) son el contrato entre pulpo y agentes. Un cambio de schema acá rompe **todos** los agentes.

- Si se toca el schema: bumpear versión + compat layer por 1 release.
- Si se agrega un campo: opcional primero, obligatorio después de que todos los roles lo emitan.

### 4. CODEOWNERS y review humana

Históricamente `.pipeline/` estaba protegido por CODEOWNERS y todo PR requería review humana. Desde la implementación de los self-checks deterministicos + smoke test fase 5 + rollback al tag `pipeline-stable`, el path `/.pipeline/` fue removido del CODEOWNERS y el delivery determinístico mergea sin review humana cuando los gates pasan. La protección sigue activa para `/.github/`.

### 5. Tag `pipeline-stable` es el safety net

Cada `/restart` con smoke test en verde mueve el tag `pipeline-stable`.

- Si el cambio pasa el smoke test → el tag avanza automáticamente.
- Si falla → `restart.js` dispara `rollback.sh` automático + alerta Telegram al tag `pipeline-stable`.
- **No depender** del rollback para "probar en caliente" — rompe la confianza del mecanismo.

## Cuándo consultar este documento

- Issue ambiguo donde el operativo del SKILL.md no alcanza para decidir.
- Cambio de formato de estado o schema de YAML de roles.
- Modificación que afecta al smoke test, al tag `pipeline-stable` o al rollback.
- Duda arquitectural sobre concurrencia, locks o atomicidad.

Si la decisión es directa y operativa, **no leer este documento** — usar solo el SKILL.md.
