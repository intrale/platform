# Rotación y auditoría del vault

CloudTrail Event history es la fuente autoritativa de accesos al vault.
`.pipeline/logs/vault-access-audit.jsonl` es un complemento diagnóstico
encadenado, no un reemplazo del rastro de AWS.

## Clasificación

| Tipo | Ejemplos | Rotación | Plazo |
|---|---|---|---|
| API key o token de tercero | Anthropic, OpenAI, Gemini, Cerebras, NVIDIA, Moonshot, Telegram | Manual: revocar en el emisor, crear reemplazo y actualizar el vault | 90 días como máximo; recordatorios T-14, T-7, T-3, T-1 y T-0 |
| OAuth administrado por tercero | refresh token de Google Drive | No crear una Lambda: el emisor controla refresh y revocación | Vigilar revocación y repetir consentimiento cuando corresponda |
| Identificador no secreto | chat IDs, client ID, folder ID | No rota por calendario; cambia con el recurso | Revisar anualmente y al cambiar el recurso |
| Secreto con emisor controlado por Intrale | Ninguno actualmente | Automática sólo si una función actualiza también al emisor | Según criticidad y después de probar el ciclo completo |

La lista de secretos con rotación automática es actualmente vacía. Guardar
un token de tercero en Secrets Manager no lo vuelve rotable: cambiar sólo el
valor almacenado invalida consumidores sin actualizar al emisor.

## Rotación manual

1. Crear la credencial sustituta en el proveedor sin revocar la anterior.
2. Actualizar el vault con el rol de provisión, nunca con el rol de runtime.
3. Validar un acceso controlado sin imprimir el valor.
4. Revocar la credencial anterior en el proveedor.
5. Actualizar `last_rotated` y `expires_at` en `docs/secrets-inventory.md`.

La rehidratación transparente durante el spawn pertenece a #5440. Hasta que
ese issue cierre, una rotación se coordina con el reinicio operativo del Pulpo.

## Auditoría y alertas

`vault.access_audit` está apagado por defecto. Para el rollout se completa
`expected_principals` con los roles IAM de los hosts y luego se habilita el gate.
Una lista vacía omite el tick y lo registra en `pulpo.log`; no interpreta a todo
el mundo como atacante. `burst_threshold: 0` mantiene la detección de ráfagas
apagada hasta medir el tráfico real de #5440.

El tick consulta lecturas de SSM y Secrets Manager. Registra momento, hash de
identidad, scope lógico, evento y resultado, nunca el valor del secreto. En un
`AccessDenied`, CloudTrail puede entregar `requestParameters: null`; el scope se
registra entonces como `desconocido`, sin inferir un nombre.

Telegram recibe sólo un token de causa cerrado, su explicación, scope lógico y
correlation ID. ARN, account ID, IP y stderr de AWS no cruzan ese límite. El
cooldown silencia notificaciones repetidas, pero no el registro de eventos.

## Consultar Event history

En Git Bash se desactiva siempre la conversión de paths de MSYS:

```bash
MSYS_NO_PATHCONV=1 aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=GetParameter --start-time 2026-08-03T00:00:00Z --end-time 2026-08-03T23:59:59Z --region us-east-1 --output json --no-cli-pager
MSYS_NO_PATHCONV=1 aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue --start-time 2026-08-03T00:00:00Z --end-time 2026-08-03T23:59:59Z --region us-east-1 --output json --no-cli-pager
```

Antes de adjuntar evidencia se eliminan ARN, account IDs, IPs y cualquier salida
de error cruda. El complemento local se verifica así:

```bash
node -e "console.log(require('./.pipeline/lib/audit-log').verifyChain('.pipeline/logs/vault-access-audit.jsonl'))"
```

Este flujo no crea trails ni modifica event selectors: Event history conserva
los eventos de gestión consultables y evita competir con #5212.
