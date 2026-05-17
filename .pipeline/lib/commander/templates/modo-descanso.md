*😴 Modo descanso · {{timestamp}}*

*Estado actual:* {{#if active}}🟣 ACTIVO{{else}}🟢 inactivo{{/if}}
{{#if active}}*Hasta:* {{until}} _(en {{remaining-human}})_{{/if}}

━━━━━━━━━━━━━━━━━━━━

*Ventana configurada:*
  ⏰ De `{{window-start}}` a `{{window-end}}`
  🌍 Zona horaria: `{{timezone}}`
  📅 Días: {{days-display}}

*Política durante modo descanso:*
  • LLM-skills → cola \(no ejecutan\)
  • Determinísticos → siguen normal
  • `priority:critical` → bypass \(ejecuta igual\)
  • Snooze máximo: {{snooze-cap-h}}h \(hardcoded\)

━━━━━━━━━━━━━━━━━━━━

{{#if has-snooze}}
⏸️ *Snooze activo:* hasta {{snooze-until}} _(por {{snooze-reason}})_
{{/if}}

_Comando determinístico de solo lectura · sin LLM_
_Para cambiar: editar `.pipeline/config.yaml` → `rest_mode`_
