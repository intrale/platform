# Narrativa UX — EP8-H7 (#3960): Ops → topología de servicios con log inline y restart auditado

> Guidelines de experiencia, microcopy, iconografía, dual-encoding y tabla de
> contrastes WCAG AA de la ventana **Ops** rediseñada. Referencia visual:
> `36-ops-topologia-v3.svg`. La implementa `pipeline-dev` sobre
> `.pipeline/views/dashboard/ops.js` + `.pipeline/dashboard.js`.
> Generar `narrativa-ops-topologia.mp3` (voz `es-AR-ElenaNeural`) en fase `dev`.

---

## 1. El problema que resuelve el rediseño

La ventana Ops actual (ver `actual-ops.png`) es un **grid plano de cards de
procesos** sin jerarquía: pulpo, listener, svc-telegram, svc-github, svc-drive,
svc-reconciler, outbox-drain y dashboard aparecen todos al mismo nivel, sin
mostrar quién depende de quién. Cuando un servicio cae, el operador ve un punto
rojo pero **no sabe desde cuándo, por qué, ni cuántas veces** pasó — y para
reiniciarlo tiene que ir a la terminal. El log no está a la vista.

El rediseño convierte Ops en un **panel de control operativo**: una topología
jerárquica donde cada nodo cuenta su salud y su historia, con el log en vivo y
el botón de restart a un click (confirmado y auditado).

---

## 2. Anatomía de la pantalla (de arriba hacia abajo, de izquierda a derecha)

### 2.1 Header de identidad global
Barra `surface-1` con el logo Intrale (punto `brand-cyan→brand-blue` + núcleo
verde de salud global), el título contextual **"Ops · topología de servicios"**,
el sello **"actualizado hace 3 s"** (verde, refrescado por el polling existente)
y las nav-tabs a la derecha con **Ops** resaltado (pill `info-bg` + borde
`info-dim`). Coherente con el header redesign del sistema (mockup 18, EP8-H0).

### 2.2 Panel TOPOLOGÍA (columna izquierda, lo central)
Grafo jerárquico con conectores `border`:

```
              pulpo            <- raíz / orquestador
       ________|________
      |     |      |     |
 listener  svc-   svc-   svc-   <- capa de servicios
   -tg     drive  github emul.
```

- **Nodo sano**: card `surface-2`, punto verde `success`, nombre `text-primary`,
  meta `PID 9512 · 2 d 4 h` en `text-dim` (el "desde cuándo" = uptime, CA-1).
- **Nodo caído**: card con **fondo `danger-bg` + borde `danger`** (dual-encoding:
  no solo el punto), ícono `ic-health-dead` (cruz en círculo) en vez del punto, y
  label **"caído hace 41 m"** en `danger`. El borde rojo hace que el ojo lo
  encuentre de inmediato en una pantalla de kiosko a 3 m.
- **Click en un nodo** → lo selecciona y abre debajo el **panel de detalle**.

### 2.3 Panel de detalle del nodo seleccionado (CA-1 + CA-2 + CA-3)
Aparece dentro del panel Topología, ancho completo, fondo `surface-0`:

- **Título**: ícono `ic-live-tail` + `SVC-DRIVE · LOG EN VIVO (SSE) + HISTORIAL`.
- **Log inline** (CA-2): 2–N líneas monoespaciadas, solo lectura, con **follow
  automático** (auto-scroll al pie). Timestamp en `text-dim`, niveles con color
  (`ERROR`→`danger`, prefijo de servicio en `text-dim`). Reusa el SSE existente
  `GET /logs/stream/:file`. **Lazy-open**: el `EventSource` se abre SOLO al
  expandir el nodo y se cierra al colapsar/cambiar de nodo (evita reventar el
  límite de ~6 conexiones HTTP/1.1 del browser — recomendación de guru).
- **Historial de transiciones** (CA-1): ícono `ic-transition-history` +
  `caídas 7 d: 2 (ECONNRESET ×2)`. El **último error completo** se muestra al
  hover (tooltip `title=`) y en la bandeja del Home — nunca truncado a medias.
- **Botón Restart** (CA-3): pill `info-bg` + borde `info-dim`, ícono `ic-restart`
  + `Restart (confirma + audita)`. Al click → `confirm-modal.js` (EP8-H0). Tras
  confirmar, ejecuta **stop+start aislado** del componente (NO el killAll global
  de restart.js) y registra el evento en el audit JSONL.

### 2.4 Panel RECONCILER (columna derecha, arriba) — CA-4
- **Número grande** `147` (`text-primary`, peso 800) = stale orders 24 h.
- **Breakdown por motivo**: barras horizontales con color semántico distinto por
  motivo (duplicado `info`/azul, timeout `warning`/amber, validación `danger`/
  rojo) + valor numérico a la derecha. El color nunca es la única señal: cada
  barra tiene su label de texto a la izquierda.
- **Serie temporal 7 d** (sparkline): tendencia del total, ámbar. Persistir el
  histórico siguiendo el patrón `metrics-history.jsonl`.

### 2.5 Panel QA ENVIRONMENT (columna derecha, abajo)
Reemplaza las mini-cards verbosas por **pills compactas** con dual-encoding
(ícono `ic-ok`/check verde o `ic-health-dead`/cruz roja + texto): `emulador ✓`,
`backend ✓`, `infra ✓`, `drive ✗`. Una nota recuerda que la alerta de `drive`
también vive en la bandeja del Home con su "desde cuándo" y último error
completo (coherencia cross-panel, no duplicación de fuente de verdad).

### 2.6 Leyenda permanente (franja inferior)
Explicita el contrato de **dual-encoding**: cada estado se comunica por
**color + forma + texto**, nunca solo por color. Útil para daltonismo y kiosko.

---

## 3. Iconografía (sprite real `.pipeline/assets/icons/sprite.svg`)

| Símbolo                    | Uso                                                | Estado |
|----------------------------|----------------------------------------------------|--------|
| `ic-health-ok`             | Nodo sano (alternativa al punto verde)             | existía |
| `ic-health-warn`           | Nodo degradado / reintentando                      | existía |
| `ic-health-dead`           | Nodo caído (cruz en círculo, refuerza el rojo)     | **NUEVO** |
| `ic-live-tail`             | Log en vivo SSE con follow (ondas emitiendo)       | **NUEVO** |
| `ic-transition-history`    | Historial vivo↔muerto con causa (reloj + retroceso)| **NUEVO** |
| `ic-restart`               | Acción restart por nodo (flecha circular)          | **NUEVO** |
| `ic-ok` / `ic-bad`         | Pills de QA environment (check / cruz)             | existía |

`ic-restart` es deliberadamente distinto de `ic-renew` (renovar API key) y
`ic-reset-default` (volver a valores de fábrica): aquí significa **relanzar un
proceso**.

---

## 4. Microcopy (reglas de copy)

- **"desde cuándo", no timestamps crudos en el resumen**: `caído hace 41 m`,
  `PID 9512 · 2 d 4 h`. El timestamp absoluto va en el tooltip/log, no en el
  titular (más legible para el operador de un vistazo).
- **Causa siempre con el conteo**: `caídas 7 d: 2 (ECONNRESET ×2)` — el motivo
  agrupado dice más que "2 caídas".
- **Botón con su consecuencia explícita**: `Restart (confirma + audita)` —
  el usuario sabe que hay un paso de confirmación y que queda registrado quién
  lo pidió. No usar solo "Restart".
- **Confirm-modal**: título "¿Reiniciar svc-drive?", cuerpo "Se detiene y vuelve
  a levantar solo este servicio. Queda registrado en el audit." + botones
  "Cancelar" / "Reiniciar". Nunca un restart silencioso de un click.
- **Tono**: español rioplatense neutro, directo, sin jerga técnica innecesaria
  en los titulares (el detalle técnico vive en el log y el tooltip).

---

## 5. Dual-encoding y accesibilidad (WCAG AA — regla inquebrantable)

Ningún estado se comunica **solo por color**. Tabla de refuerzos:

| Estado        | Color        | Forma / ícono        | Texto                  |
|---------------|--------------|----------------------|------------------------|
| Nodo vivo     | `success`    | punto lleno          | `PID … · uptime`       |
| Nodo caído    | `danger`     | borde rojo + cruz    | `caído hace 41 m`      |
| Reintentando  | `warning`    | `ic-health-warn`     | `reintentando…`        |
| Log ERROR     | `danger`     | prefijo `[svc]`      | línea completa         |
| QA ok         | `success`    | check `ic-ok`        | nombre + `✓`           |
| QA fail       | `danger`     | cruz `ic-health-dead`| nombre + `✗`           |

### Tabla de contrastes (sobre los fondos del sistema)

| Texto / token        | Fondo        | Ratio   | WCAG AA |
|----------------------|--------------|---------|---------|
| `text-primary` #E6EDF3 | `surface-0` #0D1117 | 14.8:1 | ✅ AAA |
| `text-secondary` #B1BAC4 | `surface-0` | 9.7:1 | ✅ AAA |
| `text-dim` #8B949E | `surface-0` | 5.3:1 | ✅ AA |
| `success` #3FB950 | `surface-1` #161B22 | 5.4:1 | ✅ AA |
| `danger` #F85149 | `surface-1` | 4.8:1 | ✅ AA |
| `warning` #D29922 | `surface-1` | 5.6:1 | ✅ AA |
| `info` #58A6FF | `surface-1` | 6.0:1 | ✅ AA |

(Tokens validados en `design-tokens.css` / WebAIM Contrast Checker.)

---

## 6. Seguridad visible en la UX (alineado con el análisis security)

La UX no es ajena a los REQ-SEC: varios tienen manifestación en pantalla y el
dev debe respetarlos al implementar este mockup.

- **REQ-SEC-H7-1** — el log inline y el "último error" pasan por `sanitizer.js`
  en el servidor ANTES de llegar al browser: el operador **nunca** ve un secret
  crudo; en su lugar ve `[REDACTED:aws-key]`. Es parte del diseño, no un detalle.
- **REQ-SEC-H7-2/3** — el botón Restart actúa sobre una **allowlist** de
  componentes conocidos y hace stop+start **aislado**. La UX refuerza esto con el
  copy "solo este servicio" en el confirm-modal: un click de UI no puede tumbar
  todo el pipeline.
- **REQ-SEC-H7-4** — el audit registra `source` (`dashboard-ui`/`telegram`) como
  atestación declarativa + timestamp objetivo. La UX no debe presentar `source`
  como identidad verificada (sin auth no lo es); mostrarlo como "pedido desde:
  dashboard" sin avatar/credencial.
- **REQ-SEC-H7-5** — tras un restart, deshabilitar el botón unos segundos
  (estado "reiniciando…") para evitar el doble-click / bucle de restart.

---

## 7. Mapeo a criterios de aceptación

| CA del issue | Cómo lo cubre el rediseño |
|--------------|---------------------------|
| CA-1 "desde cuándo" + último error completo | uptime en cada nodo + label "caído hace…" + `ic-transition-history` con `caídas 7 d: N (causa ×N)` + último error completo en tooltip/Home |
| CA-2 log inline read-only + follow auto | panel de log SSE con auto-scroll, lazy-open del nodo seleccionado |
| CA-3 restart por servicio + audit de quién lo pidió | botón `ic-restart` "Restart (confirma + audita)" → confirm-modal → stop+start aislado → audit JSONL |
| CA-4 reconciler breakdown + serie temporal | panel Reconciler con barras por motivo (color+texto) + sparkline 7 d |

---

## 8. Reglas inquebrantables para el dev

1. **Reusar, no reinventar**: el SSE (`/logs/stream/:file`), el control de
   procesos (`/api/action`) y el confirm-modal ya existen. El trabajo nuevo es
   el grafo, el historial de transiciones persistido y el audit del restart.
2. **Lazy-open del SSE** por nodo — jamás N EventSource abiertos a la vez.
3. **Restart aislado** — nunca gatillar el killAll/smoke/rollback global de
   restart.js desde un click de la UI.
4. **Dual-encoding siempre** — todo estado con color + forma + texto.
5. **Sanitizar antes de renderizar** todo texto runtime (log, último error,
   motivo de transición) — `sanitizeRuntime()` ya está en `ops.js`.
6. **Render inerte visible** si el state falla (REQ-SEC-7): "Ventana Ops no
   disponible", nunca string vacío.
