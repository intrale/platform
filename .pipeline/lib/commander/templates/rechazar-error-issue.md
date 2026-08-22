{{#if variant-1}}
⚠️ *El \#{{issue}} no se puede rebobinar*

Motivo: _{{reason}}_

{{#if labels}}
Labels actuales: `{{labels}}`
{{/if}}

Si querés retomar algo así, abrí un issue nuevo o sacale el label de no\-retorno primero\.
{{/if}}
{{#if variant-2}}
⚠️ *No puedo tocar el \#{{issue}}*

{{reason}}

{{#if labels}}
\(Labels: `{{labels}}`\)
{{/if}}

Para reabrir el flujo: nuevo issue o limpieza manual del estado\.
{{/if}}
{{#if variant-3}}
⚠️ *Issue \#{{issue}} bloqueado para rebobinado*

{{reason}}

{{#if labels}}
Estado actual: `{{labels}}`
{{/if}}

Si insistís, hay que destrabarlo a mano \(quitar label / reabrir\) antes de mandar `/rechazar`\.
{{/if}}
