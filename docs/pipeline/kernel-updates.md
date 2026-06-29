# Estrategia de actualizaciones del kernel operativo (Ola 8 · EP-OLA8-F · sub-track b)

> **Versión del documento:** 0.1.0 (definición viva — se revisa al entrar a Ola 9)
> **Estado:** definición (Ola 8). La Ola 8 **define**; la Ola 9 **implementa** con OK humano.
> **Naturaleza:** documento de **definición**. No hay código de auto-update en esta épica. Cero
> riesgo para Intrale: el `.pipeline/` actual **no se toca**.

## Cómo leer este documento

Cubre el **sub-track (b)** del split de EP-OLA8-F: cómo se **versionan, distribuyen y aplican** las
actualizaciones del **propio kernel operativo**, y la **respuesta explícita** a la pregunta clave del
issue — *¿las updates del modelo operativo corren con el mismo pipeline/modelo operativo
(auto-hospedaje) o necesitan un canal aparte?* El sub-track (a) — coexistencia y cutover — vive en
[`kernel-coexistencia.md`](./kernel-coexistencia.md).

| Sección | Responde a | Criterios |
|---------|-----------|-----------|
| 1. Encuadre y acoplamiento con #4012 | de dónde sale y con qué se coordina | CA-7, CA-8 |
| 2. Versionado | semver + tag inmutable + changelog auditable | CA-3 |
| 3. Distribución segura | firma + checksum + pin + scan de secrets | CA-3 (seguridad #1, #4) |
| 4. Bootstrap de confianza | stage0 pinned + fixture + canary | CA-4 |
| 5. **Decisión auto-hospedaje vs canal separado (RESUELTA)** | la pregunta clave del issue | CA-4 (seguridad #2) |
| 6. Auditoría de updates | log inmutable forense | CA-5 |
| 7. Salida hacia Ola 9 | sub-épicas del track (b) | CA-6 |

---

## 1. Encuadre y acoplamiento con #4012 (CA-7, CA-8)

### 1.1. Acoplamiento fuerte con EP8-D #4012 (versionado/distribución)

**EP8-D · #4012** (repo aparte para el modelo operativo + versionado/distribución) está todavía
**OPEN**. El esquema de versionado/distribución de este documento es **output conjunto** con #4012:
ambos describen el mismo objeto (cómo se versiona y publica el kernel). Para **no definir dos
esquemas incompatibles** (riesgo explícito del issue, CA-7):

- Este documento **consume los borradores vivos** de #4012 y **no duplica** la mecánica de repo/CI.
- El semver + tag inmutable + changelog de la sección 2 es la **vista desde la coexistencia/updates**;
  #4012 es autoritativo sobre la mecánica de repositorio y publicación. Donde haya tensión, **manda
  #4012** y este documento se reconcilia.
- **Supuesto vivo [U1]:** el kernel se publica como **release semver inmutable** firmado desde un
  repo aparte. *Provisional hasta que #4012 cierre su esquema.*

### 1.2. Encuadre Ola 8 (CA-8)

- **Cero riesgo para Intrale:** ningún mecanismo de auto-update se implementa en esta épica; el
  `.pipeline/` actual no se toca. El código de auto-update es **Ola 9**, con los puntos #1 y #2 de
  seguridad como **bloqueantes de diseño**.
- **La Ola 8 define / la Ola 9 implementa:** salida = definición + sub-épicas (sección 7).
- **Sin label de admisión automático:** la promoción a implementación requiere **OK humano** (gate
  Ola 8).

---

## 2. Versionado (CA-3)

> Sistematiza una convención **ya en uso de facto** (hecho #3 de `guru`): existen tags estables
> `pipeline-stable`, `v2-modelo-operativo-estable`, `pre-multi-provider-stable`, `pre-ola-n+2-stable`,
> `pre-ola-n+3-stable`. No hay que inventarlo: hay que **formalizarlo** en semver + inmutabilidad +
> changelog auditable.

- **Semver del kernel (`k-vMAJOR.MINOR.PATCH`):**
  - **MAJOR** — cambio incompatible del **contrato kernel↔adaptador** (puertos, manifiesto, lifecycle).
    Se alinea con `contractVersion` de [`contrato-kernel-adaptador.md`](./contrato-kernel-adaptador.md)
    (CA-14 del contrato): un bump MAJOR del contrato implica MAJOR del kernel.
  - **MINOR** — capacidad nueva retrocompatible (skill/capability nuevo, hook opcional).
  - **PATCH** — fix sin cambio de contrato.
- **Tag inmutable:** cada versión publicada es **inmutable**. Una versión ya publicada **no se muta**;
  toda corrección es una **versión nueva** (seguridad #1: versionado inmutable). Prohibido reescribir
  un tag `k-vX.Y.Z` existente.
- **Changelog auditable:** cada release lleva un changelog **legible por humano** (no diff crudo,
  guideline G3 del `ux`): qué cambia, impacto en el contrato, blast radius si sale mal. Es el insumo
  que el operador lee en el gate de aprobación (sección 5).
- **Pin de versión obligatorio:** cada producto (adaptador) **pinnea** una versión exacta del kernel
  en su manifiesto. **Prohibido `latest` implícito** en producción (seguridad #1).

---

## 3. Distribución segura (CA-3 · seguridad #1 A08, #4 A05)

> Cadena de suministro / integridad de updates del kernel — el dominio **CRÍTICO #1** de `security`
> (OWASP A08: Software and Data Integrity Failures). Una update manipulada compromete el mecanismo
> que valida las propias updates.

- **Releases firmados:** todo release del kernel se publica con **firma criptográfica**.
- **Verificación firma + checksum antes de aplicar:** antes de aplicar **cualquier** update, se
  verifica firma **y** checksum del artefacto. Falla de verificación → la update **no se aplica**
  (fail-closed).
- **Pin + prohibición de `latest`:** sólo se aplica la versión exacta pinneada y verificada; nunca un
  "último" resuelto dinámicamente.
- **Separación kernel (sin secretos) ↔ adaptador (config/secretos del producto)** + **scan de secrets
  del artefacto distribuible antes de publicar** (seguridad #4, A05). El kernel genérico, al
  distribuirse a otros productos, **no puede arrastrar** secretos/config de Intrale. El artefacto
  distribuible **no pasa el publish** si el scan de secrets encuentra algo.
  - Reusar/conectar con la primitiva existente de strings/secretos prohibidos del proyecto donde
    aplique; el scan de secrets es **gate de publicación**, no opcional.

---

## 4. Bootstrap de confianza (CA-4)

> Resuelve el "problema del compilador que se compila a sí mismo": si una update rompe la herramienta
> que valida updates, hay que poder volver a un punto congelado y confiable.

- **stage0 = kernel pinned / congelado.** El canal que **valida** una update corre sobre una
  **instancia del kernel anterior, pinneada e inmutable** (tag estable = stage0). La update bajo
  evaluación **no puede modificar** su propio validador. Es el patrón "stage0 pinned" que la
  convención de tags `*-stable` ya habilita (hecho #3 de guru).
- **Validación contra repo fixture (no contra Intrale).** La update se valida ejecutando el pipeline
  sobre un **repo fixture** controlado y reproducible, **no** contra el producto Intrale en
  producción. El blast radius de una update defectuosa queda contenido al fixture.
- **Canary.** Tras pasar el fixture, la update corre en **canary** sobre un subset reversible antes de
  promoverse a producción (mismo principio que el canary del cutover en
  [`kernel-coexistencia.md`](./kernel-coexistencia.md) E2).
- **Canal de validación mínimo e inmutable respecto de la update.** El validador (stage0 + fixture +
  criterios de gate) **no puede ser deshabilitado ni modificado por la update que está evaluando**
  (seguridad #2). Si la update intenta tocar sus propios gates, la validación falla.

---

## 5. Decisión: auto-hospedaje vs canal separado (CA-4 · RESUELTA) — seguridad #2 (CRÍTICO)

> **Pregunta clave del issue, respondida de forma explícita y justificada** (no se enumera opciones y
> se difiere — CA-4 lo prohíbe). Es el dominio **CRÍTICO #2** de `security` y **bloqueante de diseño**
> antes de cualquier código de auto-actualización en Ola 9.

### 5.1. Hecho de partida

El pipeline **ya se auto-hospeda hoy** (hecho #1 de `guru`): los issues `area:pipeline` —incluido
este #4014— se desarrollan dentro del mismo Pulpo/agentes que operan producción, **sin gate especial
ni canal aislado**. La pregunta no es *si* introducir auto-hospedaje, sino *si formalizar y aislar*
el canal de auto-update que ya existe de facto. El blast radius del self-hosting **ya está presente**;
esto **eleva** la urgencia, no la reduce.

### 5.2. Decisión: **híbrido con bootstrap de confianza** (auto-hospedaje acotado, NO pleno)

| Tipo de trabajo | Cómo corre | Justificación |
|-----------------|-----------|----------------|
| **Trabajo de producto** (issues de Intrale: features, bugs, etc.) | **Auto-hospedaje pleno (dogfooding)** — sigue corriendo con el kernel operando producción, como hoy | Es eficiente, ya funciona, y el dogfooding mantiene al kernel honesto. La update de producto **no** modifica el kernel. |
| **Updates del *propio* kernel** (cambiar el modelo operativo) | **NO auto-promovible.** Canal acotado: stage0 pinned + fixture + canary + **gate humano fuera de banda** + rollback atómico | Una update del kernel defectuosa/maliciosa, si corriera con el mismo kernel que actualiza, podría **deshabilitar sus propios gates** (self-modification, seguridad #2). Hay que romper ese lazo. |

**En una frase:** auto-hospedaje **para el trabajo de producto**, **canal separado/mínimo-privilegio
para las updates del propio kernel.** El auto-hospedaje pleno de las updates del kernel **se descarta**
porque aumenta el blast radius (recomendación de seguridad #2).

### 5.3. Requisitos de la rama "update del propio kernel" (seguridad #2 — todos obligatorios)

- **Gate de aprobación humana fuera de banda, NO auto-promovible.** Ningún agente/automatismo puede
  promover una update del kernel a producción. Requiere un humano que apruebe **fuera del canal que
  la update podría haber modificado**. Coherente con `feedback_no-grave-actions-without-consult`
  (estado del pipeline intocable sin OK) y con el gate Ola 8 (OK humano para promover).
- **Staging previo a producción:** la update pasa fixture (sección 4) y canary **antes** de tocar
  producción. Nunca directo a producción.
- **Canal de validación mínimo inmutable** respecto de la update bajo evaluación (sección 4): el
  validador no puede ser deshabilitado por lo que valida.
- **Rollback atómico y verificable** al último tag estable bueno ante fallo de validación post-update.
  **Reusa** `.pipeline/rollback.js` + `.pipeline/rollback.sh` (hecho #2 de guru: ya existen) + la
  convención de tags `*-stable` como puntos de retorno. "Verificable" = el rollback confirma con un
  smoke test que el estado restaurado funciona, no asume.
- **Contexto suficiente para el gate humano (G3 del `ux`):** el operador que aprueba **no** decide a
  ciegas: ve **changelog legible** (sección 2), **resultado del fixture/canary**, y el **blast radius**
  si sale mal. Si la aprobación pasa por Telegram, respeta `feedback_telegram-messages-natural`
  (mensaje claro, contextual, no volcado técnico).

### 5.4. Por qué híbrido y no canal 100% separado

Un canal 100% separado para **todo** (incluido el trabajo de producto) tiraría el dogfooding que hoy
mantiene al kernel probado contra carga real. La asimetría de riesgo lo justifica: el trabajo de
producto **no se auto-modifica** (no toca el kernel), así que el auto-hospedaje pleno es seguro ahí; la
update del **propio kernel** sí se auto-modifica, y sólo esa rama necesita el canal aislado. Se aísla
**lo que se auto-modifica**, no todo.

---

## 6. Auditoría de updates (CA-5 · seguridad #5)

> Trazabilidad forense ante una update maliciosa o un incidente post-update. Guideline G4 del `ux`:
> el log debe ser **legible por un humano bajo estrés post-incidente**, no sólo parseable.

- **Log de auditoría inmutable** de cada update del kernel, con campos consistentes:
  - **qué versión** del kernel se aplicó (`k-vX.Y.Z` + checksum + firma verificada),
  - **cuándo** (timestamp),
  - **por quién/qué** (humano que aprobó el gate fuera de banda + qué automatismo lo ejecutó),
  - **resultado de validación** (fixture / canary / smoke test post-update),
  - **resultado final** (promovido / rollback + a qué tag se volvió).
- **Inmutable:** el log no se reescribe; cada evento es append-only. Sirve de evidencia forense.
- **Legible (G4):** formato con campos legibles, no JSON denso ilegible; el operador lo lee post-mortem.
- **Cubre también el cutover:** el archivado del `.pipeline/` legacy (E4 de
  [`kernel-coexistencia.md`](./kernel-coexistencia.md)) se referencia en este log de auditoría.

---

## 7. Salida hacia Ola 9 (CA-6) — qué implementa el sub-track (b)

Salida = sub-issues de **implementación** (Ola 9), creadas con OK humano vía `/planner split`,
**separadas** de las del sub-track (a) por ritmo de riesgo distinto (CA-6 / guru: el (b) es seguridad
de cadena de suministro). Cada sub-épica **incorpora como CA propios** los dominios de seguridad #1,
#2, #5, con **#1 y #2 marcados bloqueantes de diseño**:

| Sub-issue Ola 9 (track b) | Alcance | Seguridad embebida (bloqueante) |
|---------------------------|---------|----------------------------------|
| **Versionado + tag inmutable + changelog** | Formalizar semver del kernel alineado a `contractVersion`; changelog legible (secciones 2) | #1 (A08) |
| **Distribución firmada + scan de secrets** | Firma + checksum + pin + scan de secrets como gate de publicación (sección 3) | **#1 (bloqueante)**, #4 (A05) |
| **Bootstrap de confianza (stage0 + fixture + canary)** | Validador inmutable sobre kernel pinned + repo fixture + canary (sección 4) | **#2 (bloqueante)** |
| **Canal de update del propio kernel (gate humano OOB + rollback)** | Gate fuera de banda no auto-promovible + rollback atómico verificable reusando `rollback.js`/tags (sección 5) | **#2 (bloqueante)** |
| **Log de auditoría inmutable de updates** | Append-only, legible, forense (sección 6) | #5 |

> Estas sub-épicas se coordinan con **EP8-D #4012** (versionado/distribución) para reconciliar el
> esquema y no duplicar semver (CA-7).

---

## 8. Verificación (inspección estructural)

```bash
cd "$(git rev-parse --show-toplevel)"

# CA-3 — versionado (semver + tag inmutable + changelog) + distribución (firma+checksum+pin) + scan secrets
test -f docs/pipeline/kernel-updates.md
grep -n "Tag inmutable"             docs/pipeline/kernel-updates.md
grep -n "changelog auditable"       docs/pipeline/kernel-updates.md
grep -n "firma + checksum"          docs/pipeline/kernel-updates.md   # nota: variantes "firma/checksum"
grep -ni "verifica firma"           docs/pipeline/kernel-updates.md
grep -n "scan de secrets"           docs/pipeline/kernel-updates.md

# CA-4 — decisión auto-hospedaje RESUELTA + bootstrap stage0/fixture/canary + gate humano OOB
grep -n "Decisión: \*\*híbrido"     docs/pipeline/kernel-updates.md
grep -n "stage0 = kernel pinned"    docs/pipeline/kernel-updates.md
grep -n "repo fixture"              docs/pipeline/kernel-updates.md
grep -n "gate humano fuera de banda" docs/pipeline/kernel-updates.md
grep -ni "rollback atómico"         docs/pipeline/kernel-updates.md

# CA-5 — log de auditoría inmutable
grep -n "Log de auditoría inmutable" docs/pipeline/kernel-updates.md

# CA-7 — acoplamiento con #4012 documentado
grep -nE "#4012" docs/pipeline/kernel-updates.md

# CA-8 — encuadre Ola 8
grep -n "Cero riesgo para Intrale" docs/pipeline/kernel-updates.md
grep -n "OK humano"                docs/pipeline/kernel-updates.md
```

---

## Referencias

- [`kernel-coexistencia.md`](./kernel-coexistencia.md) — sub-track (a): coexistencia + cutover + recursos + aislamiento.
- [`contrato-kernel-adaptador.md`](./contrato-kernel-adaptador.md) — EP8-B #4010 (`contractVersion`, puertos, broker de secretos CA-11).
- [`../desacople-kernel/inventario-frontera.md`](../desacople-kernel/inventario-frontera.md) — EP8-A #4009.
- EP8-D #4012 — repo aparte + versionado/distribución (acoplamiento fuerte, esquema reconciliado).
- `.pipeline/rollback.js` · `.pipeline/rollback.sh` — primitivas de rollback atómico reusadas.
- Convención de tags estables (`pipeline-stable`, `pre-ola-n+*-stable`) — semilla de stage0 pinned.
