# UX — Criterios (definición) · issue #4778 · Dashboard product-aware

Split A de #4691 (Superficie A · Dashboard interno del pipeline). Historia con
**impacto visual acotado** al dashboard SSR JS en `.pipeline/` — scope
`area:pipeline` sin `app:*`. Assets producidos y entregados.

## Assets entregados (committeados en `agent/4778-ux-criterios`, pusheados a origin)

- `.pipeline/assets/mockups/36-dashboard-product-aware.svg`
  - Panel 1 · **Selector/switch de producto en header** (header-meta.js / nav-tabs.js):
    solo-vista, contexto global persistente, NO concede permisos del producto
    destino (CA-1.3 · SEC-1 · A01). Color de acento por producto (chip) para
    awareness anti cross-product.
  - Panel 2 · **Estado por producto aislado** (home/pipeline/kpis/bloqueados):
    cada card lee su waves/blocked/health del coordination-store namespaceado
    por `projectId`, sin mezclar datos (CA-1.4). Arranque/pausa delega en
    kernel-supervisor(projectId) — "el adaptador pide, el kernel ejecuta"
    (CA-1.5). Retro-compat: 1 producto → badge estático (CA-5.1).
  - Panel 3 · **GATE 2 filtrado por producto** (esperando-firma.js product-aware):
    bandeja muestra solo pendientes del producto activo; solo firmante declarado
    del producto firma; fail-closed sin auto-aprobación por timeout; firma no
    repudiable atada a `productId`+commit (CA-2.1 · CA-2.2 · SEC-2 · SEC-7).

- `.pipeline/assets/mockups/37-onboarding-wizard-descriptor.svg`
  - Wizard de 5 pasos (Identidad → Repositorios → Tablero+Skills → Entorno →
    Autoridad+firma) para alta de producto sin editar archivos a mano (CA-1.1 ·
    CA-5.2). Reusa patrón de wizard-ola.js / wizard-providers.js.
  - **Validación fail-closed** contra `project.schema.json` vía `validateDescriptor`
    (Ajv): input inválido → mensaje accionable inline, no se persiste; botón
    "Crear producto" deshabilitado hasta que TODO el schema valida (CA-1.1).
  - **SEC-6 (SSRF) visualizado**: campo de repo con host no permitido
    (`http://169.254.169.254/latest/meta-data`) rechazado inline con allowlist
    de host (github.com). Es exactamente el gap confirmado por security/guru.
  - **SEC-4**: secretos solo por referencia `ref://credentials/<key>`; la UI
    nunca acepta ni renderiza el valor crudo, ni en el JSON preview del panel
    lateral. Ver/editar descriptor reusa el mismo wizard precargado (CA-1.2).
  - **SEC-2**: paso de Autoridad advierte separación de deberes (agregarse como
    firmante queda auditado, requiere firma del respaldo).
  - Cierre → `POST /api/product/onboard` (CSRF/SameSite, sin GET con efecto · SEC-7).

## Guidelines visuales

- **Design system V3**: fondo `#0D1117`, superficies `#161B22`/`#1C2128`,
  bordes `#30363D`/`#21262D`, texto `#E6EDF3`/`#8B949E`, acento marca cyan
  `#00D6FF` + gradiente `#1890FF→#00D6FF`. Estados: éxito `#3FB950`, warning
  `#D29922`/`#E8770D`, peligro `#F85149`, púrpura `#BC8CFF`, teal `#2DD4BF`.
  El dev debe consumir estos como **design-tokens.css** (var(--surface-*),
  var(--brand-cyan), etc.), sin colores hardcoded en la implementación.
- **Color de acento por producto**: cada producto recibe un color de acento
  derivado y estable (chip + borde de card + punto en el switch) para dar
  awareness inmediato de "en qué producto estoy operando". Es una **defensa UX
  de SEC-1**: previene acciones cross-product por confusión visual. No sustituye
  el authz server-side (que nunca deriva del `productId` in-band).
- **Toda acción mutante** (arranque/pausa/firma/onboard) muestra el `productId`
  objetivo en el modal de confirmación. Sin confirmación silenciosa (SEC-7).
- **Accesibilidad WCAG AA**: todo par color/fondo verificado a contraste AA.
  Estados no dependen solo del color (íconos ●/⏸/▶/✓/✕ + texto de estado).
- **Retro-compatibilidad**: con 1 solo producto (Intrale) el switch se colapsa a
  un badge estático, sin cambio de flujo (CA-5.1); el path legacy mapea
  explícitamente al producto único con el mismo authz (SEC-9).

## Notas para el dev / QA visual

- Este issue tiene **diseño acordado** ⇒ la aceptación exige **QA visual
  (render vs mockup)**, no basta QA estructural. Comparar la implementación
  contra estos dos SVG.
- Los mockups son de **especificación** (no pixel-perfect): fijan layout,
  jerarquía, estados y semántica de color; el dev usa el design-system real.
- Los SVG son estáticos, sin código activo (sin `<script>` ni handlers on-event)
  — verificado.

## Simetría con PO / CLAUDE.md (fase aprobación futura)

Scope `area:pipeline` sin `app:*` ⇒ en fase `aprobacion` este issue puede caer
en "No requiere video E2E" (PASO 0.A del rol UX), evaluándose por
assets+mockups+código (render vs estos mockups) + QA structural. Igual exige
evidencia de QA. La decisión debe ser **simétrica con PO**.

---
_Producido por el agente `ux` en fase criterios (pipeline definición). Assets
reusados/consolidados del diseño de la historia madre #4691 (Superficie A), que
es exactamente el alcance de esta hija._
