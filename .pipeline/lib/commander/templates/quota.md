{{#if exhausted}}🔴 *Claude · cuota agotada*

*Provider:*  `{{provider}}`
*Desde:*     hace {{since-elapsed}} \({{since-iso}}\)
{{#if has-resets}}*Resetea:*   en {{resets-in}} \({{resets-iso}}\){{else}}*Resetea:*   sin estimación disponible{{/if}}
*Motivo:*    `{{reason-kind}}`

━━━━━━━━━━━━━━━━━━━━

Comandos disponibles sin LLM:
`/status` · `/ghostbusters` · `/restart` · `/pausar` · `/quota` · `/help`

_Read-only · este comando NO destraba la cuota._
{{else}}🟢 *Claude · cuota disponible*

No hay flag de cuota activo \(`/quota` es read-only — sin acciones colaterales\).
{{/if}}
