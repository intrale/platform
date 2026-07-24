{{#if already-archived}}
ℹ️ *Ola \#{{wave-number}} ya estaba archivada*

No se hizo nada \(operación idempotente\)\.
{{else}}
✅ *Ola \#{{wave-number}} archivada*

Movida a `archived_waves` desde *{{source}}*, conservando *{{issues-preserved}}* issue\(s\)\.

🗂 *Snapshot pre\-archive* + marker transaccional cerrado limpiamente \(sin recovery pendiente\)\.
{{/if}}

_Cambio versionado en `.pipeline/waves.json` · source `telegram-commander/wave-archive` · transacción atómica `#4378`_
