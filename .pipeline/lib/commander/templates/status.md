*🐙 Estado del Pulpo · {{timestamp}}*

{{#if pipeline-running}}🟢 *Pipeline:* corriendo · uptime {{uptime}}{{else}}🔴 *Pipeline:* detenido{{/if}}
{{#if quota-degraded}}⚠️ *Modo degradado:* sin LLM hasta {{quota-reset-at}}{{/if}}
{{#if rest-mode}}😴 *Modo descanso:* activo hasta {{rest-mode-until}}{{/if}}

━━━━━━━━━━━━━━━━━━━━

*Agentes activos:* {{agents-count}}/{{agents-max}}
{{#each agents}}
  • `{{skill}}` · issue \#{{issue}} · {{phase}} · {{elapsed}}
{{/each}}
{{#if no-agents}}_— sin agentes corriendo en este momento —_{{/if}}

*Trabajo por fase:*
{{#each phases}}
  {{icon}} `{{name}}` · {{pending}} pend · {{working}} en curso · {{ready}} listos
{{/each}}

━━━━━━━━━━━━━━━━━━━━

*KPIs (últimas 24h):*
  📥 Intake: {{intake-24h}} issues
  ✅ Entregados: {{delivered-24h}}
  🔁 Rebotes: {{rebotes-24h}}
  🪙 Tokens: {{tokens-24h}} ({{tokens-cost-usd}} USD est)

_Comando determinístico · sin gasto de LLM_
