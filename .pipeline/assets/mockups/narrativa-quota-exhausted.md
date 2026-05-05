# Narrativa UX — Modo determinístico por cuota Anthropic agotada (#2955)

> Brief de copy + script de TTS Lili (`edge-tts es-AR`) para el feature de
> degradación a modo determinístico cuando se acaba la cuota de Anthropic.
>
> **Importante**: este documento es la fuente de verdad para los textos de
> Telegram, dashboard y narrativa. La implementación (pipeline-dev) debe
> consumir estos copies tal cual están — cualquier desvío rompe la voz de
> Intrale (memoria `feedback_telegram-messages-natural`).

---

## 1. Filosofía del copy

**Tono**: directo, informativo, sin alarmismo. El pipeline NO está caído —
está degradado a un modo intencional de operación. El mensaje debe transmitir
calma técnica, no urgencia. Vocabulario claro, sin jerga técnica innecesaria.

**Voz**: Lili (asistente Intrale), tratamiento informal argentino. Coherente
con la voz ya establecida en `narrativa-modo-descanso.md` (#2882).

**Variación**: los recordatorios cada 2h tienen 4 variantes distintas para
no sonar robóticos (memoria `feedback_telegram-messages-natural`). El sistema
rota en orden FIFO; al llegar al final, vuelve al principio.

**Restricciones de seguridad**:
- CA-S7: prohibido interpolar input del usuario en cualquier mensaje.
- CA-S3: todo mensaje pasa por `lib/redact.js` antes de enviarse.
- Solo se interpolan campos generados por el sistema: `HH:MM`, `X h Y min`,
  `N agentes`. Nada que provenga del stderr crudo del CLI ni de mensajes de
  Leo.

---

## 2. Mensaje inmediato al detectar agotamiento

**Trigger**: el detector matchea `error_type ∈ { usage_limit_error,
weekly_quota_exhausted }` y setea el flag por primera vez.

**Una sola variante** (es un evento singular, no se repite):

```
Cuota Anthropic agotada.
Pipeline en modo deterministico. Reset estimado: HH:MM (en X h Y min).
```

**Notas**:
- Frase corta, prosa directa, sin emojis (consistente con el tono operativo
  del pipeline V3).
- El countdown se calcula en el momento del envío.
- Si `resets_at` cayó al fallback (`getNextWeeklyResetMs()`), se reemplaza
  el formateo: `"Reset estimado: proximo reset semanal (en X h)"` para no
  mentir con un horario preciso que se calculó como aproximación.

---

## 3. Recordatorio periódico (cada 2h por default, configurable en `config.yaml`)

**Trigger**: `setInterval` registrado al setear el flag, cancelado al borrarlo.

**4 variantes** rotando FIFO. La idea es comunicar siempre el mismo dato
(countdown + estado) variando la forma para no sonar como spam:

### Variante A — operacional
```
Cuota sigue agotada.
Faltan X h Y min para el reset (HH:MM).
Pipeline deterministico: N skills procesando.
```

### Variante B — informativa
```
Recordatorio: pipeline en modo deterministico.
Reset al volver la cuota: HH:MM (en X h Y min).
N archivos LLM esperando en cola.
```

### Variante C — corta
```
Cuota Anthropic: X h Y min para el reset (HH:MM).
Determinisicos siguen avanzando.
```

### Variante D — con hint a comandos
```
Pipeline aun en modo deterministico (reset HH:MM, en X h Y min).
Si necesitas estado: /status, /dashboard, /metrics.
```

**Reglas de rotación**:
- La primera variante usada es la **A** (más informativa, da contexto numérico).
- El siguiente recordatorio usa **B**, después **C**, después **D**, después vuelve a **A**.
- El estado de rotación vive en memoria del proceso del pulpo (no se persiste).
- Si el flag se borra antes del recordatorio siguiente, el `setInterval` se
  cancela y el contador se reinicia para el próximo bloqueo.

---

## 4. Respuesta canned a texto libre del commander

**Trigger**: con flag activo, Leo manda un mensaje de texto libre al bot
(no comando `/...`). El listener detecta que es texto libre y, antes de
spawnear `claude.exe`, chequea el flag y rutea acá.

**Una variante fija** (CA-S7: prohibido cualquier echo del input):

```
Cuota Anthropic agotada hasta las HH:MM.
Pipeline operando en modo deterministico.
Comandos disponibles: /status /metrics /dashboard /intake /pause /ghostbusters /restart /limpiar.
```

**Notas**:
- El texto del usuario NO se cita ni se incluye. Solo se loguea para
  auditoría con redacción.
- El mensaje es texto plano fijo, sin Markdown que pueda interpretar
  caracteres del input por accidente.
- Si Leo pega varios mensajes seguidos en menos de 2 minutos, el bot
  responde **solo al primero** (debounce). Los siguientes se loguean pero
  no generan nueva respuesta canned (anti-spam-self).

---

## 5. Mensaje de cuota restaurada

**Trigger**: el flag se borra (por `now > resets_at` O por respuesta exitosa
del CLI tras intentar de nuevo).

**Una sola variante**:

```
Cuota Anthropic restaurada.
Drenando cola de N agentes encolados.
Pipeline volviendo a operacion full.
```

**Notas**:
- Si `N = 0` (no había nada en cola), el segundo renglón cambia a:
  `"No habia agentes encolados — pipeline directo a operacion full."`.
- No se manda este mensaje si el reset duró menos de 5 minutos (falso
  positivo de detección — evitar ruido al usuario).

---

## 6. Banner del dashboard

**Texto principal** (línea 1, 17px bold):
```
Cuota Anthropic agotada — pipeline en modo deterministico hasta el reset
```

**Subtexto** (línea 2, 13px ámbar):
```
Reset estimado: HH:MM (en {countdown}) · Detectado: HH:MM:SS · Patron: {error_type}
```

**Detalle** (línea 3, 12px gris):
```
Skills determinisicos siguen procesando: builder, linter, tester, delivery
Skills LLM encolados: {N} archivos en pendiente/.
```

**Pie** (línea 4, 11px gris itálica):
```
Auto-drenado al volver la cuota — sin intervencion manual.
Comandos /status, /metrics, /dashboard, /intake, /pause, /ghostbusters siguen respondiendo.
```

**Mini countdown** (recuadro a la derecha):
- Número grande: `H:MM:SS` en mono ámbar (#FFE5A8)
- Etiqueta: `HH:MM:SS` en gris arriba
- Barra de progreso: % del wait transcurrido

---

## 7. Pill del header

**Estado activo**:
```
[icono reloj de arena] MODO DETERMINISTICO · RESET HH:MM ({countdown})
```

**Reglas**:
- Color: `--quota-degraded` (#F0A500) sobre `--quota-degraded-bg`.
- Click → scroll al banner persistente (igual que cost-anomaly).
- Cuando el flag se borra, la pill desaparece sin reload manual.

---

## 8. Script de narración TTS (Lili)

> Para `edge-tts es-AR-ElenaNeural` (la voz default de Lili). Usado para
> generar `narrativa-quota-exhausted.mp3` que acompaña la documentación
> del feature en el repo y los reportes de status post-feature.

```text
[Pausa breve]

Cuando la cuota de Anthropic se agota, el pipeline V3 no se cae. Se degrada.

Los skills deterministicos — builder, linter, tester, delivery — siguen
trabajando porque no necesitan tokens. El reconciler sigue moviendo
archivos entre fases. El dashboard sigue respondiendo. Los reportes PDF
siguen llegando con su audio narrado.

Lo que se pausa son los skills que necesitan al modelo: po, guru,
android-dev, backend-dev, web-dev, qa, review. Esos quedan en cola, sin
spawnearse, hasta que vuelva la cuota.

Vos te enteras enseguida: aviso por Telegram con el horario estimado del
reset, recordatorio cada dos horas con countdown, y banner amarillo en el
dashboard que se actualiza solo. Cuando la cuota vuelve, drena la cola
sola, sin intervencion manual.

Texto libre al commander recibe respuesta fija con la lista de comandos
disponibles. Comandos como status, metrics o dashboard siguen funcionando
porque son determinisicos.

Pipeline sigue vivo. Solo cambia el modo.
```

**Duración estimada**: ~58 segundos a velocidad neutral.

**Generación**:
```bash
cd C:/Workspaces/Intrale/platform
node .pipeline/scripts/edge-tts-render.js \
  --text-file .pipeline/assets/mockups/narrativa-quota-exhausted.md \
  --section 8 \
  --voice es-AR-ElenaNeural \
  --rate 0 --pitch 0 \
  --output .pipeline/assets/mockups/narrativa-quota-exhausted.mp3
```

> Nota: el MP3 lo genera el pipeline-dev al implementar, NO el UX. Esta
> sección es la fuente del texto a vocalizar.

---

## 9. Tabla resumen para implementación

| Caso | Trigger | Texto | Variantes |
|------|---------|-------|-----------|
| Inicial | flag se setea | Sección 2 | 1 fija |
| Recordatorio | cada 2h con flag activo | Sección 3 (A→B→C→D→A) | 4 rotando |
| Texto libre | mensaje no-comando con flag activo | Sección 4 | 1 fija |
| Restaurada | flag se borra (excepto si <5min) | Sección 5 | 1 fija (con/sin cola) |
| Banner | flag activo, render dashboard | Sección 6 | 1 fija (countdown live) |
| Pill | flag activo, render header | Sección 7 | 1 fija (countdown live) |

---

## 10. Verificación de copy (checklist UX para revisión post-implementación)

- [ ] Mensaje inicial llega ≤30s después del primer match del detector.
- [ ] Recordatorios respetan rotación A→B→C→D→A (no repiten variante seguida).
- [ ] Respuesta canned NO incluye eco del input del usuario (CA-S7).
- [ ] Mensaje restaurada NO se envía si el bloqueo duró <5 min.
- [ ] Mensaje restaurada con `N=0` usa la variante alternativa (sin cola).
- [ ] Banner del dashboard tiene countdown que se actualiza en cada refresh
      (no requiere websocket — reload natural alcanza).
- [ ] Pill del header desaparece sin reload manual al borrarse el flag.
- [ ] Todos los mensajes pasan por `lib/redact.js` antes de enviarse.
- [ ] Si `resets_at` cayó al fallback, el copy se ajusta para no mentir un
      horario preciso (sección 2 nota final).
