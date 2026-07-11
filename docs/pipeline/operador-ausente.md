# Política de operador ausente y auto-proceder auditado

> Issue #4632 · split de #4581 (Gates → Modelo de delegación / bus factor del operador).
> Módulos: `.pipeline/lib/operator-absence-policy.js` (política) + `.pipeline/lib/operator-absence-audit.js` (registro).
> Config: `gates.operator_absence` en `.pipeline/config.yaml`.

## Qué problema resuelve

Cuando un gate del pipeline queda en estado `waiting-operator` (esperando la
firma del operador humano) y el operador está **ausente**, el pipeline necesita
una política explícita: ¿bloquea y espera, o avanza solo?

La respuesta por defecto es **fail-closed**: bloquear y esperar. El pipeline
**no avanza sin el operador** salvo en una excepción muy acotada, notificada y
auditada. Este documento describe esa política y su procedimiento de revisión.

Extiende el patrón **GATE 3** (`kernel-action-policy.js` + `kernel-actions-audit.js`
+ `audit-log.appendChained`) al escenario de ausencia del operador sobre la
máquina `waiting-operator` / puerto `gates`.

## Default: fail-closed

Ante cualquiera de estas situaciones, la decisión es **fail-closed** (bloquear y
esperar firma humana):

1. **Gate no delegable** — GATE 1 (Definición) y GATE 2 (Aceptación) **nunca**
   auto-proceden. Es un hard-deny hard-coded en el módulo
   (`NON_DELEGABLE_GATES`), **no configurable desde YAML**. Aunque una allowlist
   futura los incluya, se ignoran.
2. **Sin base de confianza vigente** — si #4576 (índice/escalera de
   confiabilidad) no provee una base vigente (`confidenceIndex.vigente === true`),
   toda clase cae a fail-closed puro, **antes** de mirar la allowlist.
3. **Kill-switch activo o clase fuera de la allowlist** — si
   `gates.operator_absence.kill_switch` es `true` (default) o la clase no está en
   la allowlist cerrada, se bloquea.

**Config parcial o ausente == fail-closed.** Nunca hay fail-open implícito: si
falta `allowlist`, `kill_switch` o la base de confianza, el resultado seguro es
bloquear.

## Excepción: auto-proceder

El pipeline **sólo** auto-procede cuando se cumplen **las cuatro condiciones
simultáneamente**:

- El gate **no** es GATE 1 ni GATE 2.
- Existe base de confianza vigente provista por #4576.
- `kill_switch` está en `false`.
- La clase está en la `allowlist` cerrada de clases de bajo riesgo.

En ese caso la decisión es `auto-proceed` **dentro del scope de esa clase**, y:

- Se **encola una notificación Telegram** al operador primario
  (`notifyDelegation`).
- Se **registra la decisión** en el audit tamper-evident
  (`operator-absence-audit.appendDecision`).

## Orden de evaluación (guardas de seguridad)

`resolveAbsenceDecision({ gate, clase, config, confidenceIndex, killSwitch })`
evalúa en este orden estricto; el primer bloqueo gana:

| # | Guarda | Motivo (`reason`) | Decisión |
|---|--------|-------------------|----------|
| 1 | gate ∈ {gate1, gate2} | `gate_no_delegable_firma_humana` | fail-closed |
| 2 | `confidenceIndex.vigente !== true` | `sin_base_confianza_4576` | fail-closed |
| 3 | `kill_switch` activo o clase fuera de allowlist | `clase_no_en_allowlist_o_killswitch` | fail-closed |
| 4 | (ninguna guarda disparó) | `allowlist+indice_vigente` | auto-proceed (scope = clase) |

## Configuración

```yaml
gates:
  operator_absence:
    kill_switch: true          # default seguro: apagado total de auto-proceder
    allowlist: []              # clases delegables. VACÍA = nada delegable
    confidence_index_ref: ".pipeline/lib/confidence-index.js (#4576)"
    non_delegable_gates:       # documental — el hard-deny vive en código
      - gate1
      - gate2
```

- **Volver a fail-closed puro:** dejar `kill_switch: true`. Es suficiente.
- **Habilitar una clase:** poner `kill_switch: false` y agregar la clase a
  `allowlist`. El auto-proceder igual requiere que el caller pase un
  `confidenceIndex` vigente en runtime; sin él, se bloquea.

## Notificación Telegram

### Delegación auto-procedida (`buildDelegationMessage`)

Escaneable en <10s, en este orden: decisión, issue/gate, ejecutor, clase/scope,
base de confianza, timestamp y **acción concreta de revisión/revocación**.

```
GATE · Operador ausente — se AUTO-PROCEDIO una delegacion
Issue/Gate: #4632 / gate3
Ejecutor: kernel:absence-policy
Clase/Scope: low-risk-doc / low-risk-doc
Base de confianza: indice #4576 vigente
Cuando: 2026-07-11T00:00:00.000Z
Motivo: allowlist+indice_vigente
Revisar/Revocar: comentá "revocar auto-proceed #4632" en el issue,
o ejecutá `node .pipeline/restart.js` tras poner gates.operator_absence.kill_switch=true.
Audit: .pipeline/audit/operator-absence.jsonl (verificable con verifyChain).
```

### Fail-closed por ausencia (`buildFailClosedMessage`)

Comunica explícitamente que la espera es **por diseño**, que **nada avanzó**, y
diferencia el motivo. Ejemplos:

- **Gate no delegable:**
  ```
  GATE · Operador ausente — BLOQUEADO y esperando (por diseño)
  Issue/Gate: #4632 / gate1
  Clase: firma
  Motivo: este gate exige FIRMA HUMANA explicita y nunca se delega.
  Nada avanzo sin vos. Esta espera es intencional, no es un error ni un fallo silencioso.
  Para destrabar: firmá el gate cuando vuelvas (la accion queda pendiente, no se pierde).
  ```
- **Falta de índice de confianza:** `Motivo: no hay base de confianza vigente (#4576) para delegar.`
- **Kill-switch/allowlist:** `Motivo: la clase no esta en la allowlist cerrada o el kill-switch esta activo.`

## Audit tamper-evident

Cada decisión de auto-proceder se persiste en
`.pipeline/audit/operator-absence.jsonl` mediante `audit-log.appendChained`
(hash-chain SHA-256 + file-lock O_EXCL). **Prohibido** escribir JSONL crudo con
`fs.appendFile`.

Cada entry incluye: `issue`, `gate`, `clase`, `actor`, `scope`,
`confidence_base`, `decision`, `reason`, `timestamp` y el hash-chain
(`hash_prev`/`hash_self`). Campos de texto libre pasan por `sanitizeReason`
(redact de secrets + escape de CRLF + truncado). `actor` y `decision` se validan
contra enums cerrados; un valor fuera de rango se marca (`*_rejected_value`) sin
perder la traza.

Verificación de integridad:

```bash
node -e "console.log(require('./.pipeline/lib/operator-absence-audit').verifyChain())"
# => { ok: true, entriesChecked: N }   (ok:false + brokenAt:i si la cadena fue alterada)
```

## Procedimiento de revisión / revocación

1. El operador recibe la notificación Telegram de la delegación.
2. Para **revisar**: consultar el audit (`verifyChain` + `tail`) y el issue.
3. Para **revocar** delegaciones futuras: poner
   `gates.operator_absence.kill_switch: true` en `config.yaml` y reiniciar el
   pipeline (`node .pipeline/restart.js`). Esto devuelve el sistema a fail-closed
   puro sin tocar código.
4. La autorización de cualquier acción de operador por Telegram valida el
   `chat_id` contra la allowlist de operadores (`authorizeOperator` →
   `validateConfirmer`); un `chat_id` no autorizado se rechaza y deja evidencia.

## Estado actual

Al momento de esta entrega la política corre en **fail-closed puro**:
`kill_switch: true` y `allowlist: []` en config. El auto-proceder queda
disponible como capacidad pero **desactivado por default**, a la espera de que el
operador defina explícitamente qué clases de bajo riesgo delegar.
