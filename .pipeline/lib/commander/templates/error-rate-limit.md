⏱️ *Calma, pibe — esperá un toque*

Recibí {{recent-requests}} pedidos tuyos en el último minuto \(límite: {{limit-per-min}}/min\).

Volvé a intentar en *{{retry-after-seconds}}s* ⏳

━━━━━━━━━━━━━━━━━━━━

_Esto es un freno mecánico — no es que esté pasando algo raro._
_El cap está para proteger al pipeline de loops accidentales._

{{#if last-blocked-commands}}
*Tus últimos comandos bloqueados:*
{{#each last-blocked-commands}}
  • `{{command}}` · hace {{elapsed}}
{{/each}}
{{/if}}

_Rate limit CA-11 · pista determinística_
