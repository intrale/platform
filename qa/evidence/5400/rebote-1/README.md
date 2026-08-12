# Evidencia visual del rebote #5400

Captura realizada el 2026-08-09 sobre una instancia aislada del dashboard del
HEAD `469679b0e43e20827ecb6c1ffeddf91a3575ccba`, servida en
`http://127.0.0.1:3201/`. La instancia respondió HTTP 200 con 452.186 bytes de
HTML y fue detenida después de la captura.

- `dashboard-real.png`: dashboard ejecutándose, no el SVG de referencia.
- `render-estados-reales.png`: cuatro filas generadas por
  `renderDispatchCauseBanner()` usando los tokens e íconos reales: activo con
  cola vacía, activo con detención sostenida, watchdog OFF y degradado.
- `comparacion-render-real-vs-mockup.png`: comparación lado a lado del render
  anterior contra `.pipeline/assets/mockups/47-dispatch-stall-watchdog.svg`.
- `render-gallery.js`: generador reproducible de la galería y comparación.

## SHA-256

```text
B072E272296A284484EA08EC9299155B19FE675202B59853F6E9D26C9D90A765  dashboard-real.png
2BC6A66F94E6814BB49E04210D22C2699EFC94AEE9953B03CB3CBBDE3F261B46  render-estados-reales.png
C3C7B5270795CA87C9BF610B77681B306E3306DE2EE4C33CF5D1DE10C7B28CD5  comparacion-render-real-vs-mockup.png
9E8E022C707A1BB15976D292B37E67C755AD49650B04304973E602810240EFED  .pipeline/assets/mockups/47-dispatch-stall-watchdog.svg
```

Los PNG del rebote son distintos entre sí y ninguno coincide con el hash blanco
rechazado `2E1E9DD49A88342DD32F31AF0DDE8617334B6EB5377177F22A2AD3DA36E1B694`.
