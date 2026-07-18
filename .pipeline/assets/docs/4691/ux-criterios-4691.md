# UX — Criterios de diseño · #4691 (Ola Puente P6 · gestión desde interfaz)

Scope: `area:pipeline` (dashboard interno + backend/contrato móvil + Telegram).
Sin labels `app:*` → superficie visual = **dashboard interno del pipeline** (SSR
JS en `.pipeline/`). Las otras dos superficies (API/contrato móvil, Telegram) no
tienen UI propia en esta ola: se cubren con guidelines textuales.

## Entregables producidos (esta fase)

- `.pipeline/assets/mockups/36-dashboard-product-aware.svg` — switch de producto
  en header (solo-vista), estado por producto aislado, GATE 2 filtrado por producto.
- `.pipeline/assets/mockups/37-onboarding-wizard-descriptor.svg` — wizard de alta
  del descriptor (5 pasos), validación fail-closed, secretos por referencia, SSRF allowlist.
- Este doc de guidelines.

Sistema visual: reusa `design-tokens.css` (paleta navy/cyan, surfaces 0–3,
success/warning/danger, radios, spacing) + `icons/sprite.svg`. Zero CDN, WCAG AA,
SVG sin código activo (README `.pipeline/assets/`).

## Superficie A · Dashboard product-aware

### Switch de producto (header)
- Control **global persistente** en el header (`header-meta.js`/`nav-tabs.js`),
  visible en todas las tabs. Un solo punto de contexto → reprograma
  estado/pipeline/KPIs/firma al `productId` elegido (CA-1.3).
- **Color de acento por producto** (chip de 1 color derivado): defensa UX de
  SEC-1 → el operador siempre ve "en qué producto opera", evita acción
  cross-product por confusión.
- El switch es **solo-vista**: no concede permisos del producto destino (SEC-1).
- **Retro-compat (CA-5.1):** con 1 solo producto el switch se colapsa a un badge
  estático. Sin cambio de flujo para el modo Intrale actual.

### Estado por producto (CA-1.4 / CA-1.5)
- Cada producto = una card con su propio waves/blocked/health leído del
  coordination-store namespaceado por `projectId`. Nunca mezclar datos.
- Card de producto pausado se muestra atenuada, con acción **▶ Arrancar**;
  producto activo con **⏸ Pausar**. La acción delega en
  `kernel-supervisor(projectId)` — "el adaptador pide, el kernel ejecuta".
- **Todo modal de confirmación de acción mutante muestra el `productId` objetivo**
  explícito (nunca confirmación silenciosa). CSRF/SameSite (SEC-7).

### GATE 2 por producto (CA-2.1 / CA-2.2 / SEC-2)
- Bandeja (`esperando-firma.js`) filtra por producto seleccionado. Banner de
  contexto: "Firmando en: <producto>" + firmantes declarados.
- Fila con badge `productId` visible. Advertencia roja cuando el PR cambia
  `authority` (separación de deberes): botón **Firmar bloqueado** para el
  beneficiario, requiere el respaldo.
- Invariantes preservados y visibles: fail-closed, sin auto-aprobación por
  timeout, firma no repudiable (quién/commit-PR/cuándo/`productId`).

### Wizard de onboarding (CA-1.1 / CA-1.2)
- 5 pasos (Identidad → Repos → Tablero+Skills → Env → Autoridad+firma), reusa
  patrón `wizard-ola.js`/`wizard-providers.js`.
- **Validación inline por campo, fail-closed:** input inválido → mensaje
  accionable + no persiste. Botón "Crear producto" deshabilitado hasta que el
  schema valida entero (Ajv contra `contracts/project.schema.json`).
- **Secretos por referencia (SEC-4):** env se ingresa/muestra como
  `ref://credentials/<key>`. La UI nunca acepta ni renderiza el valor crudo.
- **SSRF allowlist (SEC-6):** URL de repo con host fuera de allowlist → error
  inline, no avanza. Editar descriptor existente reusa el mismo wizard precargado.

## Superficie B · API de gestión + contrato móvil (guidelines, sin UI)
- No se construye la app (§9.4). El contrato debe dejar previsto para el MVP
  móvil futuro: **paridad de bolsillo** con el dashboard (firmar, aprobar/rechazar,
  alta de proyecto, estado por producto).
- La proyección remota (read-model) debe entregar campos suficientes para
  renderizar estado por producto sin exponer secretos/env/internals de autoridad
  (SEC-5). UX del cliente móvil se define en la ola del MVP.

## Superficie C · Telegram Commander product-aware (guidelines)
- Consistencia con `feedback_telegram-messages-natural.md`: respuestas naturales,
  variadas, contextuales — pero **siempre nombrando el producto** sobre el que se
  opera ("Pausé Comercios-AR", no "Pausé el pipeline").
- Acciones destructivas → **confirmación explícita** antes de ejecutar (reusar
  `destructive-cooldown.js`), con el `productId` en el texto de confirmación (CA-4.3).
- Si el chat-id no está autorizado para ese producto → mensaje claro de rechazo,
  sin filtrar existencia/estado de productos ajenos (SEC-1/SEC-3).

## Accesibilidad / consistencia
- WCAG AA en todo par color/fondo (tokens ya cumplen). Touch/click targets ≥40px.
- No usar solo color para transmitir estado: acompañar con ícono/texto
  (● active / ⏸ paused / ✓ firmable / ✕ bloqueado) — daltonismo-safe.
- Un solo lenguaje visual con el resto del dashboard (mismos tokens/iconos).

## Veredicto UX (criterios)
Aprobado con assets entregados. La historia tiene impacto visual acotado a la
Superficie A; los mockups 36 y 37 son la especificación visual que consume
`pipeline-dev` en fase dev. Sin oportunidades de mejora que ameriten issue
independiente (los gaps del diseño ya están trackeados en la Ola Puente).
