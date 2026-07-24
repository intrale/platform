# Inventario de migración inicial — CA-8 de #3407

> **Fecha de la migración inicial**: 2026-05-21.
> **Ejecutor**: android-dev (pipeline V3, issue #3407).
> **Cap aplicado**: máximo 1 PNG por `<pantalla>` × `<flavor>`, total ≤ 30 PNGs.
> **Política PII**: ver [README.md §2](README.md#2-política-no-pii-en-screenshots).
> **Migración masiva pendiente**: bloqueada hasta cierre de [#3385](https://github.com/intrale/agent-3407-android-dev/issues/3385) (política sanitización PII) y/o [#3455](https://github.com/intrale/platform/issues/3455) (OCR automatizado).

Este documento registra:

1. **PNGs migrados** a la librería con verificación manual de "sin PII visible".
2. **PNGs evaluados pero NO migrados** y el motivo (deuda explícita).
3. **Combinaciones pantalla × flavor sin candidato apto** en `qa/evidence/**`.

## 1. PNGs migrados (4)

| Origen (`qa/evidence/...`)                              | Destino                                                                     | Issue origen | Flavor   | Estado | Verificación PII                                            |
|---------------------------------------------------------|-----------------------------------------------------------------------------|--------------|----------|--------|-------------------------------------------------------------|
| `2333/screenshot-02-app-welcome.png`                    | `welcome/welcome-client-2026-05-21.png`                                     | #2333 (app:client) | client   | default | Inspección visual: pantalla de onboarding "Bienvenido a Intrale" con CTAs "Siguiente"/"Saltar". Sin texto productivo, sin datos de usuario. |
| `1924/screen-02-business-home.png`                      | `welcome/welcome-business-2026-05-21.png`                                   | #1924 (app:business) | business | default | Inspección visual: onboarding business "Administrá tu negocio con Intrale" con CTAs "Ingresar"/"Registrarme". Sin PII. Nota: el filename original dice "home" pero visualmente es un welcome/onboarding del business. |
| `2062/nav-01-login.png`                                 | `login/login-client-2026-05-21.png`                                         | #2062 (app:client) | client   | default | Inspección visual: form de login con campos vacíos (placeholders "Usuario", "Contraseña"). Sin credenciales escritas, sin emails reales. |
| `2062/qa-2062-rerun-07-signup.png`                      | `signup/signup-client-empty-2026-05-21.png`                                 | #2062 (app:client) | client   | empty   | Inspección visual: form de signup con campo "Correo electrónico" vacío + CTA "Registrarme". Sin datos cargados. |

Notas:

- Los 4 PNGs vienen de issues con label `app:*` único e inequívoco (no
  ambigüedad de flavor).
- Los 4 fueron inspeccionados visualmente por el agente mediante la
  herramienta `Read` con renderizado de imagen antes de migrar.
- Tamaños: 33KB–260KB cada uno (todos dentro del límite recomendado de 300KB).

## 2. PNGs evaluados y NO migrados (deuda registrada)

| Origen (`qa/evidence/...`)                              | Pantalla candidata    | Motivo NO migrar                                                                              | Bloqueo                          |
|---------------------------------------------------------|------------------------|-----------------------------------------------------------------------------------------------|----------------------------------|
| `1090/01-welcome.png`, `1090/01-welcome-screen.png`     | `welcome/`             | Issue #1090 no tiene label `app:*` (es `area:seguridad,area:testing`) → flavor ambiguo.       | Manual review + label en origen   |
| `1090/login-clean.png`                                  | `login/`               | Inspección visual: contiene dialog "System UI isn't responding" overlay → no es canónico.     | N/A (no canónico)                 |
| `1091/01a-welcome.png`, `1091/01b-login-screen.png`     | `welcome/`, `login/`   | Issue #1091 no tiene label `app:*` → flavor ambiguo.                                          | Manual review + label en origen   |
| `1091/02a-recovery-empty.png`                           | `login/` (sub-flow recovery) | Issue #1091 sin `app:*`. La pantalla de recovery es visualmente compartida entre flavors, pero sin label canónico no se puede asignar. | Manual review + label en origen   |
| `1091/02b-recovery-email-filled.png`                    | `login/` (sub-flow recovery) | Mismo motivo de #1091. Además contiene email cargado — pendiente verificar si es sintético. | Manual review + #3385             |
| `1091/03c-confirm-recovery-empty.png`                   | `login/` (sub-flow recovery) | Mismo motivo de #1091 (sin `app:*`).                                                          | Manual review + label en origen   |
| `1092/step1-welcome.png`, `1092/first-login-form.png`   | `welcome/`, `login/`   | Issue #1092 no tiene label `app:*` → flavor ambiguo.                                          | Manual review + label en origen   |
| `1093/02-home.png`                                      | `home/` (era candidato) | Inspección visual: en realidad es welcome, no home. Issue #1093 sin `app:*`.                  | Manual review + label en origen   |
| `1924/qa-pass3-06-business-home.png` y variantes pass2/pass3 | `home/`                | Inspección visual: son la misma onboarding del business, no home con datos. Ya migramos la representativa en `welcome-business`. | N/A (ya cubierto)                 |
| `2062/nav-00-welcome.png`                               | `welcome/`             | Variante alternativa del welcome client; ya migramos la versión más reciente del onboarding (`2333/screenshot-02-app-welcome.png`). | N/A (ya cubierto)                 |
| `2332/sc-01-app-home.png`                               | `home/`                | Inspección visual: contiene dialog "System UI isn't responding" overlay → no es canónico.     | N/A (no canónico)                 |
| `2505/screenshot-01-home.png`                           | `home/`                | Inspección visual: es la home screen del sistema Android (Play Store, Gmail, etc.), no la home de la app Intrale. | N/A (no canónico)                 |
| `2505/screenshot-03-drawer-search.png`                  | `busqueda/`            | Inspección visual: es el drawer/launcher de búsqueda del sistema Android mostrando los 3 íconos de Intrale, no la búsqueda interna de la app. | N/A (no canónico)                 |
| `2351/screenshot-03-back-to-welcome.png`                | `welcome/`             | Variante alternativa del welcome client; existe candidato más representativo (#2333).         | N/A (ya cubierto)                 |
| `2334/screenshot-04-welcome.png`                        | `welcome/`             | Variante alternativa del welcome client; existe candidato más representativo (#2333).         | N/A (ya cubierto)                 |
| `1915/screenshot-qa-01-login.png` y variantes           | `login/`               | Issue #1915 `app:business`, candidato para `login-business`. **NO migrado por ahora**: no inspeccionado visualmente en este ciclo, riesgo de credenciales cargadas (el filename sugiere captura post-login). | Próxima iteración con inspección visual |

## 3. Combinaciones `<pantalla>` × `<flavor>` sin migración en este ciclo

Combinaciones canónicas **sin PNG en la librería** después de la migración
inicial. Estas pantallas necesitan captura nueva en próximos ciclos QA o
verificación manual de candidatos existentes.

| Pantalla            | client     | business   | delivery   |
|---------------------|------------|------------|------------|
| `login`             | ✓ migrado  | pendiente  | pendiente  |
| `signup`            | ✓ migrado (empty) | pendiente  | pendiente  |
| `welcome`           | ✓ migrado  | ✓ migrado  | pendiente  |
| `home`              | pendiente  | pendiente  | pendiente  |
| `busqueda`          | pendiente  | pendiente  | pendiente  |
| `detalle-producto`  | pendiente  | pendiente  | N/A (no aplica) |
| `carrito`           | pendiente  | N/A (no aplica) | N/A (no aplica) |
| `checkout`          | pendiente  | N/A (no aplica) | N/A (no aplica) |
| `perfil`            | pendiente  | pendiente  | pendiente  |
| `pedidos`           | pendiente  | pendiente  | pendiente  |

`N/A` = la pantalla no aplica a ese flavor según los READMEs por pantalla.

## 4. Próximos pasos

1. Esperar cierre de [#3385](https://github.com/intrale/platform/issues/3385)
   y/o [#3455](https://github.com/intrale/platform/issues/3455) para habilitar
   migración masiva con validación OCR automatizada.
2. Mientras tanto, las capturas de QA aprobadas por issue (con label
   `qa:passed`) pueden promoverse case-by-case siguiendo el procedimiento de
   [`docs/pipeline/ux-android-visual-flow.md §6`](../pipeline/ux-android-visual-flow.md#6-promoción-a-librería-criterio-operativo).
3. Para los issues sin `app:*` (1090, 1091, 1092, 1093), la deuda real es de
   trazabilidad del label de origen, no de la librería. Si se reabren para
   capturar evidencia nueva, sumar `app:*` apropiado.

## 5. Trazabilidad

- Esta migración corresponde a la fase de **desarrollo** del issue
  [#3407](https://github.com/intrale/platform/issues/3407).
- Verificación empírica documentada en el comentario YAML del agente
  android-dev en `.pipeline/desarrollo/dev/listo/3407.android-dev`.
- Cualquier promoción posterior a la librería debe actualizar este inventario
  agregando entrada en §1 y removiendo la "pendiente" correspondiente en §3.
