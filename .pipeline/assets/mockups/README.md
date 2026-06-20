# Mockups del Pipeline V3

Mockups de referencia del sistema visual, en alta fidelidad (SVG vectorial,
no bocetos de baja fidelidad). Cada mockup usa los tokens reales de
`.pipeline/assets/design-tokens.css` y los iconos reales de
`.pipeline/assets/icons/sprite.svg`.

## Inventario

| Archivo                          | Resolucion | Contenido                                      |
|----------------------------------|------------|------------------------------------------------|
| `01-home-dashboard.svg`          | 1440x900   | Home con 3 lanes, header de identidad, KPIs, badges diferenciados rebote vs cross-phase |
| `02-issue-drilldown.svg`         | 1440x900   | Drilldown de issue individual: breadcrumb, KPIs, timeline vertical, panel voz narrando |
| `03-consumo.svg`                 | 1440x900   | Pagina `/consumo` (coordinada con #2520): KPIs, grafico de barras por fase, tabla top 5 |
| `04-rest-mode-active.svg`        | 1440x900   | Modo descanso ACTIVO (#2882): pill header indigo, banner explicativo, lanes con LLM en cola, bypass critical visible |
| `05-rest-mode-settings.svg`      | 1440x900   | Settings → Operación → Modo descanso: form (toggle, horarios, TZ, días), skills clasificados read-only, bypass labels, toast de confirmación |
| `06-cost-anomaly-alert.svg`      | 1440x900   | Banner persistente de alerta de consumo anómalo (#2882): pill +213%, mini-gráfico, top 3 skills, acuse + snooze, preview Telegram, audit trail |
| `15-commander-routing-metric.svg`| 1200x720   | Card "Commander Routing" del dashboard (#3257 CA-4): donut hoy + tendencia 7d + KPIs ahorro + sticker modo degradado |
| `16-continuidad-pulpo-card.svg`  | 1440x720   | Card "Continuidad del Pulpo" del dashboard (#3259 CA-6): pills por provider, barra apilada de despachos 24h, banner modo degradado |
| `16b-telegram-exhaustion.svg`    | 1080x940   | Formato Telegram de pausa por exhaustion (#3259 CA-8) + destrabe automatico (#3259 CA-10) |
| `17-multi-provider-health.svg`   | 1440x1180  | Seccion "Health" del tab Multi-Provider (#3260 CA-1..CA-6): banner cron + 4 cards por provider (verde/amarillo/rojo/muted) + feed Telegram con dedupe + KPIs + tabla free tier real |
| `24-multi-provider-coverage-widget.svg` | 1440x1180 | Widget "Coverage" del tab Multi-Provider (#3681 split de #3669): matriz skill × provider con 5 estados (PASS/WARN/FAIL/SKIPPED/N/A) + 5 buckets de latencia, banner de último run, banner de coordinación con `--rest-mode`, botón "Ejecutar harness" con guard, panel lateral de issues auto-creados, tooltip popover custom, leyenda permanente. **Nota de numeración:** el issue #3681 referencia el archivo como `23-...` pero ese slot ya está ocupado por `23-ghost-artifacts-widget.svg` (#3638) — UX asignó el siguiente número libre (24). |
| `25-wizard-providers-rotate.svg` | 1440x1340 | Wizard "Configurar / rotar proveedor" (#3740 split de #3715): 4 steps (seleccionar provider · elegir acción · input enmascarado con toggle press-to-view · confirmar con diff masking last4_old → last4_new) + reglas operativas + tabla de contrastes WCAG AA. Política `feedback_api-keys-terminal-only` enforced (sin opción "Crear nueva", banner inline terminal). |
| `27-equipo-panel-v3.svg`         | 1680x1500  | Ventana "Equipo" V3 (#3727 split de #3715): rail gradient cyan→purple→success, eq-head + active-strip con badge provider:model + eq-areas-grid 2×2 (Producto/Desarrollo/Calidad/Operaciones con persona-chips) + eq-svc-section 3 capas (Intake/Processing/Output, Opción A: Servicios viaja con Equipo, migra a Ops en #3732). Sidebar con tokens, tabla WCAG AA, reglas de seguridad CA-2/3/4 y mapa CA-Equipo-1..12 |
| `36-ops-topologia-v3.svg`        | 1440x900   | Ventana "Ops" V3 (#3960, EP8-H7): topología jerárquica pulpo→servicios con nodo caído resaltado (borde+ícono+texto), panel de detalle con log en vivo SSE (lazy-open) + historial de transiciones con causa (CA-1/CA-2) + botón "Restart (confirma + audita)" (CA-3), panel Reconciler con breakdown por motivo + sparkline 7d (CA-4), QA environment en pills compactas y leyenda de dual-encoding. Iconos nuevos: `ic-restart`, `ic-health-dead`, `ic-live-tail`, `ic-transition-history` |
| `narrativa-ops-topologia.md`     | —          | Guidelines UX + microcopy + tabla de iconografía + dual-encoding + tabla de contrastes WCAG AA + REQ-SEC visibles + mapa de CAs de la ventana Ops (#3960, mockup 36) — generar mp3 en fase `dev` |
| `narrativa-commander-routing.md` | —          | Script narrado del sistema visual del Commander determinístico (#3257) — generar mp3 en fase `dev` |
| `narrativa-continuidad-pulpo.md` | —          | Guidelines UX + tabla de contrastes + reglas de copy de los mensajes Telegram (#3259) |
| `narrativa-lili.md`              | —          | Script narrado del sistema visual base (mockups 01-03) |
| `narrativa-lili.mp3`             | 4m 42s     | Audio TTS de la narrativa base, voz `es-AR-ElenaNeural` |
| `narrativa-modo-descanso.md`     | —          | Script narrado del modo descanso (#2882, mockups 04-06) — generar mp3 en fase `dev` |
| `narrativa-multi-provider-health.md` | —      | Guidelines UX + microcopy + reglas inquebrantables del panel Health (#3260, mockup 17) |
| `narrativa-multi-provider-coverage.md` | —    | Guidelines UX + microcopy + tabla de iconografía + reglas inquebrantables del widget Coverage (#3681, mockup 24) — generar mp3 en fase `dev` |
| `narrativa-wizard-providers.md`  | —          | Guidelines UX + paleta por provider + reglas operativas + tabla de contrastes WCAG AA del wizard de providers (#3740, mockup 25) — generar mp3 en fase `dev` |
| `narrativa-equipo-panel-v3.md`   | —          | Guidelines UX + tabla de contrastes WCAG AA + microcopy + reglas de seguridad + mapa CA-Equipo-1..12 de la ventana Equipo (#3727, mockup 27) — generar mp3 en fase `dev` |

## Ver los mockups

Abrir con cualquier navegador web:

```bash
# macOS / Linux
open .pipeline/assets/mockups/01-home-dashboard.svg

# Windows (Git Bash)
start .pipeline/assets/mockups/01-home-dashboard.svg
```

Tambien se pueden convertir a PNG para compartir por Telegram o email:

```bash
rsvg-convert -w 1440 .pipeline/assets/mockups/01-home-dashboard.svg \
    > /tmp/dashboard-home.png
```

## Narracion

El MP3 se genero con `edge-tts` (gratis, voces neuronales). Para regenerar:

```bash
cd .pipeline/assets/mockups
python -m edge_tts \
    -v es-AR-ElenaNeural \
    --pitch=+10Hz \
    --rate=+0% \
    -f narrativa-lili.md \
    --write-media narrativa-lili.mp3
```

Esto **dogfoodea** el sistema TTS del issue #2518 (perfiles de voz por
agente).

## Video completo

El CA-14 pide ademas un video narrado mostrando el sistema. El video completo
—integrando los 3 mockups en secuencia sincronizado con la narracion— se
produce en fase `aprobacion` como evidencia de QA:

```bash
ffmpeg -loop 1 -t 95 -i 01.png \
       -loop 1 -t 85 -i 02.png \
       -loop 1 -t 102 -i 03.png \
       -i narrativa-lili.mp3 \
       -filter_complex "concat=n=3:v=1:a=0" \
       -c:v libx264 -pix_fmt yuv420p -c:a aac \
       .pipeline/logs/media/qa-2523.mp4
```

El comando exacto y tiempos finales los define el skill `qa` cuando graba
el video de evidencia.

## Actualizar un mockup

Si cambia la paleta o los iconos, estos mockups **deben re-generarse** para
reflejar el estado actual del sistema. Son documentacion viva, no
historia. Commitear la actualizacion junto con el cambio del token / icono.
