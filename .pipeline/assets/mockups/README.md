# Mockups del Pipeline V3

Mockups de referencia del sistema visual, en alta fidelidad (SVG vectorial,
no bocetos de baja fidelidad). Cada mockup usa los tokens reales de
`.pipeline/assets/design-tokens.css` y los iconos reales de
`.pipeline/assets/icons/sprite.svg`.

## Inventario

| Archivo                       | Resolucion | Contenido                                      |
|-------------------------------|------------|------------------------------------------------|
| `01-home-dashboard.svg`       | 1440x900   | Home con 3 lanes, header de identidad, KPIs, badges diferenciados rebote vs cross-phase |
| `02-issue-drilldown.svg`      | 1440x900   | Drilldown de issue individual: breadcrumb, KPIs, timeline vertical, panel voz narrando |
| `03-consumo.svg`              | 1440x900   | Pagina `/consumo` (coordinada con #2520): KPIs, grafico de barras por fase, tabla top 5 |
| `narrativa-lili.md`           | —          | Script narrado del sistema (texto que Lili dice)     |
| `narrativa-lili.mp3`          | 4m 42s     | Audio TTS generado con `es-AR-ElenaNeural` (perfil ux — Lili, pitch +10Hz) |

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
