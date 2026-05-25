🌊 *Ola promovida*

{{#if has-old-wave}}
*Archivada:* ola \#{{old-wave-number}}
{{/if}}
*Activa ahora:* ola \#{{new-wave-number}} — _{{new-wave-name}}_

━━━━━━━━━━━━━━━━━━━━

{{#if allowlist-applied}}
✅ *Allowlist actualizada:* {{allowlist-size}} issue\(s\) admitidos en `.partial-pause.json`\.
{{else}}
⚠️ *Allowlist no se pudo actualizar:* {{allowlist-error}}\. Revisá manualmente `.partial-pause.json`\.
{{/if}}

_Cambio versionado en `.pipeline/waves.json` · source `telegram-commander/wave-promote`_
