{{#if variant-1}}
⚠️ *Rechazo registrado en audit, pero el evento no se escribió*

Issue: `\#{{issue}}` · fase `{{fase-resolved}}`
Motivo guardado en `rejections-YYYY-MM-DD.jsonl`\.

El handshake con \#3416 falló: `{{io-error}}`\. Revisá `.pipeline/rejections/` o avisame para reintentar a mano\.
{{/if}}
{{#if variant-2}}
⚠️ *Audit guardado, evento NO encolado*

Para `\#{{issue}}` fase `{{fase-resolved}}`: el motivo está auditado, pero el archivo `.pipeline/rejections/<issue>-<ts>.json` no se pudo escribir\.

Error: `{{io-error}}`\. El rebobinador no lo va a ver hasta que esto se destrabe\.
{{/if}}
{{#if variant-3}}
⚠️ *Rechazo a medio camino*

Quedó en audit, pero el evento JSON no se pudo persistir: `{{io-error}}`\.

Si el rebobinador \(\#3416\) no responde, hay que mover esto a mano o reintentar `/rechazar`\.
{{/if}}
