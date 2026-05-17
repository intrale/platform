*📸 Screenshot del dashboard*

_Capturado: {{timestamp}} · vista `{{view-name}}`_

{{#if attached}}
✅ Imagen adjunta arriba ↑
{{else}}
⚠️ _No se pudo adjuntar la imagen \(ver log\)._
{{/if}}

*Resolución:* {{width}}x{{height}}
*Peso:* {{size-human}}
{{#if redacted}}
🔒 _Se enmascararon {{redacted-areas}} áreas sensibles \(tokens visibles en UI\)._
{{/if}}

━━━━━━━━━━━━━━━━━━━━

_Para una captura distinta: `screenshot {{available-views}}`_
_Comando determinístico · `puppeteer` headless · sin LLM_
