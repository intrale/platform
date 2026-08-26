# Evidencia visual #6459

Baseline acordada: `.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg`.

## rev-7 — corrección del rebote de QA (render path)

El rebote rev-1 fue: *"el badge huérfano no se ve en el dashboard que abre el
operador. `GET /`, `/v3` y `/dashboard` devuelven CERO ocurrencias de
`cmd-result-huerfano`; sólo aparece en `GET /legacy`"*. Era correcto: el listado
con el badge vivía dentro de `generateHTML()` (`dashboard.js`), que el dispatch
sirve únicamente para `/legacy`.

- `rev7-v3-home-completo.png` — `GET /` del kiosk V3 (`views/dashboard/home.js`)
  con el panel **ACTIVIDAD DEL COMMANDER** visible y cuatro filas: `∅ huérfano`,
  `✓ ok`, `✗ error` y una fila sin sidecar que dice `(sin badge)`. Es la
  comparación que pide UX-5 (una fila con badge y una sin, en la misma imagen).
- `rev7-v3-home-zoom.png` — el mismo render a 2× para leer el glifo `∅`, la
  etiqueta `huérfano` y el rosa de `--result-huerfano`, distinto del rojo de
  `error`.
- `rev7-v3-home-sin-design-tokens.png` — mismo `GET /` con
  `.pipeline/assets/design-tokens.css` inaccesible (renombrado durante la
  captura). El badge conserva glifo, rosa, fondo y borde: verificación empírica
  de UX-2 (fallback hex literal, no `var(--x, var(--legacy))`).

Verificación de rutas del ciclo rev-7 (dashboard levantado desde el worktree en
el puerto 3311, con fixtures de logs recientes):

```
/                        -> cmd-result-huerfano: 2   panel: 1
/v3                      -> cmd-result-huerfano: 2   panel: 1
/dashboard               -> cmd-result-huerfano: 2   panel: 1
/legacy                  -> cmd-result-huerfano: 2   panel: 0
/dashboard?view=home     -> cmd-result-huerfano: 2   panel: 1
/dashboard/partial?view=home -> cmd-result-huerfano: 2  panel: 1
```

(2 = la regla CSS + el badge de la fila. Antes del fix, las tres primeras rutas
daban 0 y 0.)

## Evidencia de ciclos anteriores

- `dashboard-huerfano.png` y las `rev2..rev6`: capturas del render legacy
  (`/legacy`) y comparaciones contra el mockup. Se conservan como historia del
  rebote, **no** como evidencia vigente de CA-9/CA-13.
