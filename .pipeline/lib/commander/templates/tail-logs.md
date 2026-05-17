*📜 Tail de `{{log-file}}` · últimas {{lines-count}} líneas*

_Tamaño total: {{file-size-human}} · última escritura: {{last-write}}_

```
{{{log-content}}}
```

{{#if redacted-count}}
⚠️ _Se redactaron {{redacted-count}} valores sensibles \(API keys, JWTs, passwords\)._
{{/if}}

{{#if truncated}}
_Output truncado a {{lines-count}} líneas. Para más, levantá el dashboard y mirá el log completo._
{{/if}}

━━━━━━━━━━━━━━━━━━━━

*Archivos disponibles:* `commander.log`, `pulpo.log`, `svc-telegram.log`, `dashboard-v2.log`, `listener-telegram.log`

_Comando determinístico · acceso restringido por allowlist \(CA-8\) · redacción CA-9 aplicada_
