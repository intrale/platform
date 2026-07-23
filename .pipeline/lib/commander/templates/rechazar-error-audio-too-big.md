{{#if variant-1}}
🎤 *Audio fuera de límites*

{{#if too-big}}
Tamaño: `{{size-kb}} KB` \(máx `{{max-mb}} MB`\)\.
{{/if}}
{{#if too-long}}
Duración: `{{duration-s}}s` \(máx `{{max-duration-s}}s`\)\.
{{/if}}

Mejor mandalo por texto o partilo en pedacitos\.
{{/if}}
{{#if variant-2}}
🎤 *Te quedó muy largo / pesado el audio*

{{#if too-big}}
`{{size-kb}} KB` y el cap es `{{max-mb}} MB`\.
{{/if}}
{{#if too-long}}
`{{duration-s}}s` y el cap es `{{max-duration-s}}s`\.
{{/if}}

Hasta 2 minutos y 10 MB me sirven\. Mandá texto o cortalo\.
{{/if}}
{{#if variant-3}}
🎤 *No proceso ese audio — excede el límite operativo*

{{#if too-big}}
Pesa `{{size-kb}} KB` \(cap `{{max-mb}} MB`\)\.
{{/if}}
{{#if too-long}}
Dura `{{duration-s}}s` \(cap `{{max-duration-s}}s`\)\.
{{/if}}

Mandá el rechazo por texto, va al toque\.
{{/if}}
