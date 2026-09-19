# UX · #6861 — Rename `gemini-google` → `antigravity` en el dashboard (fase `criterios`)

Verificado sobre `origin/main` = `ec7180162` (18/09/2026). Toma como cerrados el análisis de guru, los 8
requisitos SEC de security, los CA-1..CA-11 del PO y las decisiones D1..D12 del arquitecto. Acá se fija
**cómo se ve** el nombre nuevo en cada superficie del dashboard (Bloque E de la receta) y se entregan los
assets que el dev consume. El dev **renombra y ubica**; no inventa ícono, color ni copy.

## 0. Clasificación de scope

Labels: `enhancement`, `tipo:infra`, `area:pipeline`, `priority:medium`, `size:large`. Sin ningún `app:*`.
Usuario real: el operador leyendo `/providers`, `/costos`, chips/banners de cuota en home y Multi-Provider
Health. Impacto visual: **sí** (ícono del provider, familia de tokens, label, chip de tier, copy de cuota).
En `aprobacion` aplica PASO 2-bis (QA structural + screenshots headless de CA-7), no video.

## 1. Assets entregados en esta rama (`agent/6861-ux-assets`)

| Path | Qué es | Cómo lo consume el dev |
|---|---|---|
| `.pipeline/assets/icons/sprite.svg` | Símbolo nuevo `ic-provider-antigravity` **reemplaza** a `ic-provider-gemini` (mismo lugar del sprite) | `multi-provider-health.js:299` → `if(p==='antigravity') return 'ic-provider-antigravity';` y cualquier `<use href="#ic-provider-…">` del provider |
| `.pipeline/assets/design-tokens.css` | Familia `--provider-antigravity`, `-dim`, `-bg`, `-fg` **reemplaza** a `--provider-gemini*` (mismos valores: `#8AB4F8` / `#4285F4` / `rgba(138,180,248,.14)` / `#CBD9F9`). Encabezado 3.d y comentario reescritos (sin nota TOS de AI Studio) | `home.js:1000,1063`, `providers.js:102`, `multi-provider-health.js:286-291` (agregar la rama `antigravity`, hoy cae en `--provider-unknown`), `multi-provider.js:489-499` (ídem) |
| `.pipeline/assets/mockups/6861/dashboard-antigravity-rename.svg` + `.png` | Mockup de las 4 superficies + reglas R1..R6 | Evidencia visual primaria para PO/UX en `aprobacion` (render vs mockup) |
| este archivo | Contrato: decisiones, spec por archivo, copy, verificaciones | Checklist del dev y del reviewer |

**La rama sola no pasa la suite**: `views/dashboard/__tests__/providers.test.js:240` asserta `--provider-gemini:` y
`tests/agy-catalog-probe-6857.test.js:496` espera `accent: 'var(--provider-gemini)'`. Es intencional (fail-loud):
los assets se mergean **junto con** el Bloque E del dev, que actualiza esas aserciones al nombre nuevo. Nunca dejar
`ic-provider-gemini` ni `--provider-gemini` como alias "para no romper" (SEC-1).

## 2. Decisiones de UX (cerradas acá)

| # | Decisión | Valor | Por qué |
|---|---|---|---|
| U1 | Ícono | `ic-provider-antigravity`: línea de suelo + chevron de empuje + esfera anillada ("objeto que levita") | La metáfora "gemelos" nombraba lo que no era. Ningún otro símbolo del sprite usa línea de suelo; se distingue de `nvidia-nim` (nodo + satélites) y `groq` (rayo). Stroke 1.75 como la familia; legible a 16 px (verificado en el PNG) |
| U2 | Color | **Se conserva** `#8AB4F8` (tokens) y `#60A5FA` (gradientes de `/costos`) | Cambiar el color diría "es otro proveedor"; el mensaje del issue es "es el mismo con su nombre real". Continuidad para el operador en `/providers`, `/costos` y chips. Contraste ya validado: 9.2:1 sobre surface-0 |
| U3 | Label humano | `Antigravity` (Title case) en todas las vistas; id técnico `antigravity` sólo en `data-provider`, claves y monoespaciado | Coherente con `Claude` / `Codex` / `Cerebras` (nombre del producto, no del vendor) |
| U4 | Tier en `/costos` | `tier: 'LICENCIA'` con clase **nueva** `cz-ptier-lic` (azul del provider); en la tabla por skill `TIER_CHIP.lic = { cls: 'cz-ptier-lic', label: 'Licencia' }` | No es PAGO (rojo = consume créditos por token) ni FREE (verde). Es cuota fija de suscripción como PLAN MAX, de otro proveedor. El arquitecto dejó `tierCls` abierto a decisión visual (D12) |
| U5 | Tier en `/providers` | **No se afirma** (se mantiene R2 de #6564): sólo el badge medido `PLAN CON CUOTA · N% SEMANAL` / `PLAN · SIN VERIFICAR` / `PLAN · NO VERIFICABLE` | El tier contratado no tiene oráculo en `agy`; "LICENCIA" vive sólo en `/costos`, donde clasifica costo, no estado |
| U6 | Card de cuota en `/costos` | Se queda en la grilla (4.ª, tras Codex), deja de ser `freeCard`: chip `LICENCIA`, métricas `📨 Requests/día` + `🔆 Semanal (plan)`, pie «Licencia · cuota semanal medida en /providers · requests estimados (activity-log)» | Sin plumbing nuevo: si `/costos` no tiene el `%` semanal a mano, la métrica muestra `sin medir` (nunca inventa). La medición vive en `/providers` (#6564) |
| U7 | Emojis del SO | Sin `tierIcon` (🟩) para el provider | Identidad = color + símbolo del sprite (R6 de #3086) |
| U8 | Orden de filas por tier (`TIER_ORDER`) | `pay: 0, lic: 1, free: 2, det: 3` | Pagos → licencia → free → deterministas: de mayor a menor costo marginal |

## 3. Spec por archivo (Bloque E) — lo que el dev renombra

### `views/dashboard/costos.js`
- `PROVIDER_STACK_ORDER` / `CHART_STACK_ORDER` (L222-223): `'gemini'` → `'antigravity'`.
- `PROVIDER_META['antigravity'] = { label: 'Antigravity', color: '#60A5FA', tier: 'LICENCIA', tierCls: 'lic', free: false }` (reemplaza la entrada `gemini`).
- `PROVIDER_SEG`: `'antigravity': 'ag'` (reemplaza `'gemini': 'gm'`); CSS `.cz-seg-ag` y `.cz-pq-ag` con el **mismo** gradiente de `.cz-seg-gm` (`#60A5FA → #3b73c4`).
- CSS nuevo: `#costos-redesign .cz-ptier-lic{color:#CBD9F9;background:rgba(138,180,248,.13);border:1px solid rgba(138,180,248,.32)}`.
- `normProvider` (L260): tabla explícita `{ 'gemini-google': 'antigravity', 'gemini': 'antigravity', 'antigravity': 'antigravity' }` con `// histórico pre-#6861` (D10). Sin `includes('google')`.
- `PROVIDER_TIER['antigravity'] = 'lic'`; `TIER_ORDER = { pay: 0, lic: 1, free: 2, det: 3, unknown: 4 }`; `TIER_CHIP.lic = { cls: 'cz-ptier-lic', label: 'Licencia' }`.
- Card de cuota (L747): sacar `freeCard('gemini', …)`; usar `card('antigravity', metrics, reset)` con
  `metric('📨 Requests/día', null, sess + ' req', 'linear-gradient(90deg,#60A5FA,#34D9E0)')` + `metric('🔆 Semanal (plan)', pctOrNull, pctOrNull == null ? 'sin medir' : null, 'linear-gradient(90deg,#8AB4F8,#4285F4)')`
  y `reset = 'Licencia · cuota semanal medida en /providers · requests <span class="cz-est">estimados</span> (activity-log)'`.
- Copy (L466, L470, L555, L676, L751): ver §4.

### `views/dashboard/providers.js`
- `PROVIDER_ORDER`: `'gemini-google'` → `'antigravity'`.
- `PROVIDER_META['antigravity'] = { name: 'Antigravity', accent: '--provider-antigravity', tierKind: 'measured', disabledKey: 'antigravity', catalogKey: 'antigravity' }` — sin `tier`, sin `tierIcon` (U5, U7).
- `renderTierBadge`: `p.key === 'antigravity'` → `renderPlanBadge` (sin cambios de lógica).
- CSS `.prov-row[data-provider="antigravity"]` (las 4 reglas de #6564, L1325-1329).
- Comentario L517 («sólo gemini-google hoy») → `antigravity`.

### `views/dashboard/home.js`
- `.quota-exhausted-banner[data-provider="antigravity"]{ border-left-color: var(--provider-antigravity); }`
- `.quota-provider-chip[data-provider="antigravity"]{ color: var(--provider-antigravity-fg); background: var(--provider-antigravity-bg); border-color: var(--provider-antigravity); }`
- `.mz-now .active-card-prov[data-prov="antigravity"]::before { background: #60A5FA; }` (una sola regla; borrar las de `gemini` y `gemini-google`).
- Labels (L2932-2933, L4660-4661, L5722): `'antigravity': 'Antigravity'` — una sola clave, sin la ofuscación `Gemini`.
- Tooltips de gauge (L2661-2662): ver §4.
- L5722: `{ name: 'Antigravity', color: 'var(--provider-antigravity)', src: 'CLI' }` — el `src` deja de decir `API` (no hay endpoint HTTP, D6). L5735: `{ short: 'Sem', long: 'Semana' }` si la celda muestra la ventana semanal medida; si no hay dato, `n/d`.

### `views/dashboard/multi-provider-health.js`
- `PROVIDER_ORDER`: `'antigravity'` en el lugar de `'gemini-google'`.
- `providerAccentVar` (L286-291): **agregar** `if(p==='antigravity') return '--provider-antigravity';` (hoy el provider caía en `--provider-unknown`: bug latente que el rename destapa).
- `providerIcon` (L299): `if(p==='antigravity') return 'ic-provider-antigravity';`.

### `views/dashboard/multi-provider.js`
- `providerToken` (L489-499): agregar `if (p === 'antigravity') return '--provider-antigravity';` y limpiar el comentario que habla de `gemini-google/cerebras` cubiertos en #3326.

### Tests que acompañan
- `views/dashboard/__tests__/providers.test.js:240` → `'--provider-antigravity:'`.
- `tests/agy-catalog-probe-6857.test.js:496` → `key: 'antigravity', disabledKey: 'antigravity', name: 'Antigravity', accent: 'var(--provider-antigravity)'`.
- `views/dashboard/__tests__/costos.test.js`: `normProvider('gemini-google') === 'antigravity'`, `normProvider('antigravity') === 'antigravity'`, `PROVIDER_META['antigravity'].tier === 'LICENCIA'`, `TIER_CHIP.lic.label === 'Licencia'`.

## 4. Copy canónico (español, sin «Gemini» como nombre de provider)

| Dónde | Texto |
|---|---|
| `costos.js` `.cz-quotanote` (L751) | «Todos los proveedores tienen su techo. **Claude** (Plan Max), **Codex** (pago) y **Antigravity** (licencia) tienen cuota de plan; **Groq y Cerebras** corren en free tier con límites diarios de requests/tokens. Donde el proveedor no expone API de cuota, el valor es **estimado** desde el uso del activity-log.» |
| `costos.js` proyección (L466) | «El ritmo actual proyecta un cierre de mes dentro del tope configurado. Los free tier (Groq, Cerebras) y la licencia Antigravity absorben carga sin costo por token.» |
| `costos.js` (L465) | «… Casi todo el gasto se concentra en los proveedores pagos (Claude y Codex); free tier y licencia no suman costo por token. …» |
| `costos.js` sugerencia top skill (L470) | `free` → «Ya corre sin costo por token.» (aplica a `free: true` **y** a `antigravity`); resto → «Mirá si conviene derivarlo a un proveedor sin costo por token.» |
| `costos.js` (L555, L676) | «(los free tier, la licencia Antigravity y los deterministas suman $0)» / «Los `$0.00` son free tier, licencia o deterministas.» |
| `home.js` tooltips gauge (L2661-2662) | `session-antigravity`: «Licencia Antigravity: la ventana de 5 h se mide con `agy /usage`; sin medición fresca la celda queda en n/d.» · `week-antigravity`: «Licencia Antigravity: % semanal medido con `agy /usage` (bucket gemini-weekly); sin medición fresca la celda queda en n/d.» |
| `home.js` banner de cuota agotada | «Antigravity sin cuota hasta las HH:MM» + «La cadena sigue con el próximo proveedor. Ventana semanal del plan agotada.» |
| Alerta Telegram de health (`health-cron.js:856`) | Nombra «Antigravity» (no «Gemini», no «Google») |

Regla: **«Gemini» sólo puede aparecer dentro de un id de modelo** (`gemini-3.8-flash-…`) o en el nombre técnico
del bucket de `/usage` (`gemini-weekly`) citado en un tooltip. Nunca como nombre de proveedor.

## 5. Ajuste al comando de verificación de CA-7 (para no dar falso rojo)

CA-7 dice «screenshot … donde se lee `antigravity` y **no** aparece `gemini`». La columna CATÁLOGO de `/providers`
y la tarjeta de agente activo muestran ids de modelo `gemini-3.x-*`, que **se conservan** (D5 del arquitecto).
El check que corresponde es:

```bash
# En el HTML renderizado de /providers y /costos: 0 apariciones de "Gemini" como label, permitiendo ids de modelo
curl -s http://localhost:3200/providers | grep -oiE "\bGemini\b" | grep -v -iE "gemini-[0-9]" | wc -l   # → 0
curl -s http://localhost:3200/costos    | grep -oiE "\bGemini\b" | grep -v -iE "gemini-[0-9]" | wc -l   # → 0
# Ícono y token nuevos consumidos
grep -c "ic-provider-antigravity" .pipeline/views/dashboard/multi-provider-health.js   # ≥ 1
grep -c "provider-antigravity" .pipeline/views/dashboard/home.js .pipeline/views/dashboard/providers.js  # ≥ 1 cada uno
# Sin residuos del ícono/token viejo en runtime
rg -n "ic-provider-gemini|--provider-gemini|seg-gm|cz-pq-gm" .pipeline/views .pipeline/lib .pipeline/assets --glob '!**/mockups/**' --glob '!**/docs/**'   # → 0
```

Baseline medido hoy (18/09, dashboard vivo en `localhost:3200`): `/providers` = **32** apariciones de «Gemini», `/costos` = **12**. Tras el rename ambos deben dar 0 con el filtro de ids de modelo.

En `aprobacion`, UX compara el screenshot headless contra `dashboard-antigravity-rename.png` con el checklist de
`docs/pipeline/ux-visual-flow.md` (paleta, tipografía, espaciados, jerarquía, accesibilidad). El estado de salud
puede seguir en rojo por `cli_contract_mismatch` (#7343): no es defecto de este issue.

## 6. Fuera de alcance de UX en este issue

- Flip de `billing: free` en `agent-models.json` y membership de `FREE_PROVIDERS` (#7303 / #7338).
- Medir la ventana de 5 h del plan en `/costos` (hoy sólo se mide la semanal en `/providers`, #6564).
- Revocar la key residual de AI Studio (#7286).
