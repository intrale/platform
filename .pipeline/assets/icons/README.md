# Iconografia del Pipeline V3

Sprite vectorial unico con todos los iconos del sistema visual. La fuente de
verdad es `sprite.svg`. Los archivos individuales se generan bajo demanda con
el script `extract.js` y se usan solo cuando el consumidor **no** puede
incluir el sprite (ej. render a PNG para mensajes de Telegram).

## Uso en el dashboard HTML

El sprite se incluye **una sola vez** al comienzo del `<body>` (invisible), y
cada icono se referencia via `<svg><use href="#ic-*" /></svg>`:

```html
<!-- Una sola vez, al inicio del body -->
<svg style="display:none" aria-hidden="true">...contenido de sprite.svg...</svg>

<!-- Cada uso: -->
<svg class="icon" role="img" aria-label="fase: desarrollo" width="18" height="18">
  <use href="#ic-fase-dev" />
</svg>
```

## Lista de iconos canonicos

### Branding

| ID                 | Nombre                         | Uso                    |
|--------------------|--------------------------------|------------------------|
| `ic-intrale-logo`  | Isotipo Intrale simplificado   | Header, favicon v3     |

### Fases de definicion

| ID                   | Nombre                  | Estado del flow        |
|----------------------|-------------------------|------------------------|
| `ic-fase-analisis`   | Lupa                    | analisis (guru)        |
| `ic-fase-criterios`  | Lista con checks        | criterios (po + ux)    |
| `ic-fase-sizing`     | Regla graduada          | sizing (planner)       |

### Fases de desarrollo

| ID                      | Nombre              | Estado del flow          |
|-------------------------|---------------------|--------------------------|
| `ic-fase-validacion`    | Escudo con check    | validacion (guru + ux)   |
| `ic-fase-dev`           | Llaves de codigo    | dev (backend/android/web)|
| `ic-fase-build`         | Caja apilada        | build (builder)          |
| `ic-fase-verificacion`  | Checklist con lupa  | verificacion             |
| `ic-fase-linteo`        | Escoba              | linteo (cleanup)         |
| `ic-fase-aprobacion`    | Thumbs up           | aprobacion (review)      |
| `ic-fase-entrega`       | Camion + paquete    | entrega (delivery)       |

### Estados transversales

| ID                          | Nombre                  | Significado                          |
|-----------------------------|-------------------------|--------------------------------------|
| `ic-estado-rebote`          | Flecha en U             | rebote normal (misma fase)           |
| `ic-estado-crossphase`      | Flechas cruzadas        | cross-phase rebote (#2516)           |
| `ic-estado-partial-pause`   | Pausa + candado         | pausa parcial con allowlist          |
| `ic-estado-circuit-breaker` | Tubo cortado            | circuit breaker abierto              |
| `ic-estado-needs-human`     | Figura + signo pregunta | intervencion manual requerida        |
| `ic-estado-voz-narrando`    | Onda de sonido          | agente TTS activo (#2518)            |
| `ic-estado-retrying`        | Flechas circulares      | reintentando (#2337)                 |
| `ic-estado-stale`           | Reloj difuso            | sin actividad reciente               |

### Indicadores del header

| ID                  | Nombre              | Uso                               |
|---------------------|---------------------|-----------------------------------|
| `ic-health-ok`      | Check circulo       | salud: sano                       |
| `ic-health-warn`    | Triangulo alerta    | salud: con alertas                |
| `ic-agents-count`   | Siluetas agrupadas  | KPI: N agentes activos            |
| `ic-issues-count`   | Layers / pila       | KPI: N issues en curso            |

### Modo descanso y alertas de consumo (#2882)

| ID                    | Nombre                  | Uso                                                           |
|-----------------------|-------------------------|---------------------------------------------------------------|
| `ic-rest-mode`        | Luna + estrellas        | Pill del header / banner cuando modo descanso esta activo     |
| `ic-cost-anomaly`     | Linea con pico          | Banner persistente de alerta de consumo anomalo               |
| `ic-snooze`           | Campana + Z             | Boton/menu de snooze de alerta (1h/4h/24h)                    |
| `ic-deterministic`    | Engranaje               | Marca skills que corren durante modo descanso (sin LLM)       |

## Convenciones de diseno

- **ViewBox**: 24x24 uniforme.
- **Estilo**: outline con `stroke-width="1.75"`, `stroke-linecap="round"`,
  `stroke-linejoin="round"`.
- **Color**: `stroke="currentColor"` — el color lo inyecta el contexto CSS
  (ej. `color: var(--lane-qa)` en el contenedor).
- **Relleno**: solo donde el icono lo requiere semanticamente (ej. badge del
  logo). El resto `fill="none"`.

## Requisitos de seguridad (CA-2 del issue #2523)

Todo SVG commiteado **debe** cumplir:

- Sin `<script>`, `<foreignObject>`.
- Sin atributos `on*` (onload, onclick, onerror, etc.).
- Sin `href`/`xlink:href` con `javascript:` o URLs externas.
- `<use href="#id">` solo referencia fragmentos locales.

El issue #2534 (abierto) automatiza esta verificacion con un linter pre-commit.

## Accesibilidad

- Cada `<use>` **debe** tener contexto accesible:
  - `role="img"` en el `<svg>` contenedor.
  - `aria-label` descriptivo del **estado**, no del dibujo (ej.
    `aria-label="fase: validacion"`, no `aria-label="escudo con check"`).
- Los simbolos del sprite **no** llevan `<title>` propio para evitar
  tooltips nativos; el `aria-label` del contexto manda.
- Contraste minimo 3:1 en cualquier pareado color / fondo — ver
  `docs/pipeline/design-system.md` seccion "Accesibilidad".

## Generar versiones individuales

Para exportar un icono como SVG standalone (ej. para convertir a PNG):

```bash
node .pipeline/assets/icons/extract.js ic-fase-dev > /tmp/ic-fase-dev.svg
```

Ver `extract.js` para el script completo.
