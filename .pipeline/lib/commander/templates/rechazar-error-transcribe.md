{{#if variant-1}}
🎤 *No te entendí el audio*

\(error técnico: `{{error-kind}}`\)

Mandá el rechazo por texto: `/rechazar <\#issue> <fase> <motivo>` — o probá grabarlo de nuevo más cerca del micro\.

_Whisper local — no se fue para afuera, todo quedó en la máquina\._
{{/if}}
{{#if variant-2}}
🎤 *El audio salió crudo, no pude transcribir*

\(detalle: `{{error-kind}}`\)

Mejor mandalo escrito: `/rechazar 3381 ux <motivo>`\. O grabá de nuevo, sin tanto ruido de fondo\.

_Transcripción local exclusiva \(CA\-9\) — no llamamos APIs remotas\._
{{/if}}
{{#if variant-3}}
🎤 *Whisper no pudo con el audio*

`{{error-kind}}` — puede ser muy bajo, mucho ruido o muy corto\.

Solución rápida: tipealo\. `/rechazar <\#issue> <fase> <motivo>`\.
{{/if}}
