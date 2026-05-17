*🟢 Dashboard levantado*

*URL:* {{dashboard-url}}
*PID:* `{{pid}}`
*Puerto:* `{{port}}`
*Tiempo de arranque:* {{startup-ms}} ms

{{#if was-already-running}}
ℹ️ _Ya estaba corriendo \(PID {{pid}}\) — no se reinició._
{{/if}}

{{#if smoke-test-passed}}
✅ Smoke test: respuesta HTTP 200 en `/health`
{{else}}
⚠️ Smoke test falló — revisá `dashboard-v2.log`
{{/if}}

_Comando determinístico · `execFile` con argv array \(sin shell\)_
