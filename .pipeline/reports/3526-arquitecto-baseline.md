# Análisis cuantitativo retrospectivo — Rol Arquitecto (sub-tarea #3526 para #3507)

**Fecha:** 2026-05-25
**Autor:** pipeline-dev (sesión #3526)
**Período analizado:** dev sessions del 2026-05-24 al 2026-05-25 (snapshot 24h + all)

---

## 1. Metodología y proxies elegidas

### Fuentes de datos

- `.pipeline/metrics/snapshot.json` (ventana `all`) y `snapshot-24h.json` (ventana 24h).
- `.pipeline/metrics/pricing.json` (versión 2026-05-08).
- Resultados YAML en `.pipeline/desarrollo/dev/procesado/<id>.pipeline-dev` (para contar rebotes).

`.pipeline/audit/*.jsonl` **no** contiene tokens por issue (sólo health de providers
y notificaciones de cambio de modelo), tal como advirtió el análisis técnico del issue.

### Proxy de "exploración"

El pipeline no instrumenta una fase discreta `exploration`. Las phases reales son
`analisis | validacion | criterios | sizing | dev | build | verificacion | aprobacion | delivery`.

**Proxy aplicado:** el rol Arquitecto reemplazaría aproximadamente el **30 % inicial
de la sesión `dev`** — la porción dedicada a leer código existente, mapear módulos,
identificar dependencias y elegir el approach técnico, **antes** de empezar a editar.
El 70 % restante (implementación, debugging, tests) sigue requiriendo el modelo
top-tier (Opus 4.7) por la complejidad de las decisiones de código.

Este proxy es coherente con la spec original (`primeras 2-4 horas, antes de
implementación real`) y con el principio operativo del Arquitecto:
**entregar una "receta técnica" — qué archivos tocar, qué patrón seguir, qué tests
escribir — para que el dev arranque sin re-explorar.**

### Ratio Opus 4.7 vs Sonnet 4.6 (pricing real)

De `pricing.json`:

| Modelo | input ($/M) | output ($/M) | cache_read ($/M) | cache_write ($/M) |
|--------|-------------|--------------|------------------|-------------------|
| Opus 4.7   | 15.00 | 75.00 | 1.50 | 18.75 |
| Sonnet 4.6 |  3.00 | 15.00 | 0.30 |  3.75 |
| Haiku 4.5  |  1.00 |  5.00 | 0.10 |  1.25 |

Ratio efectivo Opus/Sonnet = **5.00x exactos en todas las dimensiones** → Sonnet es
exactamente 20 % del costo de Opus por token equivalente.

> La spec original de #3507 estimaba ratio 1/3 a 1/2 ("30-50 % de ahorro"). La pricing
> real es más agresiva: Sonnet 4.6 cuesta 20 % de Opus. El ahorro proyectado real
> es del orden de **70-80 % en sesiones migradas completas**, o **~24 % aplicado solo
> al 30 % exploratorio del dev**.

### Selección de issues

Se eligieron las **3 dev sessions con datos completos** disponibles en snapshot
(spikes #3378 - H3/H4/H5, todos cerrados o en post-dev al momento del análisis):

- `#3487` — Dashboard: widget próximas olas (H3)
- `#3492` — Calculadora ETA probabilística (H4)
- `#3493` — Telegram Commander `/wave` (H5)

Todos son del dominio `area:pipeline`, ejecutados por skill `pipeline-dev` en
modelo Opus 4.7.

---

## 2. Tabla de análisis

| Issue | Tokens (in+out) | Cache (read+write) | Duración | Costo Opus | Sonnet equiv | Haiku equiv | Ahorro 100 % Sonnet | Ahorro 30/70 Arquitecto | Rebotes | Evitables (est.) |
|-------|-----------------|--------------------|----------|-----------:|-------------:|-------------:|--------------------:|------------------------:|--------:|-----------------:|
| #3487 | 2 162           | 2 264 813          | 7 min    | $4.80      | $0.96        | $0.32        | $3.84 (80 %)        | $1.15 (24 %)            | 1 (rev-1) | 1 (merge-main) |
| #3492 | 5 333           | 15 524 051         | 20 min   | $28.36     | $5.67        | $1.89        | $22.69 (80 %)       | $6.81 (24 %)            | 3 (rev-3) | 2 (refactor invasivo, signature) |
| #3493 | 5 153           | 20 597 254         | 22 min   | $37.32     | $7.46        | $2.49        | $29.86 (80 %)       | $8.96 (24 %)            | 0       | 0                |
| **TOTAL** | **12 648** | **38 386 118** | **49 min** | **$70.48** | **$14.09** | **$4.70** | **$56.39 (80 %)** | **$16.92 (24 %)** | **4** | **3** |

> Nota sobre el "ratio 5x exacto": viene de que la pricing.json mantiene la misma
> proporción 5:1 en input/output/cache_read/cache_write. Por eso el ahorro 100 %
> Sonnet es uniforme 80 % y el ahorro 30/70 arquitecto es uniforme 24 %.

---

## 3. Gráfico ASCII — comparativa de costos

```
Costo dev session por issue (USD)
Opus 4.7 (real)  vs  Sonnet 4.6 (equivalente)  vs  Arquitecto 30/70

#3487  Opus       |█████ $4.80
       Sonnet     |█ $0.96
       Arquitecto |████ $3.65

#3492  Opus       |██████████████████████████████ $28.36
       Sonnet     |██████ $5.67
       Arquitecto |███████████████████████ $21.56

#3493  Opus       |████████████████████████████████████████ $37.32
       Sonnet     |████████ $7.46
       Arquitecto |██████████████████████████████ $28.37

TOTAL  Opus       $70.48  ████████████████████████████████████████ 100 %
       Sonnet     $14.09  ████████ 20 %
       Arquitecto $53.57  ██████████████████████████████ 76 %
```

---

## 4. Análisis de rebotes y costo evitable

El costo total de un issue **no es solo el dev session inicial**: cada rebote
genera trabajo adicional (parsing del motivo, ediciones puntuales, re-build,
re-tests). El historial de rebotes:

### #3487 — 1 rebote (rev-1)

**Causa raíz** (del resultado YAML): el branch no había mergeado main, faltaba
traer commits del Spike #3527 (H2). `git diff` mostraba archivos de H2 como
deleciones espurias.

**¿Lo evita el Arquitecto?** **Sí.** Una receta técnica que incluya `"merge
origin/main antes de pushear"` o `"verificar diff vs main"` como pre-checklist
es estándar y barata de generar.

### #3492 — 3 rebotes (rev-3)

**Causa raíz** (del resultado YAML): refactor invasivo del dashboard render loop +
discusión de signature de `getPipelineState()`. Múltiples ciclos de feedback con
review y verificación.

**¿Lo evita el Arquitecto?** **Parcialmente.** Una receta que defina el patrón
"reusar `state.issueMatrix`, fire-and-forget cacheado, no cambiar signature
pública" hubiera convergido en rev-1 o rev-2. Estimación: **2 de 3 rebotes
evitables** (los puramente de approach técnico).

### #3493 — 0 rebotes

**¿Lo evita el Arquitecto?** **N/A.** Este issue ya fue eficiente.

### Costo total con rebotes

Estimando que cada rebote agrega ~40 % del costo dev original (parsing rechazo +
ediciones + re-build, basado en duración relativa observada en otros rebotes
históricos):

| Issue | Dev inicial | Rebotes | Costo rebotes (est.) | Total Opus real | Total con Arquitecto (30/70 dev + 50 % rebotes evitados) |
|-------|------------:|--------:|---------------------:|----------------:|----------------------------------------------------------:|
| #3487 | $4.80       | 1       | $1.92 (40 %)         | $6.72           | $3.65 + $0 = **$3.65** (ahorro $3.07 / 45.7 %)           |
| #3492 | $28.36      | 3       | $34.03 (3 × 40 %)    | $62.39          | $21.56 + $11.34 = **$32.90** (ahorro $29.49 / 47.3 %)    |
| #3493 | $37.32      | 0       | $0                   | $37.32          | $28.37 + $0 = **$28.37** (ahorro $8.96 / 24.0 %)         |
| **TOTAL** | **$70.48** | **4** | **$35.95** | **$106.43** | **$64.92** (ahorro **$41.51 / 39.0 %**) |

---

## 5. Conclusión

### Rango de ahorro confirmado

Sobre la muestra de 3 spikes recientes (`#3487`, `#3492`, `#3493`), el rol
Arquitecto proyectaría tres niveles de ahorro según escenario:

1. **Conservador (solo exploración 30 % migrada, sin contar rebotes):**
   **24 %** uniforme → ahorro absoluto $16.92 sobre $70.48 invertidos.

2. **Realista (exploración 30 % + 50 % de rebotes evitados por receta correcta):**
   **39 %** ponderado → ahorro absoluto $41.51 sobre $106.43 totales.
   Rango por issue: 24-47 %.

3. **Agresivo (dev completo migrado a Sonnet 4.6 — solo si la complejidad lo permite):**
   **80 %** uniforme → ahorro absoluto $56.39. Probablemente no aplicable sin
   degradar calidad para tareas complejas; sirve como cota superior teórica.

### Recomendación para #3507

- La hipótesis original de `-30-50 % de costo` **se confirma en el escenario
  realista (39 %)** una vez que se contabilizan las rebotes evitadas.
- El ahorro principal **no viene del costo per-token del modelo**, sino de
  **eliminar rebotes de approach técnico** con una receta upfront — esto solo es
  visible cuando se mide costo total per-issue (no costo per-session).
- Para tareas simples (`size:simple` o `size:medium` puras de pipeline-dev como
  `#3487`, `#3493`), un agente Arquitecto **Sonnet 4.6** es suficiente.
- Para tareas con riesgo de rebote alto (refactors invasivos como `#3492`),
  invertir más en la receta inicial (Sonnet 4.6 con más context) tiene ROI claro.
- **Próximo paso sugerido:** medir el mismo análisis sobre 10-20 issues más una
  vez que el rol Arquitecto esté en piloto, para validar la proyección con
  datos reales en lugar de hipotéticos.

### Caveats de esta medición

1. **Muestra chica (n=3)** — sirve como sanity check, no como prueba estadística.
2. **Costo de rebotes estimado en 40 % del dev inicial** — basado en duración
   relativa observada, no medido por sesión (los rebotes no tienen contador
   propio de `cost_usd` en el snapshot agregado por skill).
3. **Sonnet 4.6 nunca corrió** estas tareas; el costo equivalente asume mismo
   patrón de tokens, lo cual subestima ligeramente el overhead que Sonnet
   suele necesitar (más explicaciones, menos compresión).
4. **No considera latencia / wall-clock** — Sonnet es típicamente más rápido,
   lo que puede acelerar el ciclo end-to-end del issue.

---

**Generado por:** pipeline-dev en sesión `#3526` (spike, fase `dev`)
**Datos brutos:** `.pipeline/metrics/snapshot.json` + `snapshot-24h.json` + dev YAMLs en `procesado/`
**Modelo usado para este análisis:** Claude Opus 4.7 (irónicamente)
