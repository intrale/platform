{{#if variant-1}}
⚠️ *Issue inválido*

`{{raw-issue}}` no parece un número de issue válido\.

Formato esperado: `/rechazar <\#issue> <fase> <motivo>` \(ej\. `/rechazar 3381 ux <motivo>`\)\.
{{/if}}
{{#if variant-2}}
⚠️ *Número de issue raro*

Recibí `{{raw-issue}}` — espero un entero positivo \(hasta 7 dígitos\)\.

Ejemplo válido: `/rechazar 3381 mockup <motivo>` o `/rechazar #3381 mockup <motivo>`\.
{{/if}}
{{#if variant-3}}
⚠️ *Issue no parseable*

`{{raw-issue}}` no me cierra como número\. Mandá algo así: `/rechazar 3381 ux <motivo>`\.
{{/if}}
