VALIDACION UX (fase validacion, pipeline desarrollo) — #6564 "Verificar que Gemini corre
con el plan pago y no en modo gratuito". REVISION 2 (16/09/2026): rebote cross-phase de
guru (validacion) -> PO (definicion/criterios) aceptado. El PO reacoto el issue a la
opcion A ("sesion + cuota efectiva medida", 6 CAs, 4 Gherkin, "Fuera de alcance" explicito)
y dejo instruccion directa para UX: quitar "PLAN GRATUITO · ESPERADO PAGO" del mockup y
renombrar "PLAN PAGO · VERIFICADO" -> "PLAN CON CUOTA · N% semanal". Este archivo y el
mockup reemplazan a la revision 1 (misma ruta, politica "ultimo write por skill").

## 0. Verificacion del rechazo (esta pasada, HEAD = origin/main = 009fcf5e1, agy 1.2.4)

$ git rev-parse --short HEAD ; git rev-parse --short origin/main     -> 009fcf5e1 / 009fcf5e1
$ grep -n "gemini-google" .pipeline/views/dashboard/providers.js
  102: 'gemini-google': { name:'Gemini', ..., tier:'FREE', tierKind:'free', tierIcon:'🟩', ... }
  -> CONFIRMADO: badge de tier ESTATICO (claim "falta corregir el badge tier:'FREE'").
$ agy --version -> 1.2.4 ; agy --help | grep -iE "login|status|whoami|account|plan|tier|usage"
  -> solo "--mode (accept-edits, plan)" y "remote-control (start, status, stop)". CONFIRMADO: sin subcomando de cuenta.
$ agy models | wc -l -> 14 ; rc=0                                    -> CONFIRMADO: sesion activa en keyring (CA-1).
$ MSYS_NO_PATHCONV=1 agy -p "/usage" --output-format json            -> rc=0
  {"conversation_id":"","status":"SUCCESS","num_turns":0,"usage":{"total_tokens":0,...},
   "command":{"name":"usage","data":{"description":"... your weekly limit is tied directly to your individual tier.",
     "groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-weekly","window":"weekly","remaining_fraction":0.9935333132743835,"reset_time":"2026-09-23T16:14:00Z"},
                                                   {"id":"gemini-5h","window":"5h","remaining_fraction":1,"reset_time":"2026-09-17T02:14:00Z"}]},
               {"name":"Claude and GPT models","buckets":[{"id":"3p-weekly","window":"weekly","remaining_fraction":1,"reset_time":"2026-09-23T21:47:05Z"},
                                                           {"id":"3p-5h","window":"5h","remaining_fraction":1,"reset_time":"2026-09-17T02:47:05Z"}]}]}}}
  -> CONFIRMADO: cuota si (fracciones numericas por grupo/ventana), tier NO (solo "your individual tier" sin nombrarlo).
     0 tokens de generacion => probe viable a la cadencia del health-cron. Trae `conversation_id` y un `response`
     tabulado en texto libre: NO se persisten (CA-5), solo fracciones/reset_time/ids de la tabla cerrada.
Veredicto sobre el rechazo: los claims de guru siguen siendo ciertos; el reacote del PO es coherente con lo
observado. Rev. 1 de UX prometia un verde "PLAN PAGO · VERIFICADO" y un rojo "PLAN GRATUITO" que NO se pueden
medir -> esa era la parte de mi entregable que habia que corregir. Corregida abajo.

## 1. Clasificacion de scope — infra pura, sin video

$ gh issue view 6564 --json labels -> ["enhancement","Ready","tipo:infra","area:infra","priority:high","size:medium"]
Sin ningun app:*. Usuario real: el operador leyendo /providers del dashboard y las alertas de
Multi-Provider Health en Telegram. Impacto visual: SI (CA-3 alerta que nombra el problema; CA-4 badge medido
con texto). Por eso hay mockup y no solo guideline. En aprobacion aplica PASO 2-bis (QA structural).

## 2. Sistema visual — eje PLAN (nuevo, medido) vs eje SALUD (existente, no se toca)

Mockup: .pipeline/assets/mockups/6564/providers-gemini-plan-states.svg (+ .png render Chrome headless).
Tokens: design-tokens.css (success/info/danger + provider-gemini). Iconos del sprite propio:
ic-ok / ic-info / ic-cell-na / ic-bad / ic-key / ic-provider-gemini. Sin emojis del SO en el badge medido.

| reason_code (CA-2)        | Badge junto al nombre (texto)    | Severidad | Linea dim bajo el badge                          | Salud (badge existente)          |
|---------------------------|----------------------------------|-----------|--------------------------------------------------|----------------------------------|
| plan_quota_ok (nuevo)     | PLAN CON CUOTA · N% SEMANAL      | ok verde  | cuota del plan verificada · hace N min           | la que corresponda (SANO)        |
| plan_tier_unknown (nuevo) | PLAN · SIN VERIFICAR             | info azul | cuota del plan sin verificar · k.º tick · hace N min | la que corresponda (SANO)    |
| cli_license_unavailable   | PLAN · NO VERIFICABLE            | neutro    | sin sesion, no se puede medir la cuota           | SIN LICENCIA (rojo, #6857)       |

N = round(remaining_fraction * 100) del bucket `gemini-weekly` (grupo "Gemini Models"), entero, sin decimales.
Con 0.9935 se muestra "99%", no "99,35%": el badge es una senal, el detalle va al tooltip.

Reglas (obligatorias para dev, verificables en aprobacion):
R1. Un solo verde posible: "PLAN CON CUOTA · N% SEMANAL", y SOLO con medicion fresca (<= 2xTTL, misma regla
    CLI_PROBE_STALE_MS de healthBadgeFor en #6857), num_turns === 0, total_tokens === 0 y los DOS grupos
    presentes con bucket semanal numerico. Cualquier otra cosa con sesion activa => "PLAN · SIN VERIFICAR".
    Snapshot viejo (> 2xTTL) => SIN VERIFICAR, nunca verde por inercia. Fail-closed.
R2. NUNCA se afirma el tier: ni "PAGO" ni "GRATUITO" aparecen en el badge, tooltip, linea de causa ni
    Telegram para gemini-google. `plan_tier_free` no existe en el codigo (regla dura del PO).
R3. La distincion entre estados va por TEXTO del badge, no solo por color (WCAG 1.4.1).
    Tooltip (title) del badge, CA-4 "ambos grupos y antiguedad":
      plan_quota_ok:     "Cuota efectiva medida por la comprobacion automatica · hace 12 min
                          Gemini Models · semanal 99 % · 5 h 100 % · reinicia 23/09 16:14 UTC
                          Claude y GPT · semanal 100 % · 5 h 100 % · reinicia 23/09 21:47 UTC
                          El tier contratado no es observable con agy 1.2.4: confirmalo a mano (docs/pipeline/multi-provider.md)."
      plan_tier_unknown: "Cuota del plan sin verificar desde hace 47 min · hasta confirmarla no se la cuenta como plan contratado"
      sin sesion:        "Sin sesion: no se puede medir la cuota del plan"
    Solo numeros, reset_time y nombres de grupo de la tabla cerrada. Nada de email, conversation_id ni texto libre del CLI.
R4. Un solo rojo por fila. Sin sesion: el rojo lo pone la salud (SIN LICENCIA, ya existe); el badge de plan
    queda neutro "NO VERIFICABLE" y NO se emite una segunda alerta (CA-3, Gherkin 2).
R5. Sin verificar NO degrada la salud. El eje SALUD sigue reportando lo que midio el round-trip de catalogo
    (SANO si `agy models` respondio). Igual que el eje "modelo" de #5888: ejes independientes, el estado del
    proveedor viaja en la alerta solo para que el texto pueda decir "sigue SANO" sin mentir.
R6. La regla dinamica aplica solo a gemini-google. Codex conserva PAGO estatico; Cerebras/NVIDIA NIM conservan
    FREE estatico. No inventar mediciones (CA-4).
R7. Invariante #5888: plan_quota_ok y plan_tier_unknown entran en las TRES tablas — ALLOWED_REASON_CODES
    (health-alerts.js), REASON_LABEL (providers.js, sin '_' en la etiqueta) y REASON_TABLE + ACTION_SHORT /
    ACTION_FULL (provider-pause-cause.js). El test de invariante lo exige.

REASON_LABEL (providers.js):
  plan_quota_ok:     'cuota del plan verificada'
  plan_tier_unknown: 'cuota del plan sin verificar'

REASON_TABLE (provider-pause-cause.js) — mismo criterio que cli_catalog_ok / model_check_unavailable:
  plan_quota_ok:     { text: () => 'disponible', cause: CAUSE_DISPONIBLE }
  plan_tier_unknown: { text: () => 'con la cuota del plan sin verificar', cause: CAUSE_TRANSITORIA }
    (CAUSE_TRANSITORIA y no CAUSE_AUTH: el proveedor sigue sirviendo; CAUSE_AUTH encabezaria el mensaje como
     si estuviera inutilizable, y eso es exactamente lo que #5888 evito para model_check_unavailable.)
ACTION_SHORT:  plan_tier_unknown: 'con la cuota del plan sin verificar'
ACTION_FULL:   plan_tier_unknown: (l) => `${l} no pudo verificar la cuota del plan. Hasta confirmarlo no se lo cuenta como plan contratado.`
  (plan_quota_ok es verde: no entra en ACTION_* igual que cli_catalog_ok no entra.)

## 3. Copy de Telegram (CA-3, falla ruidosa)

Rama PROPIA del eje plan en health-cron.js (antes de la generica), espejo exacto de la rama
`model_not_in_catalog` de #5888 UX-5/CA-17: la generica elegiria el emoji por el estado del PROVIDER y con
provider sano saldria "🟢 gemini-google → GREEN", que en un canal que se escanea por emoji significa "ignorar".

  ⚠️ *Plan sin verificar* — `gemini-google` sigue 🟢 SANO, pero Gemini (Antigravity CLI) no pudo verificar
  la cuota del plan. Hasta confirmarlo no se lo cuenta como plan contratado. Revisá la sesión de agy o
  confirmá el plan a mano.
  (`plan_tier_unknown` x2) · Observado: 2026-09-16T22:19:21Z

Politica de ruido (CA-3):
- plan_tier_unknown: 1.er tick solo dashboard; alerta recien al 2.º tick CONSECUTIVO; dedupe propio de 24h
  (key `provider|plan`, como `provider|model|<id>` de #5888, para no colisionar con `provider|<state>` del eje
  salud ni con su back-off exponencial).
- Sin sesion: ya alerta cli_license_unavailable (#6857). NO agregar un segundo mensaje de plan en el mismo tick.
- plan_quota_ok: nunca alerta. Recuperacion de SIN VERIFICAR -> CON CUOTA: sin mensaje (el canal es para lo que
  hay que atender; la recuperacion se ve en el dashboard).
- Proteccion de cuota (CA-2): si una medicion devolvio num_turns > 0, se clasifica plan_tier_unknown y NO se
  reintenta dentro del TTL. El texto de la alerta es el mismo; la causa fina va al tooltip/linea dim
  ("medicion descartada: disparo un turno real").

## 4. CA-5 — nada de credenciales ni identidad

- Snapshot: solo `remaining_fraction`, `reset_time`, `window`, ids de bucket/grupo tomados de una tabla cerrada
  ({gemini-weekly, gemini-5h, 3p-weekly, 3p-5h} / {"Gemini Models","Claude and GPT models"}) y timestamp.
  NO persistir `conversation_id`, `response` (texto libre tabulado) ni `description`.
- Telegram y dashboard: nunca email, token, quotaProject ni conversation_id. El mensaje nombra provider + estado.
- Verificacion que pide el PO: `grep -E "@|token|conversation_id" state/agy-*.json logs/*.log` sin matches del probe.

## 5. Fuera de alcance (trazabilidad de la rev. 1)

Eliminado del mockup y de estas guidelines: estado "PLAN GRATUITO · ESPERADO PAGO" (rojo, plan_tier_free) y
su alerta Telegram; badge "PLAN PAGO · VERIFICADO". Motivo: no hay oraculo del tier con agy 1.2.4 (verificado
en §0). Queda como recomendacion de triaje humano si Google expone `agy whoami` no interactivo (#7309 del PO).

## 6. Verificacion que UX pedira en aprobacion (PASO 2-bis, sin video por scope infra)

- grep -n "PLAN CON CUOTA\|SIN VERIFICAR\|NO VERIFICABLE" .pipeline/views/dashboard/providers.js -> los 3 labels.
- grep -c "PLAN PAGO\|PLAN GRATUITO\|plan_tier_free" en providers.js / health-alerts.js / provider-pause-cause.js
  / health-cron.js -> 0 (regla dura R2).
- Render SSR de /providers con snapshot sintetico en los 3 estados (test como "el render SSR contiene los tres
  labels" de #6857) + "99% SEMANAL" con remaining_fraction 0.9935.
- Test de invariante #5888 en verde con plan_quota_ok y plan_tier_unknown.
- El badge medido de gemini-google no contiene 🟩/🟧/🟦/🟨 (sin emoji del SO).
- Alerta sintetica de plan_tier_unknown: cabecera "⚠️ *Plan sin verificar*", contiene "sigue", sin '@', sin
  'token', sin 'conversation_id'; se emite recien al 2.º tick y no se repite dentro de 24h.
- docs/pipeline/multi-provider.md (CA-6): seccion con (a) tier no observable, (b) procedimiento manual del header
  de agy, (c) trampa MSYS_NO_PATHCONV=1 en Git Bash.

Recomendaciones pendientes de aprobacion humana: #7305, #7306 (rev. 1, siguen vigentes); #7309 (PO). Sin
recomendaciones nuevas en esta pasada.
