# 🏷️ Ownership de labels `qa:*`

Los labels `qa:*` son un concepto de **gobernanza de calidad**, distinto de los
Status del tablero (módulo `15-qa-status-names.md`). Controlan el **gate de QA**
previo al merge definido en `CLAUDE.md`. Esta tabla fija **quién** puede aplicar
cada label y **bajo qué autorización** (control de integridad de proceso).

| Label | Lo aplica | Cuándo | Autorización |
|-------|-----------|--------|--------------|
| `qa:passed` | **solo** el agente `/qa` | E2E ejecutado con evidencia de video OK | **Exclusivo de `/qa`**. Ningún otro rol puede aplicarlo (evita auto-aprobación de código sin E2E). |
| `qa:skipped` | un **Dev** | cambio de infra/hooks sin impacto en producto de usuario | **Único label auto-asignable por un Dev**, **exige justificación escrita**. Es el **único punto de bypass** del gate. Usarlo sin justificación es **violación de proceso**. |
| `qa:failed` | el agente `/qa` | defecto detectado durante el E2E | Lo aplica `/qa` al reportar el defecto; dispara corrección + reejecución del ciclo. |
| `qa:pending` | intake / default | estado inicial al admitir el issue | **Nunca mergear** con este label presente. |

Reglas duras:
- `qa:passed` y `qa:skipped` son **mutuamente excluyentes** y son los **únicos**
  labels que habilitan merge a `main`.
- `qa:skipped` siempre acompañado de justificación escrita (ej.: *"Cambio de
  pipeline infra/docs, sin UI ni endpoint de producto afectado."*).
- Ningún rol distinto de `/qa` aplica `qa:passed`: garantiza que todo merge de
  producto pasó por E2E real con evidencia.

> **Semántica:** estos labels son de **gobernanza de proceso** (gate de QA), no
> Status del tablero declarativo Projects V2 ni carpetas de estado del pipeline
> V3. Conviven con ambos pero se gestionan por separado. Alineado con el gate de
> QA de `CLAUDE.md`.
