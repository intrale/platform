# Evidencia de paridad E2E post-migración — Ola 9.1 · #4665

> **Cierre de la sub-ola 9.1** (cadena `#4662 → #4663 → #4664 → #4665`).
> Verifica **end-to-end** que el pipeline post-migración se comporta **idéntico**
> al estado pre-migración (`pre-ola9-migracion`). Paridad de comportamiento, no
> solo "compila". Habilita el OK humano para pasar a la sub-ola 9.2.
>
> **Frontera autoritativa:** [`kernel-cutover-9.1.md`](kernel-cutover-9.1.md) ·
> [`../desacople-kernel/inventario-migrado-9.1.md`](../desacople-kernel/inventario-migrado-9.1.md).

## 1. Por qué la paridad es determinística y de bajo riesgo

El consumo del kernel empaquetado está **gateado OFF** por default
(`pipeline.config.json` → `kernel.consume: false`). En coexistencia, el
`kernel-resolver` devuelve el **motor local** de `.pipeline/`, que quedó
**intacto** durante 9.1. El resultado esperado (comportamiento idéntico) es
**por diseño**; la verificación lo demuestra empíricamente comparando bytes y
configuración contra el tag baseline `pre-ola9-migracion`.

## 2. Cómo se reproduce

```bash
# Runner de evidencia (fail-closed: exit 1 ante cualquier regresión)
node .pipeline/kernel-bootstrap/parity-e2e-9.1.js
#   → escribe .pipeline/logs/parity-9.1.json + resumen ✓/✗ por eje

# Tests node --test de las invariantes de paridad
node --test .pipeline/tests/kernel-parity-9.1.test.js
```

El verificador (`.pipeline/lib/kernel-parity.js`) **no arranca procesos ni muta
estado**: shellea `git` (array de args, sin shell) para leer blobs de dos refs y
compararlos. Reproducible por cualquier operador/CI.

## 3. Evidencia por criterio de aceptación

### CA-1/CA-2 · Flujos clave sin regresión (intake, dispatch, gates, delivery)

Diff estructural de la config que gobierna cada flujo (`.pipeline/config.yaml`),
baseline vs HEAD:

```
✓ intake     (labels→pipeline + admission gate)
✓ dispatch   (pipelines.* fases + skills_por_fase + concurrencia)
✓ gates      (analisis/verificacion/aprobacion + convergence_excludes_skills)
✓ delivery   (skills_por_fase.entrega + concurrencia.delivery)
```

Base: `config.yaml` es **byte-idéntico** entre `pre-ola9-migracion` y HEAD
(blob `c80f74be…`), por lo que los cuatro slices coinciden exactamente.

### CA-2 · Wiring byte-idéntico + resolver default → motor local

El único cambio del cutover (#4664) es `restart.js` resolviendo `pulpo`/`dashboard`
vía `kernel-resolver`. Bajo el default de coexistencia, el resolver devuelve los
**mismos scripts locales** que arrancaba el pipeline pre-migración:

```
✓ .pipeline/pulpo.js      blob c4e824d1…  (idéntico baseline↔HEAD)
✓ .pipeline/dashboard.js  blob 1d3f58d9…  (idéntico baseline↔HEAD)
✓ .pipeline/config.yaml   blob c80f74be…  (idéntico baseline↔HEAD)
✓ resolver: pulpo     → source=local  (.pipeline/pulpo.js)
✓ resolver: dashboard → source=local  (.pipeline/dashboard.js)
✓ kernel.consume = false (coexistencia)
```

El motor que corre post-migración es **byte-por-byte el mismo** que corría antes.

### CA-3 · Rollback probado como salida segura

```
✓ tag pre-ola9-migracion existe → commit 647a69e2d0ebc8e53653a83b962c9c17e82da3fb
✓ default = motor local → el rollback es un no-op de comportamiento
```

El punto de retorno es el tag `pre-ola9-migracion`. Como el default ya es el
motor local byte-idéntico, revertir el cutover equivale a mantener
`kernel.consume: false` (o `git checkout pre-ola9-migracion`), sin cambio de path
de arranque. Verificado programáticamente, no solo descrito.

### CA-4 · Paridad de los gates de seguridad

```
✓ skill `security` sigue en definicion/analisis
✓ skill `security` sigue en desarrollo/verificacion
✓ `security` excluido de auto-promoción por convergencia (defensa en profundidad)
✓ cargador de credenciales lee ~/.claude/secrets/credentials.json (path canónico)
✓ cadena de redacción conserva patrones AWS/JWT/api-key/password
```

> **Nota de alcance:** `SecuredFunction` (JWT/Cognito), validación Konform y el
> KSP-processor de strings viven en el **build del producto** (Gradle), fuera de
> la frontera del motor migrado (el inventario 9.1 movió sólo el motor + skills
> genéricas; los skills de producto y su enforcement quedaron en `platform/`).
> No fueron tocados por la migración, por lo que su comportamiento es trivialmente
> idéntico. La paridad de gates verificable a nivel pipeline es que el skill
> `security` se ejecuta y la cadena de credenciales/redacción sigue intacta.

### CA-5 · Secret-scan de la historia migrada

```
✓ escáner   .pipeline/kernel-bootstrap/scan-history-9.1.js
✓ allowlist .pipeline/kernel-bootstrap/motor-9.1-secret-allowlist.json
✓ test      .pipeline/tests/kernel-scan-history-9.1.test.js
```

El barrido fail-closed de la historia completa (2390 blobs → **0 hallazgos
reales**, 773 falsos positivos adjudicados) está documentado en el
[inventario 9.1 §6](../desacople-kernel/inventario-migrado-9.1.md#6-escaneo-de-secretos-historia-completa-ca-3--req-sec-1--fail-closed).
Esta verificación confirma que el tooling y la allowlist auditada siguen
presentes y que su test `node --test` pasa; el barrido completo se re-corre sobre
el staging del kernel cuando se consolida el cutover (9.5).

## 4. Veredicto

`node .pipeline/kernel-bootstrap/parity-e2e-9.1.js` → **✓ PARIDAD TOTAL** (exit 0).
`node --test .pipeline/tests/kernel-parity-9.1.test.js` → **10/10 pass**.

Los seis ejes (motor, flujos, resolver, rollback, seguridad, secret-scan) pasan
contra el baseline real. El pipeline post-migración se comporta idéntico al
pre-migración. La sub-ola 9.1 queda cerrada a la espera del OK humano para 9.2.

## 5. Artefactos

| Artefacto | Rol |
|-----------|-----|
| `.pipeline/lib/kernel-parity.js` | Verificador puro (ejes de paridad, sin side-effects) |
| `.pipeline/kernel-bootstrap/parity-e2e-9.1.js` | Runner CLI + evidencia JSON (fail-closed) |
| `.pipeline/tests/kernel-parity-9.1.test.js` | Tests `node --test` de las invariantes |
| `.pipeline/logs/parity-9.1.json` | Evidencia estructurada de la última corrida (no versionada) |
