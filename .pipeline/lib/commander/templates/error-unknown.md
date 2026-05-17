🤔 *No te entendí, Leito*

Lo que mandaste no matchea ningún comando determinístico ni se ve como texto libre claro para el LLM:

> `{{raw-command-truncated}}`

━━━━━━━━━━━━━━━━━━━━

*Probá:*

⚙️ *Determinísticos \(siempre disponibles\):*
  • `/status` — estado del pulpo
  • `snapshot` — ola en curso
  • `listado pendientes` — issues por fase
  • `allowlist` — quién pasa la pausa parcial
  • `tail commander.log` — últimas líneas
  • `salud pulpo` — health detallado
  • `modo descanso` — ventana actual

🧠 *LLM \(texto libre, requiere cuota Claude\):*
  • Crear issue: _"creá una historia para X"_
  • Análisis: _"analizá el rebote de \#NNNN"_

{{#if quota-degraded}}
⚠️ _Cuota Claude agotada — los comandos LLM están en modo degradado hasta {{quota-reset-at}}._
{{/if}}

_Para ver todo: `/help`_
