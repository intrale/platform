# Fonts del Pipeline V3 — Sistema nativo (por diseno)

Este directorio esta **intencionalmente vacio**. El sistema visual del
pipeline usa un **system font stack** — las tipografias nativas del SO —
por las siguientes razones:

## Rationale

1. **Zero CDN externo** (CA-11 del issue #2523). Prohibido Google Fonts u
   otros CDNs: el dashboard debe funcionar sin internet, sin fuga de IP, sin
   dependencias de red en runtime.
2. **Zero bytes descargados** al cargar la pagina. Sin woff2 de 200KB+
   por familia.
3. **Respeta preferencias del usuario**. En macOS, San Francisco; en
   Windows, Segoe UI; en Android, Roboto. El user agent pide la fuente que
   ya tiene cargada en memoria.
4. **Accesibilidad nativa**. DynamicType / escalado del SO funcionan sin
   hacks adicionales.

## Stack actual

Definido en `.pipeline/assets/design-tokens.css`:

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI Variable",
             "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif;
--font-mono: "SF Mono", "Consolas", "Liberation Mono", Menlo, Monaco,
             "Courier New", monospace;
```

## Si en el futuro se agrega una tipografia custom

Respetar los mismos principios:

- Commitear los `woff2` **aqui** (`.pipeline/assets/fonts/`), no usar CDN.
- Servir desde el propio dashboard (mismo origin).
- Mantener fallback al system stack.
- Verificar que los glyphs cubren `es-AR` (tildes, eñe, ü) sin reemplazos
  feos.
- Documentar en `docs/pipeline/design-system.md` seccion 2.1.
