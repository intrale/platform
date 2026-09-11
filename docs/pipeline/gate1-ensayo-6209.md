# Ensayo operativo de GATE 1 — #6209

Esta receta complementa §15 de [Gates de firma](gates-firma-operador.md).
Describe una operación futura: no acredita autorización, firma ni encendido.
Desarrolla la receta de arquitectura publicada en `agent/6209-architect-ensayo`
(commit `f95fd4677`) y las precisiones CA-D3.0–D3.7 del issue.

## Autorización previa — CA-D3.0

El operador autoriza explícitamente en #6209 una ventana temporal de máximo
30 minutos, con issue real N, horario, responsable presencial del rollback y
conjunto de issues potencialmente afectados. La autorización del ensayo no es
la firma de los criterios de N ni la autorización del encendido permanente.
Sin respuesta explícita no se inicia; la receta no constituye consentimiento.

## Preparación y observación — CA-D3.1–D3.3

1. Actualizar el checkout del servicio a una revisión que incluya #7175,
   preservando cambios locales. Reiniciar Pulpo y listener como singleton mediante
   el procedimiento operativo PowerShell. Registrar revisión, procesos y hora.
   Verificar handler cargado y allowlist resuelta en el entorno de ambos procesos
   reiniciados: sólo presencia/ausencia, nunca valores de credenciales.
2. Guardar snapshot local de los valores originales de `operator_signoff` y del
   estado de pausa/ola, fuera del commit. `go_live_date` y `preauthorized_classes`
   se conservan durante todo el procedimiento.
3. Dentro de la ventana autorizada, observar un barrido completo con
   `enabled: true` y `gate_mode: dry-run`. Contar issues distintos cuyo
   `original_decision` sea `block`; no sumar líneas de varios barridos. La traza
   relevante es `GATE 1 firma-definición dry-run: block (efectivo=approve)`.
   Esta observación puede promover issues: no deposita pedidos ni prueba retención.
4. Si el conteo supera 15, abortar. N debe ser real, no grandfathered ni
   preautorizado, sin firma vigente, con criterios estables y todavía sin cruzar
   GATE 1. No reutilizar uno promovido por dry-run ni rebobinarlo para el ensayo.
5. Inventariar candidatos que puedan alcanzar la frontera y agentes en curso;
   acordar el conjunto con el operador. `/pause-partial N` limita intake y
   lanzamientos, pero la pausa parcial no filtra el barrido ni mata agentes
   existentes. Esperar su cierre natural y verificar coherencia de allowlist/ola.
   No mover YAMLs ajenos ni reanudar ante desync o automatismos incompatibles.

La ventana es GLOBAL, no enforce por issue. Si su impacto no puede acotarse al
conjunto autorizado, no ejecutar: un filtro de promoción requiere definición
previa y otro alcance funcional; no se incorpora como ajuste documental.
Preavisar al operador el caudal y el posible envío de hasta 15 fichas con
recordatorios de seis horas. Dry-run no le anticipa esos mensajes.

## Override temporal y firma — CA-D3.4a–D3.4c

Con operador y responsable presentes, pausar globalmente por el canal canónico y
esperar confirmación del halt. Aplicar únicamente `enabled: true` y
`gate_mode: enforce` como override local NO commiteado. Levantar sólo la pausa
total mediante el wizard con scope `full` (API auditada `clearFullPause`),
conservando la pausa parcial acordada. No usar `/reanudar`: `resumeAll` elimina
también la allowlist. La pausa global no puede mantenerse durante la prueba:
detiene también el barrido. Confirmar configuración cargada y singleton de ambos
procesos. Registrar inicio y deadline; un responsable externo al agente controla
el vencimiento y puede pausar aunque éste termine.

Antes de pedir el click, comprobar en el barrido real:

- N sigue retenido, con `GATE 1 firma-definición BLOQUEÓ promoción (mode=enforce)`.
- Se depositó el pedido y aparece `GATE 1 aviso emitido (firma, con botones)`.
- El operador confirma recepción del mensaje accionable, y N no fue promovido.

Ante `sin botones`, `indeterminado`, reclasificación, error de depósito, candidato
fuera del conjunto, más de 15 retenidos o deadline, iniciar rollback inmediato.
Sólo el operador pulsa Aprobar en el canal real. Registrar mensaje redactado,
referencia auténtica de audit chain y promoción por el siguiente barrido,
correlacionados con el mismo estado de criterios. Un cambio de criterios requiere
otra firma real. No usar writers directos, tokens sintéticos, firma de agente ni
arneses como sustitutos; no aprobar otros issues por conveniencia del ensayo.

## Salida y rollback obligatorio — CA-D3.4d

Al éxito, fallo o ausencia de firma, pausar globalmente ANTES de restaurar los
valores originales de `enabled`/`gate_mode`. Confirmar halt, restauración por
lectura y recarga controlada. Conservar la pausa global mientras queden pendientes
sin firma: volver a dry-run y reanudar los admitiría sin firma.

Conservar audit, pedidos y movimientos reales; no borrar ni revertir firmas o
promociones. El operador decide la disposición de pendientes y restauración de
pausa/ola mediante canales canónicos auditados. Sin aprobación de reanudación,
permanece pausado y se informa `needs-human`: rollback no implica resume
automático. Registrar estado final incluso si falló el ensayo.

## Encendido permanente — CA-D3.5–D3.7

Sólo después de evidencia completa de retención, ficha accionable, firma humana,
admisión y rollback, suite y cobertura verdes y preaviso al operador, preparar un
commit separado y último del PR con `enabled: true` y `gate_mode: enforce`.
Actualizar el comentario del bloque con estado real, fecha y referencia de la
firma; no afirmar que el canal carece de caller. No agregar claves ni modificar
`go_live_date` o `preauthorized_classes`. El override temporal no es ese commit.

Revisar de nuevo caudal y contexto antes del despliegue, sujeto a review humana
de CODEOWNERS. Tras desplegar, documentar modo y bloqueo efectivo del barrido,
no sólo el YAML. Un fallo del ensayo deja CA-D3 abierto y prohíbe el flip final.

## Registro de evidencia

El registro debe distinguir resultados observados de pasos pendientes e incluir:
autorización enlazada, N, conjunto afectado, responsable, inicio/deadline,
revisión y procesos, presencia de allowlist en ambos, límites del barrido y conteo
distinto, retención, mensaje recibido, firma auténtica, admisión, rollback y
decisión de reanudación. Adjuntar evidencia E2E visual con audio narrado del
mensaje al operador; este cambio de copy no admite `qa:skipped`.

Redactar chat id, callback completo, tokens, nonces, nombre privado del bot y
paths absolutos de stores. No publicar secretos en capturas, audio ni logs.

Validaciones locales requeridas (no acreditan la operación real):

```bash
node --test .pipeline/test/ .pipeline/tests/ .pipeline/lib/__tests__/
node --test --experimental-test-coverage .pipeline/test/approval-channel.test.js .pipeline/test/approval-channel-aceptacion.test.js .pipeline/test/approval-channel-authority.test.js .pipeline/test/approval-channel-nonce.test.js .pipeline/test/gate-signature-drain.test.js
bash .pipeline/smoke-test.sh
```

El umbral es ≥85 % de líneas para `approval-channel.js` y
`gate-signature-drainer.js`; no es un umbral de ramas. Registrar salida y códigos
reales de esta pasada, y repetir la suite tras el flip definitivo.

Si Node rechaza los directorios con `MODULE_NOT_FOUND`, ejecutar todos los
archivos de prueba de esos tres árboles mediante globs, sin excluir tests:

```bash
node --test ".pipeline/test/**/*.test.js" ".pipeline/tests/**/*.test.js" ".pipeline/lib/__tests__/**/*.test.js"
```
