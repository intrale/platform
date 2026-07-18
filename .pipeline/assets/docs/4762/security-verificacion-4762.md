## Reporte de auditoría de seguridad — issue #4762

**Veredicto:** sin hallazgos

**Alcance auditado:** rama `agent/4762-pipeline-dev` @ commit `ab6c503` vs `origin/main`.
Diff = 2 archivos nuevos (785 líneas):
- `.pipeline/lib/kernel-supervisor.js` (345 L) — supervisor de instancias multi-tenant.
- `.pipeline/lib/__tests__/kernel-supervisor.test.js` (440 L) — suite `node --test`.

Esta pieza (Ola Puente P4, split 1/3 de #4689) es una **frontera de confianza**:
aislamiento fuerte por `projectId` de N pipelines en el mismo proceso. La auditoría
se centró en las 6 requisitos obligatorios de seguridad definidos en la fase de
análisis + el mapa OWASP 2021.

### Hallazgos

**Sin hallazgos.** Ningún defecto de seguridad explotable. Todos los requisitos
obligatorios verificados empíricamente:

- **[OWASP A01 · Broken Access Control]** `kernel-supervisor.js:108` — `contextProjectId`
  derivado del registro (out-of-band), nunca de input en banda.
  - **Vector (criollo):** si el supervisor tomara el id del tenant desde un dato que
    viaja "en la petición", un producto podría pedir el id de otro y leerle los datos.
    Acá el id sale siempre del catálogo de productos, no de input manipulable.
  - **Estado:** correcto. Defensa en profundidad en `kernel-supervisor.js:115`: si el
    factory devolviera un store ligado a otra partición, lanza `KernelStoreIsolationError`
    antes de usarlo. Test "CA-2/A01" verde: store de A rechaza `getDescriptor('globex')`.

- **[OWASP A03/A08 · Injection / Path-traversal]** `kernel-supervisor.js:183,204,234,299`
  — `isSafeId()` fail-closed sobre todo id antes de derivar path/spawn.
  - **Vector (criollo):** si un id de producto como `../../etc/passwd` se metiera crudo
    en una ruta de archivo o en un comando, un atacante escaparía de su carpeta o
    ejecutaría comandos. Acá cada id pasa por `isSafeId`, que rechaza `..`, `/`, `\` y
    caracteres raros ANTES de tocarlo.
  - **Estado:** correcto. Verificado empíricamente: `isSafeId` devuelve `false` para
    `../evil`, `a/b`, `../../etc/passwd`, `$(rm -rf)`, `null`, `''`. No hay
    `child_process`/`exec` nativo: el `spawn` es dependencia inyectada, sin superficie
    de command-injection en el módulo.

- **[OWASP A01/A04 · Insecure Design · fuga de estado efímero]** `kernel-supervisor.js:122-137`
  — todo estado efímero (cooldowns, offsets, circuit-breaker, rebotes) en
  `instanceContext` propio por `projectId`.
  - **Vector (criollo):** el riesgo real de esta pieza. Si los cooldowns/contadores se
    guardaran en variables globales o en un archivo único (como hace hoy `pulpo.js` con
    `cooldowns.json`), el estado de un producto sería visible/mutable por otro.
  - **Estado:** correcto. Grep estático: CERO `globalThis`, CERO `let`/`var` de módulo
    para estado, CERO `writeFile`/`cooldowns.json` (únicas coincidencias = comentarios).
    Tests A05 verdes: efímeros de A no observables desde B; dos supervisores no comparten
    Map de módulo.

- **[OWASP A04 · Fault isolation / DoS cruzado]** `kernel-supervisor.js:220,298,146` —
  spawn/restart/hydrate aislados por instancia.
  - **Vector (criollo):** que el crash de un producto reinicie o tumbe a los demás.
  - **Estado:** correcto. `restartInstance(A)` recrea solo el ctx de A; `safeSpawn` y
    `hydrateInstance` capturan errores sin propagar. Tests verdes: descriptor corrupto
    de A no aborta el boot de B; restart de A no toca a B.

- **[OWASP A09 · Security Logging]** `kernel-supervisor.js:159,185,227,270` — rechazos
  fail-closed propagados por `onAlert` con `projectId` de origen, sin filtrar payload
  del tenant víctima. Correcto.

- **Secrets:** grep de patrones (AKIA/token/password/api-key/Bearer) → sin coincidencias.
  Ningún secret hardcodeado.

### Gate de seguridad de la pieza

Los tests A01 (`projectId` manipulado → `KernelStoreIsolationError`) y A05 (efímeros de
A no observables desde B) son el gate de seguridad definido en análisis. **Ambos verdes.**
Suite completa: `node --test` → 23/23 pass. Cobertura de `kernel-supervisor.js`:
100% líneas / 86.21% branch / 84.21% funcs (≥80% exigido).

### Requisitos obligatorios (checklist de análisis) — todos CUMPLIDOS

1. Un store inmutable por instancia, `contextProjectId` derivado, handle no compartido ✓
2. Cero estado efímero global compartido ✓
3. Solo instancias `status === "active"` ✓ (`kernel-supervisor.js:178`)
4. Validación de id fail-closed con `isSafeId` ✓
5. Tests adversariales A01 + A05 verdes + cobertura ≥80% ✓
6. Sin secrets hardcodeados ✓
