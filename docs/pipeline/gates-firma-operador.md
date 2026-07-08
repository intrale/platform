# Modelo operativo — Gates de firma del operador (propuesta de diseño)

> **Estado:** propuesta / diseño. **No implementado.**
> **Ejecución prevista:** en una **ola intermedia**, posterior a la ola actual y **previa a la Ola 9** (migración física kernel↔adaptador).
> **Origen:** conversación operador (Leo) ↔ Commander, 2026-07-08, a raíz de los escapes #4531 / #4500 / #4532.

Este documento captura la propuesta completa para que no se pierda antes de bajarla a issues. Los issues **todavía no están creados** (a la espera de confirmación del operador).

---

## 1. Contexto y motivación

Durante la ola actual, tres rediseños del dashboard se cerraron y mergearon **sin coincidir con el mockup acordado** que estaba versionado en el propio issue:

- **#4531** (encabezado MIZPÁ): entregado en dos filas pisando el banner de la ola — exactamente el bug que debía eliminar. El mockup pedía una sola fila.
- **#4532** (métricas de la ola): "VELOCIDAD" y "ENTREGADOS" se renderizan superpuestos, texto ilegible. Cerrado con labels contradictorios `qa:passed` + `qa:failed`.
- **#4500** (Timeline + sparkline): cerrado **sin ningún label de QA**; sparkline vacío.

**Causa raíz (proceso, no código):** los gates del pipeline **avanzan siempre y automáticamente**. La aceptación PO clasificó estos issues como *"tooling interno del pipeline → aceptación por revisión de código + QA estructural, sin video de producto"*. La QA estructural verifica IDs de contrato y que rendee sin error, pero es **ciega al diseño** — nadie comparó el render real contra el mockup. Peor: los gates no solo no atajaron el error, lo **blanquearon con `qa:passed`**. Un verde falso es más caro que un `qa:pending` honesto.

**Decisión de fondo del operador:** en los dos breakpoints donde el juicio humano es insustituible — **definición** y **aceptación** — el operador debe confirmar, aun aceptando ser el cuello de botella. Coherente con el principio ya fijado en V3 (`preferir bloqueado-humano a rebote automático`; eficiencia > autonomía total).

---

## 2. Principio rector

El pipeline sigue **autónomo por default** en el ~80% del trabajo mecánico. Se agregan:

- **Dos semáforos humanos obligatorios** (definición y aceptación).
- **Una regla transversal (GATE 0)** que impide que los gates automáticos declaren "aprobado" sobre lo que no pueden verificar.
- **Un índice de confiabilidad** que acompaña cada pedido de firma, para que el operador arranque con un primer nivel de confianza y para habilitar, con evidencia, una autonomía progresiva.

El objetivo no es frenar la autonomía, sino **poner semáforos en dos esquinas, no en toda la ciudad**, y hacer que cada firma humana sea barata, honesta y de alto valor.

---

## 3. Los tres gates

### GATE 1 — Firma de Definición (SIEMPRE)
- **Cuándo:** al cerrar la fase `criterios` del pipeline `definicion`, antes de admitir el issue a `desarrollo`.
- **Qué frena:** que se construya algo sin que el operador confirme que los criterios de aceptación + el mockup son los correctos.
- **Intervención humana:** el operador recibe el paquete de definición (pantalla actual + mockup objetivo + criterios + sizing) y responde **✅ aprobar / ✏️ ajustar / ❌ rechazar**. Ajustar/rechazar → vuelve a `criterios`.
- **Alcance:** todos los issues (siempre). Válvula de escape: ver §4 (opt-out pre-autorizado).

### GATE 2 — Firma de Aceptación (SIEMPRE, con evidencia autogenerada)
- **Cuándo:** al cerrar la fase `aprobacion` del pipeline `desarrollo`, antes de `entrega` (merge a main).
- **Qué frena:** el merge de algo visual/producto que el operador no verificó. Es el gate que habría atajado #4531/#4500/#4532.
- **Intervención humana:** el pipeline arma y adjunta el **paquete de evidencia** (render vs mockup, resultado de tests, muestra de API, etc.). El operador responde **✅ mergear / ❌ devolver a dev**. Rechazo → `fase_rechazo: dev`.
- **Alcance:** todos los issues (siempre), con la misma válvula del §4.

### GATE 0 — Veredicto honesto de los gates automáticos (transversal)
No es un stop humano nuevo; es la **política que impide que tester/qa/security/review mientan un verde**.

Cada verificador automático clasifica cada criterio de aceptación en **dos baldes**:
- ✅ **Máquina-verificable** — tests verdes, build compila, IDs presentes, cobertura ≥ X, sin errores de lint.
- ⚠️ **No verificable por máquina → requiere humano** — match visual vs mockup, calidad de UX, "¿es esto lo que el operador quiso?".

**Regla dura:** un gate automático **tiene prohibido emitir un "passed" global si algún criterio cae en el balde ⚠️**. En vez de `qa:passed`, emite *"máquina OK en [tests, IDs, build] · requiere ojo humano en [match visual]"*. Elimina el `qa:passed` falso y los labels contradictorios `qa:passed`+`qa:failed`.

**Enforcement estructural (no auto-reporte):** los criterios se etiquetan como *máquina-verificable* vs *solo-humano* **desde la definición** (salida de GATE 1). La máquina de estados le prohíbe al agente emitir `pass` sobre un criterio solo-humano. No se confía en que el LLM se autoevalúe honestamente.

---

## 4. Índice de confiabilidad + escalera de confianza progresiva

Cuando el pipeline pide firma (GATE 1 o GATE 2), **no** presenta un "confirmá" en frío: adjunta un **veredicto sugerido + un índice de confiabilidad**, para que el operador tenga un primer nivel de confianza y para construir, con datos, una autonomía progresiva.

### 4.1. Descompuesto, nunca un número único
Un "ACEPTAR 82%" mezclado es **peligroso**: ancla al operador a apretar ✅ sin mirar — el mismo rubber-stamping que queremos evitar, ahora con un número que parece autoridad. Por eso la confianza va **descompuesta**:
- Alta confianza permitida sobre los criterios **máquina-verificables** (tests, build, IDs).
- Confianza **explícitamente baja/desconocida** sobre los criterios **solo-humanos** ("no puedo evaluar el match visual — 0%, mirá vos").

La UI de firma **colapsa lo verde** (máquina-verificado) y **pone al frente solo los ítems que requieren tu ojo**. No se puede dar ✅ global: hay que resolver cada criterio solo-humano. Así 66 firmas/ola no se vuelven 66 sellos automáticos.

### 4.2. Fundado en evidencia, no en "vibes" del LLM
El índice se computa a partir de:
1. Cobertura de los criterios de aceptación por checks máquina-verificables que pasaron (de GATE 0).
2. Tasa histórica de acuerdo operador↔sugerencia para ese **tipo de issue** y esa **fase**.

Nunca un LLM diciendo "me siento 82%".

### 4.3. Calibrado (o es teatro)
"80% de confianza" solo sirve si está **calibrado**: debe significar "acierto ~80% de las veces". El sistema registra `sugerencia vs decisión real del operador`, computa la tasa de acuerdo por bucket de confianza y **recalibra**. Un número no calibrado se descarta.

### 4.4. Escalera de autonomía progresiva (la salida al cuello de botella)
El índice calibrado es **el mecanismo que le devuelve autonomía al pipeline sin sacrificar seguridad**:
- **Fase A:** siempre-humano; el modelo aporta sugerencia + confianza descompuesta.
- **Fase B:** el sistema mide el acuerdo por `(tipo de issue, bucket de confianza)`.
- **Fase C:** para buckets donde las sugerencias de alta confianza acumularon ≥X% de acuerdo sobre ≥N muestras, se le ofrece al operador **pre-autorizar auto-aprobación** (el opt-out del §5, ahora **ganado empíricamente**, no decidido a dedo). El operador puede revocar cuando quiera; cualquier caída de la tasa de acuerdo **auto-revoca**.

**Guardrails:**
- Nunca dejar que la confianza auto-apruebe criterios **solo-humanos** (visual/UX) hasta que la calibración lo pruebe, y aún así mantener una **muestra de auditoría aleatoria** para que la calibración no se degrade a rubber-stamp.
- El opt-out es siempre del operador y siempre revocable.

Así, el "primer nivel de confianza" que pidió el operador se convierte, con datos, en la palanca para aflojar los gates **exactamente donde el modelo probó ser confiable**, y solo ahí.

---

## 5. Mirada crítica (agujeros y mitigaciones)

| Riesgo | Descripción | Mitigación |
|--------|-------------|------------|
| **Cuello de botella** | 2 gates × ~33 issues = 66+ toques/ola serializados en una persona; si el operador se ausenta, el pipeline se detiene. | Firmas baratas (evidencia servida), colapso de lo verde, y §4.4 (autonomía progresiva ganada). Es el riesgo central: no minimizarlo. |
| **Fatiga → rubber-stamping** | A volumen, el operador aprieta ✅ sin mirar; la firma da autoridad falsa. | §4.1: colapsar lo verificado, forzar engagement solo en lo humano. |
| **"Always" romo** | Siempre-humano a secas es contundente. | §4.4 + opt-out **controlado por el operador** (no por un clasificador automático). |
| **Honestidad auto-reportada** | Un LLM puede alucinar "sí, verifiqué el visual". | §3: enforcement estructural — criterios etiquetados en definición, la máquina de estados prohíbe el falso pass. |
| **Costo asimétrico de evidencia** | Barata en dashboard (screenshot); cara en producto (APK+emulador+video). | Evidencia **tiered/lazy** (§6, puerto `e2e` opcional). |
| **Fragilidad de estados** | Los estados `waiting-operator` suman modos de stall a un modelo ya frágil (wave-progress, title-cache). | Endurecer la máquina de estados; tests de los nuevos estados antes de activarlos. |

---

## 6. Mirada Ola 9 — kernel ↔ adaptador (qué dejar listo desde el arranque)

Los gates son **modelo operativo = kernel**. La **Ola 8** (EP-OLA8-A..F, #4009–#4014, cerrados) ya definió el **contrato kernel↔adaptador** (#4010, `docs/pipeline/contrato-kernel-adaptador.md`), y **ya trae los puertos que esta propuesta necesita**:

- **Puerto `gates`** (§3 del contrato, *Obligatorio*): `estado de validación acumulado → pass/fail/skip + razón`, con el caso **"criterio no evaluable"** ya contemplado. Es la base de GATE 0. **Falta:** agregarle un veredicto **`requires-operator`** (hoy "criterio no evaluable" es error; debe rutear a firma humana).
- **Puerto `e2e`** (§3): `artefacto empaquetado → status + evidencia (video/doc)`. Es el **generador de evidencia** de GATE 2. Ya es kernel-define / adaptador-provee. La evidencia del dashboard (screenshot) y la del producto (APK+video) son dos implementaciones del mismo puerto. Marcado *"Opcional según capability del adaptador"* → refuerza el punto de evidencia tiered.
- **Secuencia de gates** (§2.7): "QA E2E → Tester → PO acceptance" ya es **kernel** (genérica); lo stack-específico (TTS, Lambda, emulador) es adaptador.
- **Superficies del operador** (§2.8/§6.3): Telegram y la bandeja "Esperando tu firma" son superficie de operador → kernel, pero **multi-tenant-aware**.

**Qué dejar disponible desde el comienzo (para no reajustar en Ola 9):**
Construir los gates **como enmienda al contrato, contra los puertos `gates`/`e2e`, NO pegados al dashboard de Intrale.** El **primer issue** del épico debe ser *enmendar el contrato #4010 (versionado por CA-14)* para agregar:
1. Veredicto `requires-operator` en el puerto `gates`.
2. Estado `waiting-operator` en el invariante de lifecycle (§5 del contrato).

Con eso, GATE 0 usa el puerto `gates`, la evidencia usa el puerto `e2e` (el dashboard es un adaptador más), y **los gates viajan al repo del kernel en Ola 9 automáticamente**, porque nacieron como contrato y no como feature de Intrale. Si no se hace así, la Ola 9 tiene que arrancar los gates hardcodeados y re-abstraerlos: reajuste.

---

## 7. Mapa de fases y agentes

### Pipeline `definicion` — `analisis → criterios → sizing`
| Fase | Agentes | Gate |
|------|---------|------|
| analisis | guru, security | — |
| criterios | po, ux, architect | 🔵 **GATE 1 · Firma de Definición** |
| sizing | planner | — |

### Pipeline `desarrollo` — `validacion → dev → build → verificacion → linteo → aprobacion → entrega`
| Fase | Agentes | Gate |
|------|---------|------|
| validacion | po, ux, guru | — |
| dev | backend/android/web/pipeline-dev | — |
| build | build | — |
| verificacion | tester, security, qa | 🟡 **GATE 0 · veredicto honesto** (transversal) |
| linteo | linter | — |
| aprobacion | review, po, ux, architect | 🔵 **GATE 2 · Firma de Aceptación** |
| entrega | delivery | (bloqueado hasta pasar GATE 2) |

---

## 8. Plan de issues (borrador — NO creados)

**Épico:** `Ajuste del modelo operativo — firma humana obligatoria en Definición y Aceptación`

0. **Enmienda al contrato kernel↔adaptador (#4010)** — veredicto `requires-operator` en puerto `gates` + estado `waiting-operator` en lifecycle (§5), versionado CA-14. *(Primero: habilita a los demás sin reajuste en Ola 9.)*
1. **GATE 0 · Veredicto honesto** — modelo de dos baldes; prohíbe "passed" global si hay ⚠️; enforcement estructural; elimina `qa:passed`+`qa:failed` simultáneos. *(Absorbe #4568. El más barato; ataja el 80% del daño solo.)*
2. **Generador de evidencia (puerto `e2e`)** — screenshot para el adaptador-dashboard; contrato listo para evidencia cara del producto (APK/video), tiered/lazy.
3. **GATE 1 · Firma de Definición (siempre)** — estado `waiting-operator-def`; colapso verde / solo-humano al frente; opt-out pre-autorizado por el operador.
4. **GATE 2 · Firma de Aceptación (siempre)** — estado `waiting-operator-acc`; adjunta evidencia; rechazo → dev.
5. **Índice de confiabilidad + calibración** — veredicto sugerido descompuesto; registro sugerencia↔decisión; recalibración; escalera de autonomía progresiva (§4).
6. **Aprobación de un toque por Telegram** — botones inline ✅/❌ cableados al estado + audit log.
7. **Dashboard: bandeja "Esperando tu firma"** — un solo lugar con los issues en `waiting-operator` y su evidencia.
8. **Doc del modelo operativo** — actualizar `docs/pipeline/` con la matriz auto-vs-gateado y la política de timeout/defaults.

**Orden sugerido:** #0 → #1 → #2 → #5 → #6/#7 → #3/#4 → #8.

---

## 9. Posicionamiento en el plan de olas

Esta propuesta se ejecuta en una **ola intermedia**: posterior a la ola actual y **previa a la Ola 9** (migración física kernel↔adaptador). El objetivo de secuenciarla antes de la Ola 9 es que la enmienda al contrato (issue #0) y el diseño de los gates contra los puertos `gates`/`e2e` **entren al kernel en la migración de Ola 9 sin reajuste**.

---

## Escapes de referencia
- #4531 (reabierto), #4500 (reabierto), #4532 (reabierto), #4568 (gate de QA visual — a absorber por el issue #1).
