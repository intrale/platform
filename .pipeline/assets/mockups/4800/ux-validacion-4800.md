Validación UX de readiness (fase pre-desarrollo, coherente con guru+po que
aprobaron "historia lista para desarrollo"). Scope: area:infra + enhancement +
size:medium, SIN ningún app:* → impacto visual acotado al dashboard interno V3
(onboarding-wizard.js, paso 2), no al producto del usuario final. Por CLAUDE.md
"Tipos de issue y criterio QA" (infra sin app:*) NO se exige video en esta fase;
evaluación por assets+mockups (PASO 2-bis del rol UX). Simetría con PO respetada.

## Verificación empírica de assets de criterios

Asset entregado por UX en fase criterios (comentario del issue):
`.pipeline/assets/mockups/42-onboarding-repo-provenance.svg`

$ ls -la .pipeline/assets/mockups/42-onboarding-repo-provenance.svg
-rw-r--r-- 12800 bytes  → EXISTE en el filesystem compartido del pipeline.

$ md5sum .pipeline/assets/mockups/42-onboarding-repo-provenance.svg
c8f60fd1f5cc85fab592777a0f0c6c17  (distinto del base 37 = 5c2155e5…, no es copia).

Contenido verificado (grep de <text>): mockup real y completo, NO placeholder:
- A · Segmented control role="radiogroup", default "Usar existente" (preserva
  CA-3, no rompe el flujo actual). Patrón correcto para 2 opciones binarias.
- B · Modo "Usar existente": input URL + Repo ID + Base ref + validación de
  acceso inline con nota anti-SSRF (cubre CA-2).
- C · Modo "Crear nuevo": Nombre + Org (allowlist) + Visibilidad (default private
  SIEMPRE, public exige toggle+confirmación) + Base ref (cubre CA-1 y requisitos
  de security).
- D · Estados de feedback fail-closed: D1 creando (submit deshabilitado, sin doble
  submit, token nunca visible), D2 éxito (URL auto-completada read-only), D3 error
  (no deja producto a medias, mensajes accionables) → cubre Gherkin #2.
- E · Guidelines WCAG AA: contraste >=4.5:1 verificado, estados no dependen solo
  del color (íconos + texto, daltonismo), touch targets >=34px, navegación por
  flechas, copy en español accionable no-técnico.

## Consistencia con el sistema de diseño (sin hardcodeo)

El mockup reusa tokens ya presentes en onboarding-wizard.js (verificado por grep):
- .ow-step-active (fondo --brand-cyan #00D6FF, texto #001b22) → base del segmento activo.
- --brand-cyan en focus-visible, botones primarios, links.
- ow-repo-url / ow-repo-id ya existentes → el modo "existente" preserva la UI actual.
No requiere iconografía ni assets de marca nuevos; cero colores fuera del sistema.

## Veredicto
Aprobado: la entrega visual de criterios está presente, es un diseño real y
coherente con la identidad del dashboard V3, cubre todos los CA funcionales,
de seguridad y de accesibilidad, y da al desarrollo referencia suficiente para
implementar el paso 2 del wizard. Sin defectos UX bloqueantes.

Observación NO bloqueante: el mockup 42 hoy está untracked en el working tree
(git status -> ??) — es el patrón normal de mockups en vuelo (42/43/44 y
subcarpetas por issue idem). El desarrollo debe commitearlo en la rama agent/4800
junto con la implementación para que quede en HEAD al mergear (como los mockups
01-41 ya trackeados). No frena la validación de readiness.
