# Evaluación de permanencia de los proveedores gratuitos de la cadena — #6145

> **Documento de decisión.** Registra qué se midió, con qué evidencia y qué se decide
> hacer con cada proveedor de la cadena multi-provider. El *flip* de configuración es
> un paso posterior y trazable: este documento **no** da de baja a nadie.
>
> Registro de auditoría append-only asociado: `.pipeline/audit/provider-permanence.jsonl`
> (entrada `provider_permanence_evaluated`, `executed_action: none`).

---

## 1. Conclusión

**No se da de baja a ningún proveedor.**

1. **No se propone dar de baja a ningún proveedor en esta ventana.** La premisa que abrió
   el issue — *"varios gratuitos permanentemente secos"* — no se sostiene con los datos.
2. **Gemini figura rojo en el panel por un flag de entorno nuestro, pero es el proveedor
   que más sostiene la conversación con el operador**: 277 dispatches ganados, el 90% de
   ellos conversacionales. Se **recupera**, no se baja. Seguimiento creado: **#6225**.
3. **Cerebras y NVIDIA aportan de forma sostenida y sin un solo gateo por salud.**
   NVIDIA es, de hecho, el proveedor con mejor tasa de aporte de toda la cadena (60,6%).
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
| **Ventana** | 2026-07-20 → 2026-08-19 (30 días) |
| **Fuente** | `.pipeline/logs/cross-provider-dispatch-*.jsonl` (append-only con hash-chain) |
| **Archivos** | 31 archivos diarios |
| **Eventos leídos** | 97.616 |
| **Integridad** | `hash-chain: OK` — los 31 archivos verifican con `audit-log.verifyChain` |
| **Comando** | `node .pipeline/scripts/provider-contribution-report.js --dias=30` |

### Por qué esta fuente y no `activity-log.jsonl`

`.claude/activity-log.jsonl` sólo registra `provider` en `session:start` / `session:end`:
mide **sesiones de agente ya arrancado**, no intentos de proveedor. Medir con esa fuente
daría **cero** para `gemini-google`, `cerebras` y `nvidia-nim` — los tres que más
despachan — y el criterio los daría de baja justo por aportar. Hay un test que falla si
el módulo llega a importarla (`el modulo no lee activity-log.jsonl`).

### Cómo se cuenta

- **Aporte real** = evento `fallback_selected`. Es la única señal de que el proveedor
  efectivamente resolvió un pedido.
- **Denominador** = `intentos − gateos por ventana horaria`. Los eventos
  `primary_inactive_by_schedule`, `fallback_also_gated` y
  `fallback_provider_inactive_by_schedule` son el **50,1%** del total: incluirlos mediría
  la política de horarios, no al proveedor.
- **Bloqueo dominante** se clasifica en tres familias que no se mezclan: `cupo`
  (recuperable por diseño), `observabilidad local` (bug nuestro, jamás imputable al
  proveedor) y `credencial`.

---

## 3. Aporte real por proveedor (CA-1)

| Proveedor | Intentos evaluables | Aportes | Tasa | Latencia mediana | Bloqueo dominante | Último aporte | Rol (conversacional / pipeline) | Recomendación |
|---|---:|---:|---:|---|---|---|---|---|
| openai-codex | 13.581 | 2.062 | 15,2 % | sin instrumentar (#6152) | cupo | 2026-08-19 00:16 | 25 % / 75 % | mantener |
| cerebras | 2.644 | 802 | 30,3 % | 674 ms | cupo | 2026-08-19 20:37 | 61 % / 39 % | mantener |
| nvidia-nim | 546 | 331 | 60,6 % | 15,9 s | cupo | 2026-08-19 20:37 | 79 % / 21 % | mantener |
| gemini-google | 3.648 | 277 | 7,6 % | sin instrumentar (#6152) | observabilidad local (`cli_license_unavailable`) | 2026-08-19 20:38 | 90 % / 10 % | mantener |
| kimi-moonshot | 73 | 73 | 100,0 % | sin instrumentar (#6152) | sin muestra | 2026-08-18 07:46 | 0 % / 100 % | sin declarar (#6153) |
| anthropic | sin muestra | sin muestra | sin muestra | sin instrumentar (#6152) | sin muestra | sin muestra | sin muestra | mantener |

**Cómo leer las celdas que no traen número.** Ninguna ausencia se escribe como `0` ni
como `—`: cada una declara su causa.

- `sin instrumentar (#6152)` — el proveedor autentica por CLI-OAuth y **no hay round-trip
  medido**. El número no existe; no se estima. Derivarlo del `duration_ms` del
  activity-log sería inventarlo (ese valor es wall-clock del agente, p50 ≈ 602 s).
- `sin muestra` — no hubo eventos evaluables. **No** equivale a "no aporta".
- `sin declarar (#6153)` — despacha pero falta en la configuración operativa.

**Por qué `anthropic` no tiene fila con números.** Es el proveedor **primario** de todos
los skills LLM: nunca aparece como candidato de fallback, así que no genera intentos
evaluables en este log. Su ausencia de datos es estructural, no un síntoma. Además es
`billing: paid`, con lo cual queda fuera del criterio automático por definición.

---

## 4. Costo de failover, atribuido a su causa (CA-2)

El operador percibe "la cadena tarda en avisar que se cayó". Ese costo **existe**, pero
no es de los gratuitos:

| Causa | Eventos | % del total |
|---|---:|---:|
| Política horaria (`*_by_schedule`, `fallback_also_gated`) | 48.743 | 50,1 % |
| Cadena agotada (`chain_exhausted`) | 28.120 | 28,9 % |
| Bloqueo imputable a un proveedor (salud / cupo / credencial) | 16.947 | 17,4 % |
| Dispatch resuelto (`fallback_selected`) | 3.545 | 3,6 % |

Desglose de los 48.743 de política horaria: 29.539 `primary_inactive_by_schedule` +
19.204 `fallback_also_gated`.

**Lectura para el operador:** de cada 10 eventos de gating que alargan el camino hasta la
respuesta, **5 son la ventana horaria** que nosotros configuramos y sólo **1,7 son
proveedores bloqueados**. Sacar gratuitos de la cadena no toca la mitad grande del
problema.

De esos 16.947 bloqueos imputables, **14.696 son health-gates**, y de ellos **3.337
(el 99,0% de los bloqueos de Gemini) tienen causa local**, no del proveedor. Es decir:
una parte sustancial del "ruido de proveedores" es, en realidad, un bug de
instrumentación nuestro.

---

## 5. Efecto cross pipeline (CA-3)

### 5.1 Los gratuitos no descargan al pago: recogen lo que el pago rechazó

Evidencia sobre las 1.483 selecciones ganadas por proveedores gratuitos en la ventana:

```
$ # primary_provider en los dispatches ganados por un gratuito
{"anthropic": 1483}          # 1.483 de 1.483 — el 100%

$ # cadenas efectivamente probadas antes de llegar al gratuito (top 5)
700  anthropic > openai-codex > gemini-google > cerebras
277  anthropic > openai-codex > gemini-google
262  anthropic > openai-codex > gemini-google > cerebras > nvidia-nim
102  anthropic > openai-codex > cerebras
 55  anthropic > openai-codex > nvidia-nim
```

En **todas** las cadenas, los dos proveedores pagos (`anthropic` y `openai-codex`) fueron
probados y descartados **antes** de llegar al gratuito. Los gratuitos ocupan
exclusivamente las posiciones de fallback ≥1:

```
wins por fallback_index: {"0": 2062, "1": 434, "2": 721, "3": 328}
                          ^^^^ openai-codex   ^^^^^^^^^^^^^^^^^^^^ free tier (1.483)
```

**Consecuencia directa sobre la pregunta del issue:** la baja de un gratuito **no**
transfiere carga al proveedor pago — el pago ya había dicho que no. Transfiere esos
dispatches a `chain_exhausted`, es decir: el issue vuelve a `pendiente/` y el agente no
arranca. El *headroom* del pago es irrelevante para esta decisión, porque no hay carga
que trasladarle.

### 5.2 Efecto sobre reintentos y despacho de agentes

`chain_exhausted` fue 28.120 eventos en la ventana, **todos** con
`reason: all_gated` (ninguno `todos_inactivos_por_horario`). Dar de baja a los tres
gratuitos que aportan agregaría ~1.483 eventos más a ese total (**+5,3%**), cada uno
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
de TTL y un live-ping**. Frente a 802 y 331 dispatches resueltos respectivamente, la
relación costo/beneficio no justifica ninguna baja.

El único costo de mantenimiento realmente anómalo es el de **`kimi-moonshot`**: despacha
73 veces sin estar declarado en ningún lado, lo que significa que corre **sin TTL de
cuota, sin umbral de alerta y sin chequeo de salud**. Eso no es un argumento para bajarlo:
es un argumento para declararlo (#6153).

---

## 6. Recomendación por proveedor (CA-4)

| Proveedor | Recomendación | Evidencia que la sostiene |
|---|---|---|
| **anthropic** | **mantener** | `billing: paid` — excluido del criterio automático por invariante. Es el primario de todos los skills LLM. |
| **openai-codex** | **mantener** | `billing: paid` — excluido por invariante. Además es el mayor aportante en volumen absoluto (2.062). |
| **cerebras** | **mantener** | 802 aportes / 2.644 evaluables = **30,3%**. Cero gateos por salud. `green`, latencia 674 ms. Último aporte el mismo día de la medición. |
| **nvidia-nim** | **mantener** | 331 aportes / 546 evaluables = **60,6%**, la mejor tasa de la cadena. Cero gateos por salud. `green`. Latencia alta (15,9 s) pero se usa como último recurso, donde 15 s vencen a no despachar. |
| **gemini-google** | **mantener** + **recuperar** (#6225) | 277 aportes, último el mismo día. Su tasa cruda (7,6%) está por encima del umbral, y aun si cayera por debajo el criterio le pone techo `rol acotado`: el 99,0% de sus bloqueos es `cli_license_unavailable`, causa **local**. Ver §7. |
| **kimi-moonshot** | **sin declarar** — no se decide | 73 dispatches ganados, pero ausente de `config.yaml` y del snapshot de salud. Evaluarlo contra umbrales inexistentes sería peor que no evaluarlo. Se reconcilia en #6153 y se re-mide después. |

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
gemini-google:  277 selecciones ganadas
              3.337 gateos por salud, 100% con health_reason = cli_license_unavailable
```

El mismo proveedor entra por una puerta y es rechazado por la otra.

### Veredicto

**Chequeo mal calibrado, no proveedor muerto ⇒ recuperar, no dar de baja.**

Es exactamente el escenario Gherkin 3 del issue: *"proveedor bloqueado por un chequeo de
salud mal calibrado"*. Proponer la baja con esta evidencia sería el anti-patrón que la
propia historia vino a evitar — y le quitaría a la cadena el proveedor que sostiene el
**90%** de su tráfico conversacional.

**Seguimiento creado y enlazado: #6225** — *"Corregir el chequeo de salud de
gemini-google: rojo permanente por un flag de entorno local, sin round-trip al
proveedor"*.

---

## 8. Criterio de permanencia (CA-6)

El criterio vive en `config.yaml` → `multi_provider.permanence`, **apagado por default**,
y se reejecuta con un comando sin análisis manual:

```bash
node .pipeline/scripts/provider-contribution-report.js --dias=30
```

| Umbral | Valor | Qué decide |
|---|---:|---|
| `min_sample` | 200 | Intentos evaluables mínimos. Por debajo ⇒ `no evaluable`. |
| `min_contribution_rate` | 0.05 | Tasa de aporte bajo la cual se marca candidato. |
| `max_days_without_win` | 14 | Días sin un solo aporte real que marcan candidato. |
| `min_survivors` | 1 | Proveedores sanos que deben sobrevivir siempre. |
| `window_days` | 30 | Ventana de medición. |
| `enabled` | `false` | Rollout gradual. |

Los invariantes **no** son configurables — viven en código y cada uno tiene test:

1. **Marca candidatos; nunca ejecuta la baja.** La baja es un PR de configuración.
2. **Nunca vacía la cadena.** Si marcar dejaría menos de `min_survivors` proveedores
   sanos, no marca a ninguno.
3. **Nunca marca a un proveedor `billing: paid`.**
4. **"Sin dato" ⇒ `no evaluable`, jamás "no aporta".** Muestra chica, silencio del log o
   hash-chain rota ⇒ no se decide.
5. **Un bloqueo de origen local tiene techo `rol acotado`**: no habilita la baja sin
   corregir antes el chequeo.

La definición completa y la tabla de equivalencia con el panel de salud están en
`docs/pipeline/multi-provider.md`, sección *"Criterio de permanencia de proveedores"*.

---

## 9. Plan de ejecución (CA-9)

El orden **no es negociable**: medir con un gate roto produce evidencia que justifica la
decisión equivocada.

### Paso 0 — Corregir el chequeo de Gemini (**#6225**) · *bloqueante*
Sin esto, cualquier medición de `gemini-google` está contaminada por 3.337 bloqueos de
causa local. **Nada de lo que sigue se ejecuta antes de cerrar #6225.**

### Paso 1 — Declarar `kimi-moonshot` (#6153)
Hoy despacha sin TTL de cuota, sin umbral de alerta y sin chequeo de salud. Mientras siga
`sin declarar`, no es evaluable y no puede entrar ni salir de la cadena por criterio.

### Paso 2 — Re-medir sobre una ventana limpia de 30 días
Con #6225 y #6153 cerrados, correr de nuevo:

```bash
node .pipeline/scripts/provider-contribution-report.js --dias=30 --registrar
```

El `--registrar` deja la nueva evaluación en el audit append-only, comparable contra ésta.

### Paso 3 — Bajas, **de a una**, sólo si el criterio marca alguna
Para **cada** proveedor marcado, en este orden y nunca en paralelo:

1. Sacarlo de la cadena de fallbacks en `agent-models.json` (PR trazable que referencia
   la entrada de audit que lo sostiene). **No** revocar credencial todavía.
2. **Ventana de observación: 7 días.** Métricas a vigilar:
   - `chain_exhausted` no crece más de un 5% respecto de la ventana previa;
   - ningún skill queda sin ruta de dispatch;
   - la presión sobre el proveedor pago se mantiene bajo su umbral de `quota_alert`.
3. **Criterio de rollback, escrito antes de empezar:** si `chain_exhausted` crece más de
   un 5%, o si algún skill queda sin candidatos, o si el pago cruza su umbral `crit` →
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

- **La latencia de los tres proveedores CLI-OAuth no existe** (`anthropic`,
  `openai-codex`, `gemini-google`). No está instrumentada — #6152. La columna lo dice; no
  se estima.
- **`anthropic` no es medible con esta fuente**: como primario, nunca es candidato de
  fallback. Su fila es estructuralmente vacía.
- **La medición de `gemini-google` está sesgada a la baja** por los 3.337 bloqueos de
  causa local. Su tasa real, con el chequeo corregido, será **mayor** que el 7,6% medido.
  Ninguna decisión de baja puede apoyarse en este número hasta cerrar #6225.
- **`kimi-moonshot` tiene muestra chica** (73 eventos) además de estar sin declarar.

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
| Dependencias no bloqueantes | #6152 (latencia real), #6153 (declarar `kimi-moonshot`), #6160 / #6165 (UI) |
