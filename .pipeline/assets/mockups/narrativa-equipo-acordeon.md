# Narrativa UX — Equipo, acordeón por skill con agentes individuales (EP8-H2 · #3955)

> Guidelines UX + microcopy + iconografía + dual-encoding + tabla de contrastes
> WCAG AA + requisitos de seguridad visibles + mapa de CAs de la ventana Equipo.
> Mockup de referencia: `37-equipo-acordeon-agentes-v3.svg`.
> Generar `narrativa-equipo-acordeon.mp3` en fase `dev` (voz `es-AR-ElenaNeural`).

## Contexto

Hoy la ventana **Equipo** (`renderEquipoSsr` / `eqAreaGrid` en
`.pipeline/views/dashboard/equipo.js`) muestra un grid 2×2 de áreas con **chips
compactos por skill** y un badge `×N` cuando hay más de un agente corriendo. El
operador ve que un skill está ocupado, pero **no ve cuál issue, en qué fase, ni
cuánto progreso** lleva cada agente, y **no puede actuar por agente individual**.

EP8-H2 evoluciona ese grid a un **acordeón por skill**: cada card de skill se
expande mostrando sus agentes vivos con detalle inline, sparkline de carga 24 h,
y kill por agente con preview + confirmación. El Commander es un caso especial
no cancelable. Los cooldowns por fast-fail muestran una cuenta regresiva.

El grueso de los datos ya existe en `/api/dash/active` (validado por `guru`); el
único dato nuevo es el sparkline 24 h (derivado de mtimes de `procesado/`).

## Anatomía visual de la card de skill (acordeón)

Cada skill es una card colapsable. Dos estados:

**Colapsada** (skill sin agentes vivos, o plegada por el operador):
- chevron `›` (apunta a la derecha), avatar circular con inicial + color de
  persona, nombre del skill, contador `N vivos` (o vacío si 0).
- sparkline 24 h compacto a la derecha.

**Expandida** (skill con ≥1 agente vivo, o desplegada por click):
- chevron `▾` (apunta abajo), cabecera con avatar + nombre + tagline + contador.
- sparkline 24 h a la derecha de la cabecera.
- divisor sutil, y debajo **una fila por agente vivo**.

La expansión/colapso **persiste** vía el patrón `toggleSection` + `sessionStorage`
ya usado en el dashboard (no recrear estado nuevo).

### Fila de agente (CA-1)

Cada agente vivo se renderiza como una fila inline con, en este orden:

1. **Issue** — `#3964` en color `info` (`#58A6FF`), peso 700.
2. **Fase** — pill con color semántico de la fase (`dev`/`verificacion`/etc.).
3. **Título del issue** — texto secundario. **Atacante-controlable → escapar
   (SEC-5)** con `escapeHtmlText`.
4. **Progreso %** — barra + número. `progreso = min(100, durationMs/etaMs*100)`.
   Si falta `etaMs` → `progreso = 0` y barra indeterminada (no `NaN`).
5. **Duración** — reloj + `fmtDur(durationMs)` (ej. `8m 12s`).
6. **Log** — ícono `ic-live-tail` + label `log`, enlace al visor con
   `safeLogHref` (whitelist de prefijo + `encodeURIComponent`).
7. **Cancelar** — botón rojo tenue con `ic-revoke` + `cancelar` (salvo
   observacional/commander).

## Interacciones

### CA-2 · Kill con preview y confirmación

El botón `cancelar` de cada fila abre `inConfirm()` (componente existente,
`confirm-modal.js`) con un `preview[]` que **debe incluir**:

| Campo            | Valor de ejemplo | Origen                  |
|------------------|------------------|-------------------------|
| Skill            | `android-dev`    | `a.skill`               |
| Issue            | `#3964`          | `a.issue`               |
| Fase             | `dev`            | `a.fase`                |
| Tiempo invertido | `8m 12s`         | `fmtDur(a.durationMs)`  |

- Microcopy del cuerpo: *"Se cancelará el agente en curso. Esta acción no se
  puede deshacer."* (la segunda frase en color `danger`).
- Botones: **"Mantener vivo"** (secundario, outline) / **"Cancelar agente"**
  (destructivo, `danger` sólido). El destructivo nunca es el default focuseado.
- La acción sólo se ejecuta tras confirmación explícita.
- El POST viaja **same-origin con token CSRF** (SEC-2) en **todos** los call
  sites del kill (vista Equipo + vista Issues). Sin token válido → 403.

### CA-3 · Commander no cancelable

- El Commander (o cualquier skill `cancelable === false || observational === true`)
  se muestra **visible** en el acordeón, con borde/acento `purple` y badge
  `ic-shield-lock` + "skill no cancelable".
- En lugar del botón de kill, una pastilla deshabilitada con candado +
  "protegido", y la pill `👁 observa — no ocupa slot ni se puede cancelar`.
- **Enforcement server-side (SEC-3)**: aunque la UI oculte el botón, el endpoint
  `/api/kill-agent` rechaza `skill === 'commander'` (y no-cancelables) con **403**.
  La UI nunca es la única defensa.

### CA-4 · Cooldown con cuenta regresiva

- Un agente con cooldown activo por fast-fail muestra una pill ámbar
  (`ic-ttl-countdown` + `cooldown MM:SS · N fallos`).
- El botón de acción se muestra **"en espera"** (deshabilitado) mientras el
  contador corre.
- **Fuente server-authoritative (SEC-6)**: el estado viene de `cooldowns.json`
  (`{failures, cooldownUntil}`) expuesto en `/api/dash/active`. El front **sólo
  muestra** la cuenta regresiva; **no habilita acciones por su cuenta** cuando el
  contador local llega a 0 — re-consulta al server.

### CA-5 · Sparkline de carga 24 h

- Mini gráfico de barras horarias (24 columnas) a la derecha de la cabecera de
  cada skill.
- Barras de las horas recientes resaltadas en `info` (`#58A6FF`); el resto en
  `info-dim` (`#1F6FEB`). Cooldown/fallos pueden teñirse en `retry` (`#F59E0B`).
- **Fuente del dato (documentar en el PR)**: derivar de los `mtime` de los
  archivos en `procesado/` por ventana horaria (preferido, sin proceso de
  muestreo nuevo). Patrón de referencia: `skillHistoryStrip` en `equipo.js:48`.

## Iconografía (sprite real — sin íconos nuevos en este issue)

| Uso                          | Símbolo sprite      | Color token        |
|------------------------------|---------------------|--------------------|
| Expandir / colapsar          | `ic-expand` / `ic-collapse` | `text-secondary` |
| Cancelar agente              | `ic-revoke`         | `danger`           |
| No cancelable / protegido    | `ic-shield-lock`    | `purple`           |
| Cooldown / cuenta regresiva  | `ic-ttl-countdown`  | `retry`            |
| Log en vivo                  | `ic-live-tail`      | `teal`             |
| Presencia observacional      | `ic-eye-on`         | `purple`           |
| Popout ventana               | `ic-link-out`       | `text-dim`         |

> No se crean símbolos nuevos: todos existen en
> `.pipeline/assets/icons/sprite.svg`. Si el dev necesitara uno, debe agregarlo
> al sprite y documentarlo, no inline-armarlo en el HTML.

## Dual-encoding (regla inquebrantable WCAG)

Toda información de estado va con **icono + texto/forma, nunca sólo color**:

- Cooldown → borde ámbar **+ reloj + texto `cooldown 02:14`**.
- Commander → borde/acento purple **+ candado + texto `protegido` / `no cancelable`**.
- Kill destructivo → color danger **+ ícono cruz + label `cancelar`**.
- Progreso → barra **+ número `64%`** (nunca sólo la barra).

## Tabla de contrastes WCAG AA (sobre `surface-2` #1C2128)

| Elemento              | Color    | Ratio   | Nivel |
|-----------------------|----------|---------|-------|
| % progreso            | `#79C0FF`| 7.1:1   | AA    |
| Cooldown ámbar        | `#F5B454`| 6.9:1   | AA    |
| Danger (cancelar)     | `#FF7B72`| 5.4:1   | AA    |
| Commander purple      | `#C9B6FF`| 7.6:1   | AA    |
| Texto dim/timestamps  | `#8B949E`| 4.6:1   | AA    |

Todos ≥ 4.5:1 (texto normal). Iconos y texto grande cumplen ≥ 3:1 holgado.
Verificar con WebAIM Contrast Checker antes de cerrar el PR.

## Microcopy (es-AR, tono operativo y claro)

- Modal título: **"Cancelar agente"**.
- Modal cuerpo: *"Se cancelará el agente en curso. Esta acción no se puede
  deshacer."*
- Cooldown: *"cooldown MM:SS · N fallos"* + *"re-lanzamiento bloqueado por el
  server"*.
- Commander: *"observa — no ocupa slot ni se puede cancelar"* / badge *"skill no
  cancelable"* / botón *"protegido"*.
- Botones del modal: *"Mantener vivo"* (no destructivo) / *"Cancelar agente"*
  (destructivo).
- Nota de seguridad en el modal (opcional, secundaria): *"petición same-origin
  con token CSRF — el server valida"*.

## Requisitos de seguridad visibles en la UI (SEC-1..6)

| Req   | Qué cambia en la UX                                                        |
|-------|---------------------------------------------------------------------------|
| SEC-1 | Errores 400 de input inválido se muestran como toast claro, no crash.     |
| SEC-2 | El kill envía token CSRF; un 403 muestra toast "sesión inválida, recargá".|
| SEC-3 | Commander nunca expone botón de kill; un 403 del server es el backstop.   |
| SEC-4 | El log inline llega **redactado** (secrets enmascarados) + tail acotado.  |
| SEC-5 | Títulos de issue escapados antes de inyectar en DOM (acordeón + modal).   |
| SEC-6 | La cuenta regresiva de cooldown la dicta el server; la UI sólo la pinta.  |

SEC-1, SEC-2 y SEC-3 son **bloqueantes** para el merge (verificables en fase de
verificación).

## Mapa de CAs ↔ archivos (para el dev)

| CA    | Dónde se implementa                                                       |
|-------|---------------------------------------------------------------------------|
| CA-1  | `equipo.js` (acordeón + filas) — payload `/api/dash/active` `dashboard.js:3041` |
| CA-2  | `home.js` `killAgent()` (~1546) — extender `preview[]` con fase + tiempo  |
| CA-3  | `home.js` (front oculta kill) + `dashboard.js:10131` guard 403 server     |
| CA-4  | `cooldowns.json` (pulpo.js:1386+) → payload `/api/dash/active` → render front |
| CA-5  | `equipo.js` sparkline desde mtimes de `procesado/` por ventana horaria    |

## Reglas inquebrantables

1. **No inventar íconos**: usar el sprite real; si falta uno, agregarlo al sprite.
2. **Dual-encoding siempre**: ningún estado comunicado sólo por color.
3. **Escape disciplinado (SEC-5)**: todo dato dinámico por `escapeHtmlText` /
   `escapeHtmlAttr`; cubrir con test XSS el modal y el acordeón.
4. **El front nunca es la única defensa**: commander/cooldown/CSRF se validan en
   el server; la UI sólo refleja.
5. **Persistencia de estado del acordeón** con el patrón existente, sin estado
   nuevo paralelo.
6. **Progreso sin `etaMs` → 0 + barra indeterminada**, nunca `NaN`.
