{{#if variant-1}}
🤔 *No me cerró del todo lo que me mandaste*

{{#if heard}}
Lo que entendí del audio:
> {{heard}}
{{/if}}

Necesito 3 cosas para rebobinar:
  • número del issue \(ej\. `\#3381` o `3381`\)
  • fase a rebobinar \(`ux`, `refinar`, `plan`, `validar`, `dev`, etc\.\)
  • motivo \(libre\)

Probá: `/rechazar 3381 ux el mockup no respeta el branding`
{{/if}}
{{#if variant-2}}
🤔 *Me faltó info para rebobinar*

{{#if heard}}
Transcripción:
> {{heard}}
{{/if}}

¿A qué issue te referís? ¿Qué fase rechazás? Mandalo así:
`/rechazar <\#issue> <fase> <motivo>`

\(Fases: `ux`, `refinar`, `plan`, `validar`, `dev`, `build`, `qa`, `review`, …\)
{{/if}}
{{#if variant-3}}
🤔 *Necesito más detalle*

{{#if heard}}
Lo que escuché:
> {{heard}}
{{/if}}

Confirmame: número de issue, fase y motivo\. Ejemplo: `/rechazar #3381 mockup la paleta no respeta el branding`\.
{{/if}}
