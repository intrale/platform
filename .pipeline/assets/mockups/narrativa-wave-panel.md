# Narrativa visual — Widget "Próximas Olas" (#3487 — Spike #3378 H3)

> Documento UX que acompaña al mockup `20-wave-panel.svg` y a los tres íconos
> agregados al sprite (`ic-wave`, `ic-collapse`, `ic-expand`). Define el sistema
> visual del widget que se incorpora al dashboard interno V3 para visibilizar
> la composición de la ola activa y la próxima ola con sus issues, prioridades,
> tamaños y estados.

## Contexto del feature

La planificación multi-ola es una formalización del modelo Kanban continuo de
Intrale (Spike #3378). Cada **ola** agrupa un conjunto de issues que el
pipeline puede procesar en paralelo respetando los límites de concurrencia y
las dependencias declaradas. La fuente de datos es `waves.json` (mantenido por
el planner — #3489 H1). Este widget es el consumer en el dashboard V3:
muestra la **ola activa** y la **próxima** (lookahead 1) para que el equipo
pueda ver en un golpe de vista qué viene ahora y qué viene después.

El issue es **infra pura** del pipeline (labels `area:dashboard` + `area:pipeline`,
sin `app:*`) — no afecta al usuario final del producto. La única superficie
visual es el dashboard interno del equipo Intrale, que vive en `localhost`.

## Decisiones de diseño

### 1. Reuso integral del sistema de tokens existente
- 100 % del color, tipografía y espaciado vienen de
  `.pipeline/assets/design-tokens.css`. Cero tonos nuevos.
- Se eligió `--purple` (`#BC8CFF`) como acento de la **ola activa**: ya está
  reservado como `lane-definicion` en los tokens, y la planificación es
  precisamente "ideación cristalizada en olas concretas". Coherente con el
  resto del dashboard.
- La **próxima ola** usa `--purple-dim` (`#8957E5`) con `opacity: 0.78` en
  el contenedor, y los semánticos en `alpha: 0.10` (vs `alpha: 0.14` de la
  ola activa). Da el efecto de "esto viene después" sin perder legibilidad.

### 2. Layout vertical (kiosk 1080×1920)
- El target explícito del issue es kiosk vertical, así que el mockup se
  diseñó en 1080×1920. El layout fluye en columna única (header → ola activa
  → próxima ola → estado de fallback → leyenda).
- Cada panel de ola ocupa el ancho completo menos un padding de 32px a cada
  lado, manteniendo el rítmo visual de los otros widgets del dashboard.
- En el desktop (1440×900) el mismo widget se renderea más compacto, sin
  cambiar el sistema de tokens ni la jerarquía visual.

### 3. Pills de prioridad con whitelist cerrada
Mapeo desde los labels `priority:*` de Project V2:

| Label de GitHub      | Token             | HEX        | Uso                         |
|----------------------|-------------------|------------|-----------------------------|
| `priority:critical`  | `--danger`        | `#F85149`  | Solo issues que detienen el flujo. |
| `priority:high`      | `--retry`         | `#F59E0B`  | Ámbar — urgencia operativa. |
| `priority:medium`    | `--warning`       | `#D29922`  | Mostaza — defecto razonable. |
| `priority:low`       | `--text-dim`      | `#8B949E`  | Gris — sin urgencia.        |

El **dev debe respetar el whitelist** que pide el review de security: cualquier
valor fuera del set se mapea a `low` (gris) — no se inventan colores ni se
hereda un default arbitrario.

### 4. Pills de size sin color (solo texto)
- Las pills S/M/L/XL son **neutras** (`#1C2128` con borde `#30363D`).
- Decisión deliberada: el tamaño es un dato cuantitativo neutro, no
  comunica urgencia ni estado. Cargar de color un dato neutral aumentaría
  ruido visual y restaría protagonismo a prioridad y estado.

### 5. Badges de estado con glyph + texto (accesibilidad)
Mapeo whitelist:

| Estado          | Token       | HEX        | Glyph                            |
|-----------------|-------------|------------|----------------------------------|
| `ready`         | `--success` | `#3FB950`  | Punto verde + texto              |
| `needs-def`     | `--warning` | `#D29922`  | Punto amarillo + texto           |
| `in-progress`   | `--info`    | `#58A6FF`  | Punto azul + texto               |
| `blocked`       | `--danger`  | `#F85149`  | Punto rojo + texto               |
| `unknown` (fallback) | `--text-dim` | `#8B949E` | Punto gris + texto "unknown" |

**Nunca solo color**: cada estado combina color de fondo, glyph circular y
texto. Cumple WCAG AA y permite leer el estado en escala de grises.

### 6. Toggle collapse/expand sobre cada ola
- Botones cuadrados 32×32 (touch target adecuado para kiosk).
- Iconos: `ic-collapse` (chevron arriba en cuadrado) y `ic-expand` (chevron
  abajo en cuadrado). Simetría visual entre ambos.
- Estado persistido en `sessionStorage` con clave `wave-panel-state-${number}`.
- Al colapsar, sólo queda el header (badge ACTIVA/PROXIMA + número + nombre
  + meta) y el toggle. La lista de issues desaparece con `display:none` —
  no hay animación obligatoria (`prefers-reduced-motion` respetado).
- Cada ola se colapsa de manera **independiente** (CA explícito).

### 7. Barra de progreso de ola activa
- Indicador visual `--purple` gradient sobre track neutro.
- Texto adjunto `X de Y listas — Z%` + ETA estimado por velocidad reciente.
- No reemplaza el conteo del header, lo refuerza visualmente. La proporción
  ready / total da una sensación inmediata del estado del bloque.

### 8. Visualización del polling sin flicker
Una banda dedicada explica al usuario que:
- El fetch es cada 30 segundos.
- El DOM se actualiza por id, sin reemplazar el container.
- Hay un ejemplo visual del cambio de estado de un issue (`needs-def → ready`)
  para anclar la promesa del CA "morphing manual de DOM".

Esto cumple dos funciones: documenta la decisión técnica frente a futuros
agentes que toquen el widget, y le da al observador del kiosk una pista
visual de que los datos están vivos.

### 9. Estado vacío (`waves.json` ausente)
- Caja con borde dasheado (`stroke-dasharray="4 3"`) para diferenciarlo de
  paneles activos.
- Icono `ic-wave` en grande con `opacity: 0.55` — la metáfora se mantiene
  pero atenuada.
- Mensaje: "Planificación no disponible" + subtexto "El planner todavía no
  generó waves.json — esperando la próxima ronda".
- Botón "Reintentar ahora" para el caso operativo en que el equipo sepa que
  acaba de correr el planner y no quiera esperar el polling.
- **El widget conserva su espacio en el layout** (CA explícito) — no
  desaparece, no colapsa la columna, no rompe la grilla.

### 10. Diferenciación ola activa vs próxima
Cinco señales coordinadas (no una sola):
1. Badge textual `ACTIVA` (con punto verde) vs `PROXIMA` (con punto gris).
2. Borde superior con gradiente saturado vs desaturado.
3. Opacity del contenedor de issues (`1.0` vs `0.78`).
4. Alpha de los semánticos (`0.14` vs `0.10`).
5. Posición en el flujo (activa siempre arriba de la próxima).

Cualquiera de las cinco basta para distinguir; las cinco juntas hacen
imposible confundirlas incluso con limitaciones visuales.

## Sistema de íconos (sprite)

Se agregaron tres nuevos `<symbol>` al sprite `.pipeline/assets/icons/sprite.svg`:

- **`ic-wave`** — dos crestas de onda apiladas. Identifica el widget en su
  título y aparece en el estado de fallback en grande.
- **`ic-collapse`** — chevron hacia arriba dentro de un cuadrado redondeado.
  Botón para contraer una ola.
- **`ic-expand`** — chevron hacia abajo dentro de un cuadrado redondeado.
  Botón para expandir una ola colapsada. Simetría visual con `ic-collapse`.

Las tres siguen las convenciones del sprite: viewBox 24×24, stroke
`currentColor`, sin scripts ni atributos `on*`, accesibilidad delegada al
contexto.

## Requisitos defensivos cruzados con security

El review de seguridad (#3487 comment) pidió cinco requisitos defensivos.
Todos se reflejan visualmente en el mockup y deben respetarse en la
implementación:

1. **Escapar todo string** que venga de `waves.json` (nombre de ola, goal,
   título de issue). El dev usa `escapeHtml()` o `textContent`.
2. **Endpoint `/api/dash/waves` retorna 200 con estructura vacía** si
   `waves.json` no existe o es inválido. El mockup ilustra ese caso en la
   sección de fallback.
3. **Whitelist explícito de campos por issue**: `{id, title, priority, size,
   status}` y nada más. No `...spread`. El mockup nunca muestra campos
   adicionales.
4. **Validación de tipos antes de servir**: `id` number, `title` string ≤ 200
   chars (truncar), `priority`/`size`/`status` dentro de un set conocido.
   Valores fuera caen a `unknown` (token `--text-dim`, glyph + texto explícito).
5. **`Cache-Control: no-store`** reusado vía `sendJson()` del módulo de
   routes. No escribir un helper paralelo.

## Componentes del dashboard que se reusan

| Recurso                              | Estado    | Origen                          |
|--------------------------------------|-----------|---------------------------------|
| `sendJson(res, payload, status)`     | Existe    | `.pipeline/lib/dashboard-routes.js:195` |
| `escapeHtml(s)`                      | Existe    | `.pipeline/dashboard.js:~1196`  |
| Patrón fetch + morphing 30s          | Existe    | Widgets recomendaciones, sprint |
| Design tokens (`--purple`, semánticos) | Existe  | `.pipeline/assets/design-tokens.css` |
| Sprite (`ic-wave`, `ic-collapse`, `ic-expand`) | Nuevo en este issue | `.pipeline/assets/icons/sprite.svg` |
| `sessionStorage`                     | API nativa | Browser                         |

## Criterios de aceptación visuales (entregables UX para validar en `verificacion`)

- [x] Pills de prioridad con la paleta del whitelist (`critical`/`high`/
      `medium`/`low`).
- [x] Pills de size neutras (`S`/`M`/`L`/`XL`).
- [x] Badges de estado con glyph + color + texto (whitelist `ready`/`needs-def`/
      `in-progress`/`blocked` + fallback `unknown`).
- [x] Ola activa con borde `--purple` saturado, próxima con `--purple-dim`
      desaturado.
- [x] Botones collapse/expand 32×32 con iconos nuevos del sprite.
- [x] Estado vacío con borde dasheado, ícono wave grande atenuado, mensaje
      explícito.
- [x] Barra de progreso opcional de la ola activa.
- [x] Banda explicativa de morphing (cumple CA "morphing sin flicker").
- [x] Leyenda al pie con los tres ejes (prioridad, size, estado).
- [x] Layout vertical 1080×1920 sin overflow ni truncado incompleto.

## Open questions (no bloquean la implementación)

Ninguna abierta. El mockup cubre todos los escenarios Gherkin del issue +
las cinco mitigaciones del review de security + los whitelist cerrados que
guru pidió consolidar en `lib/waves.js` (post-merge de #3489).

— ux
