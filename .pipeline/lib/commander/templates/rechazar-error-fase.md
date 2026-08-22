{{#if variant-1}}
⚠️ *Esa fase no la tengo*

`{{fase-input}}` no matchea ninguna fase del pipeline\.

*Las que valen:*
{{#each valid-aliases}}
  • `{{this}}`
{{/each}}

{{#if issue}}
_Para `\#{{issue}}` probá:_ `/rechazar {{issue}} ux <motivo>`
{{/if}}
{{/if}}
{{#if variant-2}}
⚠️ *No conozco la fase `{{fase-input}}`*

Las fases que aceptamos:
{{#each valid-aliases}}
  • `{{this}}`
{{/each}}

{{#if issue}}
Para tu pedido del \#{{issue}}, intentá algo así: `/rechazar {{issue}} validar <motivo>`
{{/if}}

_Si querés nombre completo: `definicion/criterios`, `desarrollo/dev`, etc\._
{{/if}}
{{#if variant-3}}
⚠️ *Fase inválida: `{{fase-input}}`*

Probá con alguna de estas:
{{#each valid-aliases}}
  • `{{this}}`
{{/each}}

{{#if issue}}
Ejemplo para `\#{{issue}}`: `/rechazar {{issue}} mockup <lo que no te cierra>`
{{/if}}
{{/if}}
