*🐙 Salud del Pulpo · {{timestamp}}*

*Estado:* {{#if healthy}}🟢 sano{{else}}🔴 con problemas{{/if}}
*Última iteración:* {{last-tick-elapsed}} _(esperado < 30s)_
*Lock activo:* {{#if lock-active}}🔒 sí · PID {{lock-pid}}{{else}}🔓 no{{/if}}

━━━━━━━━━━━━━━━━━━━━

*Fases activas:*
{{#each phases}}
  {{icon}} `{{name}}` · {{state}}{{#if last-error}} ⚠️ _{{last-error}}_{{/if}}
{{/each}}

*Watchdogs:*
  ⏱️ Stuck-job watchdog: {{watchdog-stuck-state}}
  💰 Cost-anomaly: {{watchdog-cost-state}}
  🔁 Circuit breaker: {{watchdog-cb-state}}

━━━━━━━━━━━━━━━━━━━━

{{#if recent-errors}}
*Errores recientes \({{recent-errors-count}}\):*
{{#each recent-errors}}
  • {{ts-short}} · {{message-short}}
{{/each}}
{{else}}
✅ _Sin errores en la última hora._
{{/if}}

_Comando determinístico · sin LLM_
