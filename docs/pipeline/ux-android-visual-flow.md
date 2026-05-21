# UX Android — flujo de assets visuales previos durante definición

> **Issue origen**: [#3407](https://github.com/intrale/platform/issues/3407) (split 1/3 de [#3382](https://github.com/intrale/platform/issues/3382)).
> **Hijas posteriores**:
> - 2/3 — helpers JS (`ux-android-actual-lookup.js`, `ux-mockup-generator.js`) + integración con skill `/ux`.
> - 3/3 — hook QA post-ejecución para promoción automática.
>
> **Referencia cruzada (anti-drift)**: [`docs/pipeline/visual-validation.md`](visual-validation.md) — guidelines de validación visual **post-build** (otra etapa del ciclo, no duplica este doc).

Este documento define **cómo el agente UX, durante la fase de definición de un
issue con label `app:*`, consulta la librería curada de screenshots previos**
para entregar contexto visual sólido al dev/QA/PO sin tener que correr el
emulador.

El otro doc visual (`visual-validation.md`) cubre el flujo post-construcción
(comparación QA vs mockup esperado). Este doc cubre el lookup de assets
previos antes de que el dev arranque.

## 1. Diagrama de flujo end-to-end

```
┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
│ Definición │───▶│ Comentario │───▶│    Dev     │───▶│   Build    │───▶│    QA      │
│  (issue    │    │     UX     │    │            │    │            │    │            │
│  con app:*)│    │   adjunta  │    │  imple-    │    │  artefacto │    │  captura + │
│            │    │  previos + │    │  menta     │    │   APK      │    │  compara   │
│            │    │  esperado  │    │            │    │            │    │            │
└────────────┘    └────────────┘    └────────────┘    └────────────┘    └────────────┘
                          │                                                    │
                          │                                                    │
                          ▼                                                    ▼
                  ┌──────────────┐                              ┌──────────────────────┐
                  │  Librería    │                              │ Promoción a librería │
                  │   curada     │◀─────────────────────────────│  (si aprueba QA      │
                  │ (este repo)  │       captura representativa │   + sin PII)         │
                  └──────────────┘                              └──────────────────────┘
                          ▲
                          │
                  ┌───────┴────────┐
                  │ qa/evidence/   │
                  │ <issue>/ (efí- │
                  │ mero por       │
                  │ ejecución)     │
                  └────────────────┘
```

## 2. Cuándo aplica

El flujo aplica a issues que tienen **alguno** de los siguientes labels:

- `app:client`
- `app:business`
- `app:delivery`

El agente UX, en la fase de criterios, busca screenshots previos en
`docs/app-screenshots-reference/<pantalla>/` para la pantalla afectada por el
issue. Si encuentra evidencia, la incluye en el comentario UX como referencia
"actual" + define el "esperado".

## 3. Cuándo NO aplica

- Issues **sin** label `app:*` (infra pura, docs, hooks internos, refactor de
  pipeline). UX no participa.
- Issues con label `qa:skipped` justificado (ver `CLAUDE.md → "Tipos de issue
  y criterio QA"`). El flujo de mockup esperado tampoco se exige.
- Issues que afectan a una pantalla **no canónica** (no listada en el README
  raíz de la librería). En ese caso el agente UX puede sugerir agregar la
  pantalla canónica a la librería en una historia paralela.

## 4. Caso degradado — sin evidencia previa disponible

Cuando UX consulta la librería y **no existe PNG canónico** para la
combinación `<pantalla>` × `<flavor>` requerida por el issue:

1. UX entrega **solo el "esperado"** (mockup desde Claude Design + descripción
   textual del flujo).
2. UX agrega **warning explícito** en el comentario del issue:
   `⚠ Sin evidencia visual previa para <pantalla>-<flavor>. Solo se entrega
   "esperado". El dev/QA debe capturar el estado actual al implementar.`
3. UX **no** intenta inventar el estado actual.
4. Si la captura post-QA es apta + sin PII, se promueve a la librería para
   futuros issues (cierra el gap).

## 5. Caso de error — fallo del LLM al consultar

Si el lookup de UX depende del Anthropic SDK (hija 2 de #3382 lo incorpora
con `ux-android-actual-lookup.js`) y el SDK falla:

1. **Abort** del proceso de lookup — UX no continúa con datos parciales.
2. **Alerta Telegram** al canal del pipeline con el motivo del fallo.
3. **NUNCA** fallback a levantar el emulador automáticamente — eso reintroduce
   el costo que esta historia paraguas (#3382) busca evitar.
4. El issue queda como bloqueado-humano hasta que se restaure el SDK o se
   decida proceder sin contexto UX.

## 6. Promoción a librería (criterio operativo)

Un PNG en `qa/evidence/<issue>/<filename>.png` se promueve a
`docs/app-screenshots-reference/<pantalla>/<pantalla>-<flavor>-<fecha>.png`
**si y solo si**:

1. El QA del issue aprobó (label `qa:passed`).
2. El screenshot muestra un estado **representativo** (happy path, empty,
   error, success) — no una transición intermedia ni un modal puntual.
3. **No tiene PII visible** (ver política en README raíz de la librería).
4. Es el **más reciente** para la combinación `<pantalla>` × `<flavor>` × `<estado>`.
5. El nombre se ajusta a la convención canónica al renombrar.

Si alguno falla → **no promover**, dejar en `qa/evidence/` como auditoría.

## 7. Heurística de mapeo `qa/evidence/` → pantalla canónica

Para la migración inicial (CA-8 de #3407) y para futuras promociones, el
mapeo entre el nombre legacy de un PNG en `qa/evidence/<issue>/` y la
pantalla canónica sigue esta heurística:

| Substring en filename                         | Pantalla canónica       |
|-----------------------------------------------|-------------------------|
| `welcome`                                     | `welcome/`              |
| `login`, `signin`                             | `login/`                |
| `recovery`, `password-recovery`               | `login/` (sub-flow)     |
| `signup`, `register`, `registro`              | `signup/`               |
| `home`, `main`, `business-home`               | `home/`                 |
| `search`, `busqueda`, `drawer-search`         | `busqueda/`             |
| `detalle`, `detail`, `product`, `producto`    | `detalle-producto/`     |
| `cart`, `carrito`                             | `carrito/`              |
| `checkout`                                    | `checkout/`             |
| `profile`, `perfil`, `profile-selector`       | `perfil/`               |
| `order`, `orders`, `pedido`, `pedidos`        | `pedidos/`              |

Para el **flavor**, se infiere del label `app:*` del issue de origen del PNG:

- Issue con `app:client` → `<pantalla>-client-*`.
- Issue con `app:business` → `<pantalla>-business-*`.
- Issue con `app:delivery` → `<pantalla>-delivery-*`.

Si el issue tenía **varios** `app:*` y el PNG no permite desambiguar el
flavor visualmente, se registra como **deuda de mapeo** (ver §10) y no se
migra hasta que se pueda confirmar.

> Detalle adicional sobre la heurística: recomendación [#3458](https://github.com/intrale/platform/issues/3458).

## 8. Caps operativos para CA-8 (migración inicial)

El criterio CA-8 del issue #3407 fija topes para evitar inflar el repo y
para mitigar el riesgo PII hasta que estén implementadas las herramientas
de #3385 y #3455:

- **Máximo 1 PNG por combinación `<pantalla>` × `<flavor>`** en esta primera
  migración.
- **Máximo 30 PNGs totales** (los 10 pantallas canónicas × 3 flavors).
- **Solo PNGs sin PII visible confirmado manualmente por el dev** al migrar.
- **Migración masiva queda gating** contra #3385 (política PII) o #3455 (OCR).

## 9. Limitaciones conocidas

| # / Tema                                                       | Descripción breve                                         |
|----------------------------------------------------------------|-----------------------------------------------------------|
| [#3385](https://github.com/intrale/platform/issues/3385)       | Política sanitización PII (bloquea migración masiva)      |
| [#3392](https://github.com/intrale/platform/issues/3392)       | Limitación relacionada con el flujo visual UX (paraguas)  |
| [#3393](https://github.com/intrale/platform/issues/3393)       | Manifest + alias `latest` (naming canónico alineado)      |
| [#3396](https://github.com/intrale/platform/issues/3396)       | Limitación relacionada                                    |
| [#3398](https://github.com/intrale/platform/issues/3398)       | Limitación relacionada                                    |
| [#3399](https://github.com/intrale/platform/issues/3399)       | Limitación relacionada                                    |
| [#3400](https://github.com/intrale/platform/issues/3400)       | Limitación relacionada                                    |
| Variantes de tema (light/dark)                                 | La librería inicial cubre solo light theme. Dark es deuda futura. |
| Localización (i18n)                                            | La librería inicial captura strings en español. Multi-idioma es deuda futura (naming `<pantalla>-<flavor>-<lang>-<fecha>.png` cuando aplique). |
| Mockups vs capturas reales                                     | Esta librería contiene capturas reales — los mockups esperados viven en el issue o en `.pipeline/assets/mockups/`. |

## 10. Deuda de migración

Listado de PNGs que **no se promovieron** a la librería durante CA-8 inicial
por razones específicas. Esta sección se va completando a medida que el
dev/UX detecta gaps.

> **Plantilla por entrada**:
>
> - **Path original**: `qa/evidence/<issue>/<filename>.png`
> - **Pantalla candidata**: `<pantalla>`
> - **Flavor candidato**: `<client|business|delivery|ambiguo>`
> - **Motivo NO migrar**: `<PII visible | flavor ambiguo | transición intermedia | …>`
> - **Bloqueo**: `<#3385 | #3455 | manual review | …>`

### Entradas registradas durante la migración inicial de #3407

> Detalle completo del descarte en
> [`docs/app-screenshots-reference/MIGRATION-INVENTORY.md §2`](../app-screenshots-reference/MIGRATION-INVENTORY.md#2-pngs-evaluados-y-no-migrados-deuda-registrada).
> Resumen de los grupos:

- **PNGs de issues sin label `app:*`** (`#1090`, `#1091`, `#1092`, `#1093`)
  — flavor ambiguo, no se puede asignar canónicamente. Deuda real: agregar
  `app:*` en el issue de origen si se reabren para capturar nueva evidencia.
  Pendiente review manual.

- **PNGs con dialog del SO superpuesto** (`1090/login-clean.png`,
  `2332/sc-01-app-home.png`) — contienen "System UI isn't responding" — no
  son canónicos, no se migran nunca.

- **PNGs del sistema Android, no de la app** (`2505/screenshot-01-home.png`
  con Play Store/Gmail, `2505/screenshot-03-drawer-search.png` con el drawer
  del launcher) — son capturas del sistema, no del producto. No se migran.

- **PNGs de issues con `app:business`/`app:client` no inspeccionados aún**
  (`1915/screenshot-qa-01-login.png` y variantes) — candidatos legítimos para
  `login-business` y otros, pendiente inspección visual de PII (`Read` con
  renderizado) en próxima iteración.

- **PNGs con email potencialmente cargado** (`1091/02b-recovery-email-filled.png`)
  — pendiente verificar si el email visible es sintético o real, bloqueado
  por #3385 (política PII) o #3455 (OCR automatizado).

## 11. Referencias cruzadas

- [`docs/app-screenshots-reference/README.md`](../app-screenshots-reference/README.md)
  — índice + convenciones de la librería.
- [`docs/app-screenshots-reference/MIGRATION-INVENTORY.md`](../app-screenshots-reference/MIGRATION-INVENTORY.md)
  — inventario detallado de PNGs candidatos.
- [`docs/pipeline/visual-validation.md`](visual-validation.md) — flujo
  genérico de validación visual **post-build** (otra etapa del ciclo). Este
  doc (`ux-android-visual-flow.md`) cubre específicamente el **lookup de
  assets previos durante definición**. Ambos coexisten sin duplicar
  contenido: `visual-validation.md` no toca librería curada por pantalla;
  este doc no toca side-by-side ni rejection report.
- `CLAUDE.md → "Tipos de issue y criterio QA"` — whitelist `qa:skipped`.
- [#3457](https://github.com/intrale/platform/issues/3457) — recomendación
  anti-drift entre estos dos docs.
- [#3458](https://github.com/intrale/platform/issues/3458) — recomendación
  de heurística formalizada para mapeo legacy → canónica.
