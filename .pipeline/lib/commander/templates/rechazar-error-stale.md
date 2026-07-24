{{#if variant-1}}
⏱️ *Ese mensaje es muy viejo*

Tiene `{{age-hours}}h` desde que lo mandaste\. Por seguridad no rebobino comandos de hace más de 24h \(podría ser un audio reenviado por accidente\)\.

Mandalo de nuevo si todavía aplica\.
{{/if}}
{{#if variant-2}}
⏱️ *Audio / comando caduco*

Hace `{{age-hours}}h` y el cap es 24h\. Si todavía querés rebobinar `\#{{issue}}`, mandalo recién\.

_Replay protection \(CA\-14\) — evita rebobinados accidentales por mensajes reenviados\._
{{/if}}
{{#if variant-3}}
⏱️ *Esto es de hace un rato largo \({{age-hours}}h\)*

Mejor mandalo de vuelta para evitar líos\. La protección es para que un audio viejo reenviado no dispare un rebobinado fantasma\.
{{/if}}
