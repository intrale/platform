# Fix Modelo V2 — Tracking de Avance

> Archivo de seguimiento para mantener contexto entre sesiones.
> Ultima actualizacion: 2026-03-28T16:00

## Estado general

Informe completo en: `docs/informe-migracion-v1-v2.md`
Diseño original en: `docs/pipeline-v2-diseno.md` + `docs/revision-hooks-v2.md` (seccion Commander V2)
Branch: `fix/pulpo-telegram-retry`

## Progreso por tarea

### Fase A — Circuito completo (Critica) — 3/4 COMPLETADOS

- [x] **A1** — Parser de comandos en Commander (`pulpo.js` brazoCommander)
  - 8 handlers nativos: /status, /actividad, /intake, /proponer, /pausar, /reanudar, /costos, /help, /stop
  - /proponer lanza Claude sincrono (2min timeout), guarda propuestas en commander-proposals.json
  - Texto libre se delega a Claude con ventana de 24hs de historial
  - Mensajes procesados individualmente

- [ ] **A2** — Seedear issues con labels en GitHub
  - PENDIENTE — requiere crear issues reales con labels `needs-definition` o `ready`

- [x] **A3** — Cleanup de worktrees en fase de entrega
  - brazoBarrido limpia worktrees al completar ultima fase
  - Pattern matching: `platform.agent-{issue}-*`, `git worktree remove --force`

- [x] **A4** — Fix timeout de build
  - setTimeout + child.kill() + clearTimeout en exit handler

### Fase B — Funcionalidad core (Alta) — 6/6 COMPLETADOS

- [x] **B1** — Persistencia de sesiones Commander
  - `commander-session.json`: context, lastCommand, lastTimestamp
  - loadSession()/saveSession() cada ciclo
  - Contexto pasado a Claude si sesion < 30min
  - Historial con ventana de 24hs (no lineas fijas)
  - Rotacion automatica cada hora (descarta > 24hs)

- [x] **B2** — Handler nativo `/status` — Cero tokens

- [x] **B3** — Handler nativo `/intake` — manual y forzado

- [x] **B4** — `/pausar` y `/reanudar` nativos

- [x] **B5** — Max retries en huerfanos (3, luego rechaza)

- [x] **B6** — Deteccion de procesos Windows (`tasklist`)

### Fase C — Ecosistema (Media) — 4/6 COMPLETADOS

- [x] **C1** — Rol `hotfix.md` + config (concurrencia:1, dev_skill_mapping por label priority:critical)

- [ ] **C2** — Division de historias en planner
  - PENDIENTE — sizing "grande" → crear sub-issues, re-entrar en criterios

- [ ] **C3** — `/costos` con tracking real de tokens
  - PARCIAL: handler lee logs y muestra stats basicas
  - Falta: parsear tokens reales del output de Claude

- [ ] **C4** — Servicio Drive — PENDIENTE (requiere Google credentials)

- [x] **C5** — Rate limiting GitHub API (2s entre calls)

- [x] **C6** — Envio de documentos/imagenes en servicio-telegram (multipart real)

### Extras completados (no estaban en plan original)

- [x] sendTelegram() migrado de spawnSync hack a encolado fire-and-forget via servicio
- [x] /proponer implementado con agente Claude sincrono + proposals file
- [x] Rotacion de historial commander-history.jsonl (> 24hs se descarta)
- [x] Ventana de historial cambiada de "ultimas N lineas" a "ultimas 24hs"
- [x] Rol cua descartado — qa.md ya incluye video/evidencia

## Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `.pipeline/pulpo.js` | 816→1185 lineas (+369): handlers, session, timeout, Windows, retries, worktree cleanup, rate limit, rotacion, proponer |
| `.pipeline/servicio-telegram.js` | 107→162 lineas: multipart upload documentos y fotos |
| `.pipeline/roles/hotfix.md` | NUEVO: 30 lineas |
| `.pipeline/config.yaml` | hotfix en concurrencia + dev_skill_mapping |
| `docs/informe-migracion-v1-v2.md` | Informe completo de gaps V1→V2 |
| `docs/fixmodelov2.md` | Este tracking |

## Verificacion

- `node -c .pipeline/pulpo.js` — OK
- `node -c .pipeline/servicio-telegram.js` — OK
- Estructura de carpetas pipeline completa (procesado/ en cada fase)

## Bugs encontrados y corregidos durante testing

1. **Commander no procesaba /reanudar estando pausado** — brazoCommander estaba dentro del `if (!paused)`. Fix: moverlo afuera.
2. **Historial usaba ventana por cantidad** — Cambiado a ventana de 24hs segun diseno.
3. **/proponer no tenia handler** — Implementado con Claude sincrono + proposals file.

## Testing completado (2026-03-28)

Evidencia completa en: `docs/evidencia-test-v2.md`

| Comando | Resultado |
|---------|-----------|
| /status | PASS — respuesta nativa, 0 tokens |
| /pausar | PASS — crea .paused, Pulpo se pausa |
| /reanudar | PASS — funciona estando pausado |
| /help | PASS — lista completa de comandos |
| /actividad | PASS — timeline con filtro 24hs |
| /costos | PASS — stats basicas de logs |

## Pendiente

1. **A2**: Crear issues de prueba en GitHub para test E2E del circuito
2. **C2**: Division de historias grandes en planner (sizing "grande")
3. **C3**: Tracking real de tokens
4. **C4**: Servicio Drive (Google credentials)
5. Tests pendientes: /intake real, /proponer, audio, imagenes, pipeline E2E
