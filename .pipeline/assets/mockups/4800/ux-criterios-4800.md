Impacto visual acotado al dashboard interno V3 (onboarding-wizard.js, paso 2),
no al producto de usuario final (area:infra, sin app:*). No se requiere iconografía
ni assets de marca nuevos: el wizard ya tiene sistema de diseño consolidado (tokens
.ow-*, brand-cyan #00D6FF, tema oscuro). El aporte UX es diseño de interacción.

Entregables:
- Mockup de referencia: .pipeline/assets/mockups/42-onboarding-repo-provenance.svg
  (12.6KB, extiende el 37-onboarding-wizard-descriptor.svg). Muestra: segmented
  control "Usar existente / Crear nuevo", campos condicionales por modo, toggle de
  visibilidad private-default, y los 4 estados de feedback (verificando/creando/
  exito/error) sobre #ow-result.
- Guidelines + 6 criterios de aceptacion visuales (CA-UX-1..6) publicados como
  comentario en el issue: issue 4800 comment 5018587857

Decisiones autoritativas: segmented control (no dropdown); default seguro "Usar
existente" (CA-3 preserva flujo actual); visibilidad private SIEMPRE con warning
visible al elegir public (security A02/A05); org como select allowlist (security
A01); feedback fail-closed con aria-live, iconos+texto (no solo color), sin token
ni stderr crudo de gh en la UI.

Scope QA (para fase aprobacion): area:infra sin app:* => NO requiere video E2E por
CLAUDE.md; evaluacion UX por assets+mockup+code review (PASO 2-bis), simetrico con PO.

Nota operativa: no se commiteo el mockup — el checkout corre en branch agent/4766
(de otro issue); se dejo el SVG en assets/mockups/ como referencia aditiva, igual
que guru/security dejaron su analisis por comentario en esta fase de definicion.
