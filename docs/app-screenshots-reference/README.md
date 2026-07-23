# Librería de screenshots Android — referencia canónica

> **Issue origen**: [#3407](https://github.com/intrale/platform/issues/3407) (split de [#3382](https://github.com/intrale/platform/issues/3382)) · estructura base + documentación operativa.
> **Doc operativa del flujo**: [`docs/pipeline/ux-android-visual-flow.md`](../pipeline/ux-android-visual-flow.md).
> **Referencia cruzada anti-drift**: [`docs/pipeline/visual-validation.md`](../pipeline/visual-validation.md) — flujo genérico de validación visual post-build.

Este directorio aloja la **librería curada de screenshots Android por pantalla**
que se usa como referencia visual cross-agente durante la definición y la
validación de historias con label `app:client`, `app:business` o `app:delivery`.

No reemplaza a `qa/evidence/<issue>/` — son responsabilidades complementarias.
Ver §3 para la distinción.

## 1. Estructura

```
docs/app-screenshots-reference/
├── README.md                  ← este archivo (índice + convenciones)
├── MIGRATION-INVENTORY.md     ← inventario de PNGs candidatos a migración (CA-8)
├── login/
│   ├── README.md              ← alcance del flujo + estados representativos
│   └── <pantalla>-<flavor>-<YYYY-MM-DD>.png
├── signup/
├── welcome/
├── home/
├── busqueda/
├── detalle-producto/
├── carrito/
├── checkout/
├── perfil/
└── pedidos/
```

### 1.1 Convención de naming de directorios

- **Kebab-case** estricto. Ej: `detalle-producto/`, `carrito/`.
- **Sin acentos ni eñes**. Ej: `busqueda/` (no `búsqueda/`), `pedidos/` (no `pédidos/`).
- **Singular o plural según semántica del flujo**. `pedidos` cubre listado +
  detalle; `detalle-producto` es un detalle específico.

### 1.2 Convención de naming de archivos

```
<pantalla>-<flavor>-<YYYY-MM-DD>.png             ← estado default (happy path)
<pantalla>-<flavor>-<estado>-<YYYY-MM-DD>.png    ← estado adicional (empty/loading/error/success)
```

Alineado con el manifest + alias `latest` propuesto en [#3393](https://github.com/intrale/platform/issues/3393).

Ejemplos válidos:

- `login-client-2026-05-21.png` — login del flavor client, default.
- `carrito-client-empty-2026-05-21.png` — carrito vacío.
- `home-business-2026-05-21.png` — home del flavor business.

Ejemplos inválidos:

- `Login_Client_21May2026.png` — espacios/underscore/fecha no ISO.
- `login.png` — sin flavor ni fecha.
- `búsqueda-client-2026-05-21.png` — acento en el directorio padre y/o filename.

### 1.3 Pantallas canónicas iniciales

| Pantalla            | Alcance breve                                                |
|---------------------|--------------------------------------------------------------|
| `login`             | Autenticación + recovery (sub-flow del mismo módulo)         |
| `signup`            | Registro de usuario nuevo (incluye validaciones de campos)   |
| `welcome`           | Pantalla inicial post-install y onboarding mínimo            |
| `home`              | Pantalla principal post-login (varía fuerte por flavor)      |
| `busqueda`          | Búsqueda de productos/comercios/pedidos (según flavor)       |
| `detalle-producto`  | Vista detalle de un producto (catálogo client/business)      |
| `carrito`           | Carrito de compras (aplica client; ver README por pantalla)  |
| `checkout`          | Confirmación + pago (aplica client; ver README por pantalla) |
| `perfil`            | Perfil de usuario + ajustes                                  |
| `pedidos`           | Listado + detalle de pedidos                                 |

La lista es **inicial** — al agregar nuevas pantallas canónicas, sumar
directorio + README + actualizar esta tabla y la lista equivalente en
`docs/pipeline/ux-android-visual-flow.md`.

## 2. Política "no PII en screenshots"

> Política formal y herramientas de validación: [#3385](https://github.com/intrale/platform/issues/3385) (política sanitización PII) y [#3455](https://github.com/intrale/platform/issues/3455) (OCR automatizado para migración masiva).

**Nunca** se promueve a esta librería un screenshot con:

- Emails reales del usuario (usar `qa@intrale.test` o equivalentes sintéticos).
- Nombres reales, apellidos, DNIs, CUITs, teléfonos productivos.
- JWTs, tokens de acceso, refresh tokens, headers de Authorization visibles
  en debug overlays.
- Números de tarjeta de pago aunque sean de test (Stripe, MercadoPago, etc.).
- Direcciones físicas reales o coordenadas GPS de un usuario identificable.
- Cualquier dato proveniente de la Lambda productiva sin sanitización.

Si un screenshot tiene PII visible o sospecha → **NO migrar**, registrar como
deuda en `docs/pipeline/ux-android-visual-flow.md` sección
"Deuda de migración" con el path original y el motivo.

## 3. Relación con `qa/evidence/<issue>/`

| Aspecto                    | `qa/evidence/<issue>/`                          | `docs/app-screenshots-reference/<pantalla>/` |
|----------------------------|-------------------------------------------------|----------------------------------------------|
| Propósito                  | Evidencia efímera de auditoría por ejecución QA | Referencia visual canónica por pantalla       |
| Vida útil                  | Asociada al issue, retención según política QA  | Persistente, mantenida activamente            |
| Naming                     | Libre dentro de `qa/evidence/<issue>/`          | Estricto: `<pantalla>-<flavor>-<fecha>.png`   |
| Sanitización PII           | Obligatoria al subir (sanitizar emails/JWT)     | Obligatoria + cap más estricto (sin sospecha) |
| Curación                   | No — el QA sube lo que captura                  | Sí — solo entra lo que sirve como referencia  |
| Indexación                 | Por issue                                       | Por pantalla canónica                         |

### Cuándo promover un PNG de `qa/evidence/` a la librería

- **Promover** si: QA aprobó el issue + el screenshot muestra el estado
  happy-path/error/empty representativo + sin PII + es el más reciente para
  la combinación `<pantalla>` × `<flavor>`.
- **No promover** si: es un edge case específico no canónico (transición
  intermedia, modal puntual), tiene PII, o ya hay uno más reciente.

Ver `docs/pipeline/ux-android-visual-flow.md` §"Promoción a librería" para el
procedimiento operativo.

## 4. Guidelines UX (resumen)

Los guidelines completos viven en el comentario UX del issue
[#3407](https://github.com/intrale/platform/issues/3407#issuecomment-4509737264).
Resumen mínimo para el lector que cura un screenshot:

- **Happy path por default** — el PNG sin sufijo de estado representa la
  pantalla en condiciones normales con datos sintéticos.
- **Datos sintéticos visibles** — nombres ficticios, montos redondos
  (`$1.000`), teléfono de prueba (`+54 9 11 0000 0000`), email
  `qa@intrale.test`.
- **Tema Material3 + Intrale** correcto — paleta, tipografía y espaciados
  consistentes con `ui/th/`. Tema roto = bug, no canónico.
- **Densidad preferida**: `xxhdpi` (480dpi). Resolución típica: 1080×2400.
- **Peso recomendado**: <300KB por PNG.
- **Diferenciación por flavor** — los READMEs por pantalla declaran si la
  pantalla cambia entre `client`/`business`/`delivery` o no aplica a un flavor.
- **Accesibilidad cualitativa** — cada README incluye una línea breve sobre
  contraste (WCAG AA), touch targets y labels visibles.

## 5. Estados representativos (opt-in por pantalla)

| Estado     | Naming                                                      | Cuándo capturar                          |
|------------|-------------------------------------------------------------|------------------------------------------|
| `default`  | `<pantalla>-<flavor>-<YYYY-MM-DD>.png`                       | Siempre — happy path                     |
| `empty`    | `<pantalla>-<flavor>-empty-<YYYY-MM-DD>.png`                 | Listas/colecciones vacías                |
| `loading`  | `<pantalla>-<flavor>-loading-<YYYY-MM-DD>.png`               | Solo si el loading es distintivo         |
| `error`    | `<pantalla>-<flavor>-error-<YYYY-MM-DD>.png`                 | Feedback de error visible                |
| `success`  | `<pantalla>-<flavor>-success-<YYYY-MM-DD>.png`               | Confirmación post-acción                 |

El README de cada pantalla declara cuáles estados aplican.

## 6. Referencias cruzadas

- [`docs/pipeline/ux-android-visual-flow.md`](../pipeline/ux-android-visual-flow.md)
  — flujo operativo end-to-end de esta librería.
- [`docs/pipeline/visual-validation.md`](../pipeline/visual-validation.md)
  — guidelines genéricas de validación visual post-construcción.
- [`MIGRATION-INVENTORY.md`](MIGRATION-INVENTORY.md) — inventario de PNGs
  candidatos a migración inicial (CA-8 de #3407).

## 7. Issues y recomendaciones relacionadas

| Issue                                                            | Descripción                                              |
|------------------------------------------------------------------|----------------------------------------------------------|
| [#3382](https://github.com/intrale/platform/issues/3382)         | Historia paraguas (esta es 1/3 hijas)                    |
| [#3385](https://github.com/intrale/platform/issues/3385)         | Política sanitización PII (bloquea migración masiva)     |
| [#3392](https://github.com/intrale/platform/issues/3392)         | Limitación conocida (ver doc operativa)                  |
| [#3393](https://github.com/intrale/platform/issues/3393)         | Manifest + alias `latest` (naming alineado)              |
| [#3396](https://github.com/intrale/platform/issues/3396)         | Limitación conocida (ver doc operativa)                  |
| [#3398](https://github.com/intrale/platform/issues/3398)         | Limitación conocida (ver doc operativa)                  |
| [#3399](https://github.com/intrale/platform/issues/3399)         | Limitación conocida (ver doc operativa)                  |
| [#3400](https://github.com/intrale/platform/issues/3400)         | Limitación conocida (ver doc operativa)                  |
| [#3455](https://github.com/intrale/platform/issues/3455)         | OCR no-PII para migración masiva (bloquea CA-8 masivo)   |
| [#3457](https://github.com/intrale/platform/issues/3457)         | Anti-drift cross-doc (recomendación, no bloqueante)      |
| [#3458](https://github.com/intrale/platform/issues/3458)         | Heurística mapeo legacy → canónica (recomendación)       |
