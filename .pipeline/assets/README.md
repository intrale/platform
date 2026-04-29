# Assets visuales del Pipeline V3

Sistema visual unificado para todas las superficies del pipeline:
dashboard HTML, `/consumo`, PDFs de rejection y mensajes de Telegram.

## Estructura

```
.pipeline/assets/
├── design-tokens.css          # Paleta + tipografia + radios + animacion (fuente de verdad)
├── icons/
│   ├── sprite.svg             # Sprite con los 22 iconos canonicos como <symbol>
│   ├── extract.js             # Script Node para extraer iconos individuales
│   └── README.md              # Tabla completa de iconos con IDs y usos
├── mockups/
│   ├── 01-home-dashboard.svg  # Home del dashboard V3 (1440x900)
│   ├── 02-issue-drilldown.svg # Drilldown de issue individual (1440x900)
│   ├── 03-consumo.svg         # Pagina /consumo (1440x900)
│   ├── narrativa-lili.md      # Script narrado del sistema (para TTS)
│   └── narrativa-lili.mp3     # Audio narrado con voz es-AR (perfil ux — Lili)
└── fonts/
    └── README.md              # Por que esta vacia (system font stack, zero CDN)
```

## Documentacion del sistema

- **Design system completo**: `docs/pipeline/design-system.md`
- **Iconografia detallada**: `.pipeline/assets/icons/README.md`

## Responsabilidades

- **El perfil `ux` del pipeline** es el unico dueno de este directorio. Los
  cambios a paleta, tipografia o iconografia pasan siempre por UX.
- **El perfil `pipeline-dev`** consume estos assets para aplicarlos a
  `dashboard.js` en fase `dev` del pipeline de desarrollo.
- **Los skills `po` y `guru`** participan en la validacion cross-cutting
  (coherencia de marca y viabilidad tecnica respectivamente).

## Flujo de trabajo

1. UX produce / actualiza assets en este directorio (fase `criterios` o
   `validacion`).
2. UX commitea los assets al repo desde su worktree.
3. Pipeline-dev los aplica a `dashboard.js` en fase `dev`.
4. QA / UX verifican en fase `aprobacion` que lo entregado respeta el
   sistema visual.

## Principios inquebrantables

1. **Zero CDN externo**. Fuentes del sistema, sin Google Fonts, sin scripts
   de terceros.
2. **WCAG AA minimo** en todo par color/fondo (ver design-system.md seccion
   1.3 para la tabla de ratios).
3. **SVGs sin codigo activo**. Sin `<script>`, sin atributos `on*`, sin
   `href` externos ni `javascript:`. El issue #2534 automatizara esta
   verificacion en pre-commit.
4. **Un solo lenguaje visual**. Misma paleta, mismos iconos en todas las
   superficies.
