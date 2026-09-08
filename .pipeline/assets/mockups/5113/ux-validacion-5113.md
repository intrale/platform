Re-ejecución por rebote de INFRA, no de contenido. Confirmado leyendo la pasada
anterior en procesado/5113.ux: rebote_tipo infra, motivo "[guru] Huérfano tras 3
reintentos — proceso muere repetidamente", agente_exit_code -1, rebote_categoria
infra_agent_crash, veredicto_sintetizado_por: pulpo. El pulpo sintetizó ese
rechazo; ux nunca emitió veredicto. No hay ningún hallazgo de UX cuestionado que
corregir. Aun así se re-verificó TODO empíricamente en esta pasada.

HEAD verificado en esta pasada: 0c1875873 (== origin/main).
Issue de infra pura: labels enhancement, Ready, area:infra, area:pipeline,
priority:high, size:grande — sin ningún app:*. Sin UI de usuario final; la
superficie de UX es el dashboard interno del equipo.

NOTA DE MÉTODO: git show "rev:path" se corrompe en Git Bash/Windows por
conversión de paths de MSYS y devuelve el texto del error por stdout, que parece
un archivo válido de 78 bytes. Todo lo de abajo se midió con MSYS_NO_PATHCONV=1.
La rama de assets se fijó en un ref propio (refs/ux5113-recheck) antes de medir,
porque FETCH_HEAD lo pisan los agentes concurrentes.

## 1. Assets de la fase criterios — PRESENTES

$ git ls-remote origin refs/heads/agent/5113-ux-assets
24e0f5dfcf69676ab33769de443723cd41e4374b

$ git ls-tree -r refs/ux5113-recheck -- .pipeline/assets/mockups/5113/
38b5f3508 blob  60-estado-operativo-procedencia.svg
ccaa63aa7 blob  ux-criterios-5113.md

Aún no están en origin/main (llegan con el PR del dev). Es el patrón vigente:
4731, 4778, 4800, 4806, 4900, 5708, 6146, 6173 y 6190 usan el mismo layout
.pipeline/assets/mockups/<issue>/ y ya están en main.

## 2. Merge que hará el dev — LIMPIO, SIN REGRESIÓN

La rama divergió de main, así que un `git diff origin/main <rama>` muestra falsos
"borrados". NO son borrados: es la rama estando atrás. Verificado con merge
three-way real, no con el diff:

$ git merge-tree --write-tree origin/main refs/ux5113-recheck
5c307582495442f0e1f9a5cde502e9080ca6c7ef   (exit 0, sin conflictos)

$ git diff --stat origin/main 5c30758
 .../5113/60-estado-operativo-procedencia.svg | 149 ++++++
 .pipeline/assets/mockups/5113/ux-criterios-5113.md | 150 +++++
 2 files changed, 299 insertions(+)
El merge aporta SOLO los 2 assets y CERO borrados.

$ git rev-parse "5c30758:.pipeline/pulpo.js"     -> 35256c5e06c45f502fbaa5d75ca361e68e7ec549
$ git rev-parse "origin/main:.pipeline/pulpo.js" -> 35256c5e06c45f502fbaa5d75ca361e68e7ec549
IDÉNTICOS -> el merge NO revierte el fix #7038.

$ git ls-tree -r --name-only 5c30758 | grep maxbuffer
.pipeline/lib/__tests__/gh-exec-maxbuffer-7013.test.js   (presente, igual que en main)

## 3. Mockup 60 — real, no placeholder

149 líneas, 4 secciones: chip de procedencia en 4 estados, banner de no-despacho
hoy-vs-esperado, ubicación en el header junto al modo de ola, y tabla de mapeo
cerrado condición-chip-alerta.

PALETA — 14/14 colores dentro del sistema, cero hardcodeados fuera de tokens:
$ for c in $(grep -oiE '#[0-9a-f]{6}' mockup60.svg | sort -u); do
    grep -qi "$c" design-tokens.css || echo "FUERA: $c"; done
colores unicos=14 fuera=0

REGLA 1 (ningún estado codificado sólo por color) — CUMPLIDA:
$ grep -oE '(#|OK|~|!)\s*(filesystem|externo|cutover)[^<]*' mockup60.svg
# filesystem local · OK externo - en linea · ~ cutover en curso · ! externo - sin respuesta
Cuatro símbolos distintos + etiqueta textual por estado.

## 4. Contraste (regla 5) — recalculado de forma independiente

Recomputé WCAG 2.x (relative luminance + compositing de los rgba 0.14 sobre
--surface-1), sin confiar en la tabla del guideline:

  --text-primary   #E6EDF3  14.64 opaco / 12.46 sobre danger-bg   AA
  --text-secondary #B1BAC4   8.81 opaco /  7.49 sobre danger-bg   AA
  --text-dim       #8B949E   5.62 opaco                            AA
  --success        #3FB950   6.81 opaco /  5.44 sobre success-bg   AA
  --warning        #D29922   6.85 opaco /  5.46 sobre warning-bg   AA
  --danger         #F85149   4.83 (peor opaco, vs --surface-2)     AA
  --danger sobre --danger-bg compuesto = 4.39                      < AA

El guideline declara ese sub-AA explícitamente en vez de esconderlo, y la
mitigación se verifica en el propio SVG: en el chip crítico la etiqueta NO va en
rojo.

$ sed -n '66,72p' mockup60.svg
rect fill="rgba(248,81,73,0.14)" stroke="#8B1A14"
text fill="#F85149" ... >!<                                <- el rojo es el símbolo
text fill="#E6EDF3" ... >Estado: externo - sin respuesta<  <- la etiqueta, 12.46:1

Donde el rojo SÍ lleva texto ("dispatch DENEGADO - no degrada a FS") el fondo es
el rect padre #161B22 opaco -> 5.16:1, AA.

El par --danger sobre fondo rojo tintado es el patrón vigente del tablero, no una
desviación de este mockup:
$ git show "origin/main:.pipeline/dashboard.js" | grep -oEc "rgba\(248,\s*81,\s*73,\s*0\.1"  ->  33
Divergir sólo acá produciría un badge de peligro distinto a los otros 33. La
recalibración de la familia es #6523, verificada OPEN en esta pasada
("[ux] Recalibrar la familia --danger y los sufijos -dim de design-tokens.css
para cumplir WCAG AA", labels tipo:recomendacion + needs:triage-backlog).
No se duplica.

Corrección de contraste del commit 3c6f4e500 aplicada de verdad:
$ grep -oic "6E7681" mockup60.svg  ->  0
(--text-disabled, 3.77:1, eliminado del mockup)

## 5. CA-UX1..UX5 revalidados contra el main ACTUAL

CA-UX1 (la procedencia no existe hoy en la interfaz):
$ git show "origin/main:.pipeline/dashboard.js" | grep -ncE "durable|operational_state|namespaced" -> 0
$ git show "origin/main:.pipeline/lib/dashboard-slices.js" | grep -ncE "durable|kernelMode|operational_state|namespaced" -> 0

CA-UX2 (el enum cerrado no tiene causa para "el store no responde"):
CAUSAS_ALERTABLES de dispatch-cause.js = HALT_HUMANO, CB_INFRA, PRESION_RECURSOS,
DISCO_LLENO, BLOQUEO_DEPENDENCIA, DEADLOCK. No incluye MODO_OLA ni SIN_AGENTES,
así que mapear ahí la degradación seguiría siendo silencioso: el CA se sostiene.

CA-UX3 (el canal de alerta a reusar existe):
$ git cat-file -s "origin/main:.pipeline/lib/kernel-degradation-alert.js" -> 21115  OK

Regla 4 (iconografía propia disponible):
$ git cat-file -s "origin/main:.pipeline/assets/icons/sprite.svg" -> 92469
$ git cat-file -s "origin/main:.pipeline/assets/design-tokens.css" -> 28729

## 6. Recomendaciones

Ninguna nueva. La única deuda de UX detectada ya está registrada y abierta
(#6523, mide exactamente el par --danger sobre --danger-bg en 4,39:1).
Duplicarla sería ruido. Tope de 3 respetado.
