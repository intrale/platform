🚫 *`/wave promote` BLOQUEADO*

Hay un fail\-closed marker activo de una recovery anterior que no pudo restaurar:

`{{failed-markers}}`

El sistema está en estado consistente actual pero NO se puede garantizar qué configuración estaba antes del crash original\.

━━━━━━━━━━━━━━━━━━━━

*Acción manual requerida:*

1\. Inspeccionar `{{archived-dir}}partial\-pause\-rollback\-\*.json` y `{{archived-dir}}waves\-rollback\-\*.json`\.
2\. Decidir si restaurar manualmente o aceptar el estado actual\.
3\. Borrar `.pipeline/wave\-promote.failed.\*.json` una vez resuelto\.

Hasta entonces, `/wave promote` queda inhabilitado\.

_Defensa fail\-closed `#3520` · sin LLM_
