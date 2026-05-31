# Narrativa — Mockup Matriz V3 (#3731)

> Mockup adjunto: `.pipeline/assets/mockups/29-matriz-v3.html`
> Split: #3731 (parte de #3715 — rediseño UX integral del Dashboard V3).
> Decisión D3 del PO: **UN solo archivo HTML/CSS con ambos sub-paneles juntos** (no dos mockups separados).

## Por qué un único mockup

La ventana "Matriz" del dashboard agrupa **dos zonas funcionalmente distintas** pero **operativamente vecinas**: el panel `Necesitan intervención humana` (acción inmediata del operador) y el `Board Kanban del Pipeline` (visualización general del trabajo en curso). Mockuparlas por separado escondería la decisión clave: el operador las usa juntas. La primera le grita "atendé esto YA", la segunda le dice "y mientras tanto el resto avanza solo". Un único HTML refleja ese contrato visual.

## Lo que pasa cuando el operador mira esta ventana

1. **Si hay bloqueos pendientes** (rojo arriba): el rail rojo con el pulse del icono `ic-estado-needs-human` rompe el orden visual del dashboard. Es deliberado — el operador no debería poder no verlo. El badge contador (`2` en el mockup) cuantifica el dolor sin que tenga que contar filas.
2. **Cada fila bloqueada** trae los 4 datos mínimos para decidir sin abrir GitHub: número + título + skill/fase + edad. Si la edad pasa de 4h (regla del pipeline V3), el `fresh` amarillo se vuelve `old` rojo y la fila gana peso visual.
3. **Las acciones "Reactivar" / "Desestimar"** están al mismo nivel visual de la fila para que estén a un click — y el `title=` + `aria-label=` (CA-6) explican qué hace cada una. La distinción cromática (verde vs rojo) es dual-encoding con el texto: WCAG AA cubre operadores con daltonismo.
4. **Eventos recientes + resumen funcional** dan el "por qué llegamos acá" sin obligar al operador a leer todo el thread del issue.
5. **El footer recuerda los canales redundantes**: Telegram (`/unblock`) + label en GitHub (`needs-human`). El dashboard no es la única forma de desbloquear, y se nota.

Después del panel rojo aparece la **leyenda CA-C3** — un bloque seco que explica qué significa cada chip de color y marca explícitamente que las acciones son state-changing. Es la primera vez que un operador nuevo aterriza en esta ventana y sabe qué pasa si toca cada cosa.

Debajo está el **Board Kanban V3** — el centro visual del dashboard. El header trae el badge teal "V3" (mismo token que el resto del rediseño), el chevron de colapso, el search box `#it-search-input` con `placeholder` + `aria-label`, y las tabs `En progreso / Completados / Todos` con contadores y `title=` en cada una. Las 4 lanes (criterios → dev → build → verificación) muestran cada issue como una card con número, título corto, ETA, chip de skill (con color del provider o de la disciplina) y dot de estado (`progress` / `ok` / `warn`). La done lane separada al final acumula los últimos 24h con pills verdes — visible que el pipeline está produciendo sin que ocupe espacio de un lane completo.

## Por qué el rojo en `needs-human` y no más cyan

El cyan/teal del rediseño V3 lleva carga semántica de "acción exitosa / V3 nuevo / brand". Si el panel `needs-human` también estuviera en cyan, perdería su urgencia visual contra el resto del dashboard. El rojo `--danger` + `--danger-bg` está reservado para `needs-human`, `tg-banner caído` y `qa:failed`. Esa exclusividad lo mantiene como señal real, no decoración.

## Por qué se preservan los inline `onclick=`

Lo dejamos así por **decisión D4 del PO**. La migración a `addEventListener + data-attrs` es trabajo de #3758, que aterrizará junto con la CSP `script-src 'self'` del dashboard (#3688). Mover ahora obligaría a tocar también el bundle JS cliente — fuera del scope del split. El comentario en `matriz.js` debe dejar el TODO visible para que cuando #3758 entre, el dev sepa dónde mirar.

## Por qué el escape se duplica (no se importa la lib)

Por **decisión D5 del PO**. El helper `lib/escape-html.js` (#3722) sigue OPEN. Si entra antes de que el dev empiece esta historia, se importa. Si no, se copia la semántica exacta de `home.js:33-41` (`&#39;` no `&apos;`) con un TODO referenciando #3722. Cuando #3722 mergee, una sub-historia de unificación tocará `matriz.js` + `home.js` + `multi-provider*.js` de una sola vez.

## Lo que el mockup NO muestra (deliberadamente)

- **Estado de carga inicial**: el partial se renderiza ya con datos. Los skeletons del client-side morphing viven en el cliente JS, no en el SSR.
- **Estado de error**: si el render arroja, `dashboard.js` cae al fallback inerte (descrito en el inventario). El mockup muestra el camino feliz.
- **Vista mobile**: el dashboard V3 es kiosk vertical (1080×1920). No hay vista mobile-first esperada en esta ventana.
- **Variante con bloqueados.length === 0**: el sub-panel A directamente no se renderiza (`bloqueadosHTML = ''`). En esa variante el Board Kanban sube al tope. El mockup elige mostrar el caso "hay 2 bloqueados" porque es el caso que stress-tests todo el contrato.

## Tokens consumidos (no exhaustivo)

- Marca: `--brand-cyan`, `--brand-cyan-dim`.
- Severidad: `--danger`, `--danger-bg`, `--danger-dim` (needs-human), `--warning`, `--warning-bg` (fresh<4h), `--info`, `--info-bg` (en-progreso), `--success`, `--success-bg` (done).
- Superficies: `--surface-0` (body), `--surface-1` (panels), `--surface-2` (rows/lanes), `--surface-3` (cards/code).
- Texto: `--text-primary`, `--text-secondary`, `--text-dim`.
- Identidad V3: `--teal`, `--teal-bg` (badge `V3`), `--purple` (autor de evento, chip skill `ux`).
- Bordes: `--border`, `--border-subtle`, `--border-strong`.

Cero HEX libres en el mockup. Si llegara a faltar un token, se agrega a `design-tokens.css` — no se hardcodea en el HTML.

## Iconos consumidos (todos del sprite)

`ic-estado-needs-human`, `ic-link-out`, `ic-issues-count`, `ic-fase-criterios`, `ic-fase-dev`, `ic-fase-build`, `ic-fase-verificacion`, `ic-cell-pass`.

Cero `<svg>` raw en el HTML — todo via `<use href="../icons/sprite.svg#ic-*">`.

## Próximos pasos (para el dev en `desarrollo`)

1. Tomar este HTML como referencia visual.
2. Implementar `matriz.js` siguiendo la plantilla de `home.js` (loadTheme + escapeHtmlSsr + exports SSR).
3. Pasar los params por handoff (decisión D1: `dashboard.js` sigue construyendo `lanesHTML`).
4. Generar el screenshot Puppeteer del HTML mockup + screenshot real del partial renderizado en `localhost:3200/dashboard?view=matriz` y adjuntar ambos al PR para comparación visual (CA-9).
5. Verificar el smoke curl + tests SSR (CA-7, CA-8).
