*🔴 Dashboard bajado*

*PID terminado:* `{{pid}}`
*Tiempo activo:* {{uptime-human}}
*Razón:* {{reason}}

{{#if was-not-running}}
ℹ️ _El dashboard no estaba corriendo — no hubo nada que bajar._
{{/if}}

{{#if leftover-processes}}
⚠️ Procesos huérfanos detectados: {{leftover-count}}
   Sugerido: ejecutar `/ghostbusters` para limpiar.
{{/if}}

_Comando determinístico · sin LLM_
