# Evaluación de permanencia de los proveedores gratuitos de la cadena — #6145

> **Documento de decisión.** Registra qué se midió, con qué evidencia y qué se decide
> hacer con cada proveedor de la cadena multi-provider. El *flip* de configuración es
> un paso posterior y trazable: este documento **no** da de baja a nadie.
>
> Registro de auditoría append-only asociado: `.pipeline/audit/provider-permanence.jsonl`
> (entrada `provider_permanence_evaluated`, `executed_action: none`).

> **rev-2 (rebote de `aprobacion`).** Los números de este documento fueron **regenerados
> por completo** respecto de rev-1, porque la revisión encontró tres defectos que los
> afectaban: (a) el gateo por una causa nuestra de observabilidad entraba al denominador y
> deprimía artificialmente la tasa de Gemini; (b) la columna rotulada *"latencia mediana"*
> era en realidad un ping puntual y volátil, y una recomendación se apoyaba en él; (c) 261
> eventos quedaban fuera del total sobre el que se calculaban los porcentajes. Los tres
> están corregidos, y el cambio (a) mueve la tasa de Gemini de 7,6 % a **93,1 %**. Ver §11.

---

## 1. Conclusión

**No se da de baja a ningún proveedor.**

1. **No se propone dar de baja a ningún proveedor en esta ventana.** La premisa que abrió
   el issue — *"varios gratuitos permanentemente secos"* — no se sostiene con los datos.
2. **Gemini figura rojo en el panel por un flag de entorno nuestro, y es el proveedor con
   la mejor tasa de aporte de la cadena declarada**: 201 dispatches ganados sobre 216
   intentos que le son imputables (**93,1 %**), el 96 % de ellos conversacionales. Se
   **recupera**, no se baja. Seguimiento: **#6225**.
3. **Cerebras y NVIDIA aportan de forma sostenida y sin un solo gateo por salud**
   (27,2 % y 63,1 % de tasa respectivamente).
4. **`kimi-moonshot` participa del dispatch pero no está declarado en `config.yaml`**:
   queda **sin evaluar** hasta que se reconcilie (#6153). No se decide sobre él.
5. **La mitad del costo de failover es política horaria, no proveedores muertos.**
   Atribuirlo a los gratuitos sería vender un número falso al operador.

**El hallazgo que cambia la pregunta:** los gratuitos no le quitan carga al proveedor
pago — recogen trabajo que la cadena paga **ya rechazó**. Darlos de baja no alivia al
pago: convierte esos dispatches en `chain_exhausted` (ver §5).

---

## 2. Qué se midió y con qué

| | |
|---|---|
| **Ventana** | 2026-07-22 → 2026-08-21 (30 días) |
| **Fuente** | `.pipeline/logs/cross-provider-dispatch-*.jsonl` (append-only con hash-chain) |
| **Archivos** | 31 archivos diarios |
| **Eventos leídos** | 106.614 |
| **Integridad** | `hash-chain: OK` — los 31 archivos verifican con `audit-log.verifyChain` |
| **Comando** | `node .pipeline/scripts/provider-contribution-report.js --dias=30 --hasta=2026-08-21` |

> **El `--hasta` es parte del comando, no un adorno.** Sin él, `--dias=30` toma la ventana
> que termina *hoy*: otra ventana, otros números. Cualquier intento de reproducir esta
> tabla debe fijar el fin de ventana. El propio CLI lo emite ya armado en la línea
> `Regenerar:` de su salida.

### Por qué esta fuente y no `activity-log.jsonl`

`.claude/activity-log.jsonl` sólo registra `provider` en `session:start` / `session:end`:
mide **sesiones de agente ya arrancado**, no intentos de proveedor. Medir con esa fuente
daría **cero** para `gemini-google`, `cerebras` y `nvidia-nim` — los tres que más
despachan — y el criterio los daría de baja justo por aportar. Hay un test que falla si
el módulo llega a importarla (`el modulo no lee activity-log.jsonl`).

### Cómo se cuenta

- **Aporte real** = evento `fallback_selected`. Es la única señal de que el proveedor
  efectivamente resolvió un pedido.
- **Denominador** = `intentos − causas nuestras`. Se descuentan tres, porque las tres
  miden una política o un bug propio y no al proveedor:

  | Descuento | Eventos | Por qué no cuenta |
  |---|---|---|
  | Ventana horaria | `primary_inactive_by_schedule`, `fallback_also_gated`, `fallback_provider_inactive_by_schedule` | Es el **51,1 %** del total. Mide el horario que nosotros configuramos. |
  | Kill-switch del operador | `provider_disabled` | Es una decisión operativa nuestra (#3811). |
  | Observabilidad local | `fallback_health_gated` con causa de la familia `observabilidad_local` (p. ej. `cli_license_unavailable`) | El rojo lo produce un flag de entorno **nuestro**, sin round-trip al proveedor. |

  El tercer descuento es la corrección más importante de rev-2: el body del issue lo pedía
  explícitamente (*"un gateo durable por observabilidad NO baja la tasa de aporte"*) pero
  rev-1 lo dejaba dentro del denominador y sólo lo compensaba a nivel de veredicto. Con
  3.658 gateos de causa local, la tasa de Gemini salía 7,6 % en vez de 93,1 %.
- **Bloqueo dominante** se clasifica en familias que no se mezclan: `cupo`
  (recuperable por diseño), `observabilidad local` (bug nuestro, jamás imputable al
  proveedor) y `credencial`.
- **Taxonomía cerrada y reconciliada.** Todo evento del log cae en una familia, y lo que
  no encaje en ninguna aparece en un bucket `fuera de taxonomía` visible. El total sobre
  el que se calculan los porcentajes es **exactamente** el de entradas leídas: sin huecos.

---

## 3. Aporte real por proveedor (CA-1)

| Proveedor | Intentos evaluables | Aportes | Tasa | Último live-ping (no es mediana) | Bloqueo dominante | Último aporte | Rol (conversacional / pipeline) | Recomendación |
|---|---:|---:|---:|---|---|---|---|---|
| openai-codex | 13.526 | 2.007 | 14,8 % | sin instrumentar (#6152) | cupo | 2026-08-21 23:14 | 25 % / 75 % | mantener |
| cerebras | 2.803 | 763 | 27,2 % | 258 ms | cupo | 2026-08-21 23:15 | 61 % / 39 % | mantener |
| nvidia-nim | 583 | 368 | 63,1 % | 2,0 s | cupo | 2026-08-21 23:15 | 81 % / 19 % | mantener |
| gemini-google | 216 | 201 | 93,1 % | sin instrumentar (#6152) | observabilidad local (`cli_license_unavailable`) | 2026-08-21 23:01 | 96 % / 4 % | mantener |
| kimi-moonshot | 87 | 87 | 100,0 % | sin instrumentar (#6152) | sin muestra | 2026-08-21 00:01 | 0 % / 100 % | sin declarar (#6153) |
| anthropic | 0 | 0 | sin muestra | sin instrumentar (#6152) | sin muestra | sin muestra | sin muestra | mantener |

**La columna de latencia no es una mediana, y por eso no se llama así.** CA-1 pide
*"latencia mediana sobre una ventana de al menos 30 días"*. **Ese dato no existe hoy**: el
log de dispatch no registra latencia por invocación, y la única fuente disponible
(`state/multi-provider-health.json`) guarda el resultado de **un** live-ping puntual. Es
volátil: tres observaciones del mismo proveedor (`nvidia-nim`) el mismo día dieron
**15,9 s → 2,3 s → 1,26 s**. Se reporta lo que hay, con su nombre real, y se declara el
gap: **CA-1 queda parcialmente abierto** hasta instrumentar latencia por invocación
(**#6152**). No se estima el número, y **ninguna recomendación de §6 se apoya en él**.

**Cómo leer las celdas que no traen número.** Ninguna ausencia se escribe como `—`:
cada una declara su causa.

- `sin instrumentar (#6152)` — el proveedor autentica por CLI-OAuth y **no hay round-trip
  medido**. Derivarlo del `duration_ms` del activity-log sería inventarlo (ese valor es
  wall-clock del agente, p50 ≈ 602 s).
- `sin muestra` — no hubo eventos evaluables. **No** equivale a "no aporta".
- `sin declarar (#6153)` — despacha pero falta en la configuración operativa.

**Por qué `anthropic` no tiene números.** Es el proveedor **primario** de todos los skills
LLM. Sí genera intentos en el log — 29.539 en la ventana de rev-1 — pero **todos** caen en
el gating por ventana horaria (`primary_inactive_by_schedule`), que está excluido del
denominador. Es decir: sus intentos evaluables son **0** porque el 100 % de sus eventos es
política horaria, no porque no aparezca en el log. Además es `billing: paid`, con lo cual
queda fuera del criterio automático por invariante.

---

## 4. Costo de failover, atribuido a su causa (CA-2)

El operador percibe "la cadena tarda en avisar que se cayó". Ese costo **existe**, pero
no es de los gratuitos:

| Causa | Eventos | % del total |
|---|---:|---:|
| Política horaria (`*_by_schedule`, `fallback_also_gated`) | 54.431 | 51,1 % |
| Eventos de cadena (`chain_exhausted`, `gated_no_fallbacks`, forzados) | 31.310 | 29,4 % |
| Bloqueo imputable a un proveedor (salud / cupo / credencial) | 17.447 | 16,4 % |
| Dispatch resuelto (`fallback_selected`) | 3.426 | 3,2 % |
| Kill-switch del operador (`provider_disabled`) | 0 | 0,0 % |
| Fuera de taxonomía | 0 | 0,0 % |
| **TOTAL** | **106.614** | **100 %** |

**Los buckets cierran contra el total.** Es una propiedad verificada por el propio reporte
(`failoverCost.reconciles`) y por test. En rev-1 no cerraban: 261 eventos
`gated_no_fallbacks` quedaban fuera del denominador de los porcentajes sin que el
documento lo mencionara. Esos 261 son hoy parte del bucket *eventos de cadena*, y se
verificó sobre los 88 archivos completos del log que la reconciliación es exacta
(139.658 entradas leídas = 139.658 eventos clasificados, `unclassified: 0`).

**Lectura para el operador:** de cada 10 eventos que alargan el camino hasta la respuesta,
**5 son la ventana horaria** que nosotros configuramos y sólo **1,6 son proveedores
bloqueados**. Sacar gratuitos de la cadena no toca la mitad grande del problema.

De esos 17.447 bloqueos imputables, **3.658 son gateos de `gemini-google` y el 100 % de
ellos tiene causa local** (`cli_license_unavailable`). Es decir: una parte sustancial del
"ruido de proveedores" es, en realidad, un bug de instrumentación nuestro.

---

## 5. Efecto cross pipeline (CA-3)

### 5.1 Los gratuitos no descargan al pago: recogen lo que el pago rechazó

Evidencia sobre las 1.332 selecciones ganadas por proveedores gratuitos declarados en la
ventana:

```
$ # primary_provider en los dispatches ganados por un gratuito
{"anthropic": 1332}          # 1.332 de 1.332 — el 100%

$ # cadenas efectivamente probadas antes de llegar al gratuito (top 5)
670  anthropic > openai-codex > gemini-google > cerebras
298  anthropic > openai-codex > gemini-google > cerebras > nvidia-nim
201  anthropic > openai-codex > gemini-google
 93  anthropic > openai-codex > cerebras
 56  anthropic > openai-codex > nvidia-nim
```

En **todas** las cadenas, los dos proveedores pagos (`anthropic` y `openai-codex`) fueron
probados y descartados **antes** de llegar al gratuito. Los gratuitos ocupan
exclusivamente las posiciones de fallback ≥1:

```
wins por fallback_index: {"0": 2007, "1": 350, "2": 698, "3": 371}
                          ^^^^ openai-codex   ^^^^^^^^^^^^^^^^^^^^ free tier (1.419,
                                                incluye los 87 de kimi-moonshot)
```

**Consecuencia directa sobre la pregunta del issue:** la baja de un gratuito **no**
transfiere carga al proveedor pago — el pago ya había dicho que no. Transfiere esos
dispatches a `chain_exhausted`, es decir: el issue vuelve a `pendiente/` y el agente no
arranca. El *headroom* del pago es irrelevante para esta decisión, porque no hay carga
que trasladarle.

### 5.2 Efecto sobre reintentos y despacho de agentes

`chain_exhausted` fue 31.049 eventos en la ventana, **todos** con
`reason: all_gated` (ninguno `todos_inactivos_por_horario`). Dar de baja a los tres
gratuitos declarados agregaría ~1.332 eventos más a ese total (**+4,3 %**), cada uno
equivalente a un agente que no se lanzó.

El costo de tener un proveedor **muerto** por delante es real pero acotado: el dispatcher
evalúa candidatos en memoria (flags de cuota, snapshot de health, pacing) sin invocar al
proveedor, así que un candidato descartado cuesta un audit-append y no una llamada de red.
Lo que sí encarece el diagnóstico es la **mezcla de causas**: hoy un rojo por flag local y
un rojo por credencial inválida se ven igual en el panel.

### 5.3 Costo de mantenimiento por proveedor

| Proveedor | Config (`config.yaml`) | Catálogo | Chequeo de salud | Tests |
|---|---|---|---|---|
| anthropic | `ttl_by_provider`, `quota_alert` | sí | probe CLI-OAuth | sí |
| openai-codex | `ttl_by_provider`, `quota_alert` | sí | probe CLI-OAuth | sí |
| gemini-google | `ttl_by_provider`, `quota_alert` | sí | probe CLI-OAuth (**roto**, #6225) | sí |
| cerebras | `ttl_by_provider` | sí | live-ping api_key | sí |
| nvidia-nim | `ttl_by_provider` | sí | live-ping api_key | sí |
| kimi-moonshot | **ausente** (#6153) | parcial | **ausente** del snapshot de salud | no |

El costo de mantenimiento de un gratuito sano (`cerebras`, `nvidia-nim`) es **una línea
de TTL y un live-ping**. Frente a 763 y 368 dispatches resueltos respectivamente, la
relación costo/beneficio no justifica ninguna baja.

El único costo de mantenimiento realmente anómalo es el de **`kimi-moonshot`**: despacha
87 veces sin estar declarado en ningún lado, lo que significa que corre **sin TTL de
cuota, sin umbral de alerta y sin chequeo de salud**. Eso no es un argumento para bajarlo:
es un argumento para declararlo (#6153).

---

## 6. Recomendación por proveedor (CA-4)

| Proveedor | Recomendación | Evidencia que la sostiene |
|---|---|---|
| **anthropic** | **mantener** | `billing: paid` — excluido del criterio automático por invariante. Es el primario de todos los skills LLM. |
| **openai-codex** | **mantener** | `billing: paid` — excluido por invariante. Además es el mayor aportante en volumen absoluto (2.007). |
| **cerebras** | **mantener** | 763 aportes / 2.803 evaluables = **27,2 %**, muy por encima del umbral del 5 %. Cero gateos por salud, estado `green`. Último aporte el mismo día de la medición. |
| **nvidia-nim** | **mantener** | 368 aportes / 583 evaluables = **63,1 %**. Cero gateos por salud, estado `green`. Último aporte el mismo día. |
| **gemini-google** | **mantener** + **recuperar** (#6225) | 201 aportes / 216 evaluables = **93,1 %**, la mejor tasa de la cadena declarada. Sus 3.658 gateos son 100 % `cli_license_unavailable`, causa **local**, y por eso no entran al denominador. Ver §7. |
| **kimi-moonshot** | **sin declarar** — no se decide | 87 dispatches ganados, pero ausente de `config.yaml` y del snapshot de salud. Evaluarlo contra umbrales inexistentes sería peor que no evaluarlo. Se reconcilia en #6153 y se re-mide después. |

> **Ninguna de estas recomendaciones se apoya en la latencia.** En rev-1, la de
> `nvidia-nim` se sostenía parcialmente sobre *"latencia alta (15,9 s)"* — un número que
> no reproduce (§3). Todas las recomendaciones de esta tabla se sostienen sobre tasa de
> aporte, causa del bloqueo dominante y fecha del último aporte real: los tres, agregados
> de la ventana completa.

**Ningún proveedor queda marcado como candidato a baja en esta ventana.** Ese es un
resultado válido de la evaluación, no un vacío.

---

## 7. Caso Gemini, cerrado (CA-5)

### Por qué figura rojo

`.pipeline/lib/multi-provider/cli-oauth-probe.js:82`:

```js
if (spec.readiness_env && env[spec.readiness_env] !== '1') {
    return { ok: false, reason: 'cli_license_unavailable', ... };
}
```

con `readiness_env: 'AGY_LICENSE_READY'` declarado en `secrets-rw.js:113`.

Ese rojo **no es un veredicto sobre Gemini**: es una variable de entorno que no vale
`'1'` en el proceso del health-cron. No hay round-trip al proveedor, no hay verificación
de billing, no hay 4xx ni 5xx.

### Por qué, aun así, despacha

`dispatch-with-fallback.js:792-825`. El health-gate sólo bloquea con un rojo **fresco**
(`HEALTH_FRESHNESS_MS` = 20 min, línea 735) **y** de causa **durable**
(`DURABLE_RED_REASONS`, línea 749, que incluye `cli_license_unavailable`). Con snapshot
más viejo que 20 minutos cae en `red_stale` → **fail-open**, y el proveedor entra igual.

De ahí los dos números contradictorios en la **misma ventana y el mismo proveedor**:

```
gemini-google:  201 selecciones ganadas
              3.658 gateos por salud, 100% con health_reason = cli_license_unavailable
```

El mismo proveedor entra por una puerta y es rechazado por la otra.

### Veredicto

**Chequeo mal calibrado, no proveedor muerto ⇒ recuperar, no dar de baja.**

Con el gateo de causa local fuera del denominador — como manda el body del issue — el
número que queda es contundente: **de cada 100 intentos que le son realmente imputables,
Gemini resuelve 93**. No es un proveedor seco: es un proveedor sano al que le tapamos la
puerta el 94 % de las veces con un flag de entorno propio.

Es exactamente el escenario Gherkin 3 del issue: *"proveedor bloqueado por un chequeo de
salud mal calibrado"*. Proponer la baja con esta evidencia sería el anti-patrón que la
propia historia vino a evitar — y le quitaría a la cadena el proveedor que sostiene el
**96 %** de su tráfico conversacional.

**Seguimiento creado y enlazado: #6225** — *"Corregir el chequeo de salud de
gemini-google: rojo permanente por un flag de entorno local, sin round-trip al
proveedor"*.

---

## 8. Criterio de permanencia (CA-6)

El criterio vive en `config.yaml` → `multi_provider.permanence`, **apagado por default**,
y se reejecuta con un comando sin análisis manual:

```bash
node .pipeline/scripts/provider-contribution-report.js --dias=30 --hasta=YYYY-MM-DD
```

| Umbral | Valor | Qué decide |
|---|---:|---|
| `min_sample` | 200 | Intentos evaluables mínimos. Por debajo ⇒ `no evaluable`. |
| `min_contribution_rate` | 0.05 | Tasa de aporte bajo la cual se marca candidato. |
| `max_days_without_win` | 14 | Días sin un solo aporte real que marcan candidato. |
| `min_survivors` | 1 | Proveedores **no pagos** sanos que deben sobrevivir siempre. |
| `window_days` | 30 | Ventana de medición. |
| `enabled` | `false` | Rollout gradual. |

El reporte **declara de dónde salió cada umbral** (línea `Procedencia de los umbrales`).
Si `config.yaml` no resuelve, el CLI **falla con exit 1** en vez de correr con defaults:
un umbral que decide quién sale de la cadena no puede salir de un `catch`.

Los invariantes **no** son configurables — viven en código y cada uno tiene test:

1. **Marca candidatos; nunca ejecuta la baja.** La baja es un PR de configuración.
2. **Nunca vacía la cadena que puede tocar.** Si marcar dejaría menos de `min_survivors`
   proveedores **no pagos** sanos, no marca a ninguno. Los pagos **no cuentan** como
   sobrevivientes: son `mantener` por construcción y satisfarían el invariante de forma
   vacua, dejando que el criterio vacíe la cadena de gratuitos entera de un saque.
   *(Éste fue el bloqueante crítico corregido en rev-2: con los 2 pagos contando, el guard
   no se disparaba nunca y el criterio proponía bajar los 3 gratuitos a la vez — el
   incidente del 19/08 auto-infligido y permanente.)*
3. **Nunca marca a un proveedor `billing: paid`.**
4. **"Sin dato" ⇒ `no evaluable`, jamás "no aporta".** Muestra chica, silencio del log,
   ventana vacía o hash-chain rota ⇒ no se decide. Un proveedor sin calibración en
   `config.yaml` es `sin declarar` **sin excepción**: la derivación falla *cerrada*.
5. **Un bloqueo de origen local no baja la tasa** (queda fuera del denominador) y, si aun
   así el proveedor rinde poco, tiene techo `rol acotado`: no habilita la baja sin
   corregir antes el chequeo.

La definición completa y la tabla de equivalencia con el panel de salud están en
`docs/pipeline/multi-provider.md`, sección *"Criterio de permanencia de proveedores"*.

---

## 9. Plan de ejecución

*(Cierra el punto 5 de "Cambios requeridos" del issue.)*

El orden **no es negociable**: medir con un gate roto produce evidencia que justifica la
decisión equivocada.

### Paso 0 — Corregir el chequeo de Gemini (**#6225**) · *bloqueante*
Sin esto, cualquier medición de `gemini-google` sigue conviviendo con 3.658 bloqueos de
causa local. **Nada de lo que sigue se ejecuta antes de cerrar #6225.**

### Paso 1 — Declarar `kimi-moonshot` (#6153)
Hoy despacha sin TTL de cuota, sin umbral de alerta y sin chequeo de salud. Mientras siga
`sin declarar`, no es evaluable y no puede entrar ni salir de la cadena por criterio.

### Paso 2 — Re-medir sobre una ventana limpia de 30 días
Con #6225 y #6153 cerrados, correr de nuevo fijando el fin de ventana:

```bash
node .pipeline/scripts/provider-contribution-report.js --dias=30 --hasta=YYYY-MM-DD --registrar
```

El `--registrar` deja la nueva evaluación en el audit append-only, comparable contra ésta.

### Paso 3 — Bajas, **de a una**, sólo si el criterio marca alguna
Para **cada** proveedor marcado, en este orden y nunca en paralelo:

1. Sacarlo de la cadena de fallbacks en `agent-models.json` (PR trazable que referencia
   la entrada de audit que lo sostiene). **No** revocar credencial todavía.
2. **Ventana de observación: 7 días.** Métricas a vigilar:
   - `chain_exhausted` no crece más de un 5 % respecto de la ventana previa;
   - ningún skill queda sin ruta de dispatch;
   - la presión sobre el proveedor pago se mantiene bajo su umbral de `quota_alert`.
3. **Criterio de rollback, escrito antes de empezar:** si `chain_exhausted` crece más de
   un 5 %, o si algún skill queda sin candidatos, o si el pago cruza su umbral `crit` →
   **revertir el PR** y volver a la cadena anterior. El rollback se ejecuta primero y se
   analiza después.
4. Sólo si la ventana de observación cierra limpia: **recién ahí** revocar la credencial
   del proveedor dado de baja, en un PR separado.

**Orden de bajas propuesto para esta ventana: ninguna.** El criterio no marcó candidatos.

---

## 10. Verificación de que esto no ejecutó nada (CA-7)

El módulo y el CLI son read-only. Verificado de dos maneras:

**Estáticamente** — `provider-contribution.js` no contiene ninguna API de escritura de
`fs` (`writeFileSync`, `appendFileSync`, `mkdirSync`, `renameSync`, `rmSync`,
`unlinkSync`, `appendChained`). Hay un test que falla si alguna aparece:
`el modulo es read-only: no invoca ninguna API de escritura de fs`.

**Empíricamente** — el test de integración
`el reporte es read-only: no modifica ningun archivo del pipeline (CA-7)` toma un
snapshot recursivo de un `.pipeline/` completo, corre el reporte dos veces y compara:
ningún archivo cambia, y sin `--registrar` ni siquiera se crea el directorio de audit.

La única escritura del feature es **opt-in** (`--registrar`) y va al audit append-only con
hash-chain, vía `audit-log.appendChained`. Nunca `writeFileSync` sobre ese path.

---

## 11. Limitaciones conocidas de esta medición

Se declaran para que quien lea el documento no le atribuya más precisión de la que tiene:

- **CA-1 queda parcialmente abierto en la parte de latencia.** La *latencia mediana sobre
  la ventana* que pide el criterio **no se puede calcular hoy**: el log de dispatch no
  registra latencia por invocación. Lo que se reporta es el **último live-ping** del
  snapshot de salud, rotulado como tal, volátil (15,9 s / 2,3 s / 1,26 s para el mismo
  proveedor el mismo día) y **sin peso en ninguna recomendación**. Cierra con **#6152**.
- **La latencia de los tres proveedores CLI-OAuth no existe ni siquiera como ping**
  (`anthropic`, `openai-codex`, `gemini-google`). La celda lo dice; no se estima.
- **`anthropic` no es medible con esta fuente**: como primario, el 100 % de sus eventos es
  gating por ventana horaria, que está excluido del denominador. Sus evaluables son 0 por
  construcción, no por falta de actividad.
- **La medición de `gemini-google` sigue conviviendo con el gate roto.** El 93,1 % ya
  excluye los 3.658 gateos de causa local, así que no está sesgado *a la baja* como en
  rev-1; pero el volumen de intentos que Gemini habría podido atender sin el gate es
  desconocido. Ninguna decisión de baja puede apoyarse en sus números hasta cerrar #6225.
- **`kimi-moonshot` tiene muestra chica** (87 eventos) además de estar sin declarar.
- **Los buckets del §4 usan porcentajes redondeados a un decimal**; la suma puede dar
  100,1 % por redondeo. Los conteos absolutos sí cierran exacto contra el total.

---

## 12. Trazabilidad

| Qué | Dónde |
|---|---|
| Decisión (este documento) | `docs/pipeline/evaluacion-free-providers-6145.md` |
| Criterio permanente | `docs/pipeline/multi-provider.md` → *Criterio de permanencia de proveedores* |
| Umbrales | `.pipeline/config.yaml` → `multi_provider.permanence` |
| Implementación | `.pipeline/lib/multi-provider/provider-contribution.js` |
| Reporte reejecutable | `.pipeline/scripts/provider-contribution-report.js` |
| Registro append-only | `.pipeline/audit/provider-permanence.jsonl` |
| Seguimiento Gemini | #6225 |
| Dependencias no bloqueantes | #6152 (latencia real por invocación), #6153 (declarar `kimi-moonshot`), #6160 / #6165 (UI) |
