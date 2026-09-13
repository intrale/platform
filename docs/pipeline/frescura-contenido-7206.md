# Frescura del contenido verificado

QA verifica contenido, no ancestría. Un HEAD idéntico conserva la frescura;
dos commits distintos también la conservan cuando Git deriva árboles iguales.
`deriveTree` sólo acepta SHAs completos de commits, usa `--no-replace-objects`
y resuelve primero el commit y luego su árbol. Un objeto ausente mantiene el
gate cerrado. Árboles distintos producen `arbol-distinto`.

El manifest versión 1 agrega `tree` como campo opcional de trazabilidad. El gate
no confía en ese valor: deriva ambos árboles desde Git. La aceptación por árbol
genera `aceptado-arbol-identico` en `logs/audit-seal-caducidad.jsonl`, con ambos
commits y ambos árboles. `shaVerificado` sigue siendo el HEAD actual.

La re-ratificación consulta el primer aprobado sellado por el pipeline en
`verificacion/{listo,procesado,archivado}`. Si está vigente, publica `qa:passed`
por la cola GitHub, sin incrementar retries ni crear una nueva escalada.
El drenador verifica de nuevo antes de ejecutar una orden vieja y la archiva
como `descartada: sello-vigente`, sin crear work-files de verificación.
El gate de delivery sigue cerrado sobre su dropfile canónico hasta que el
barrido promueve el veredicto nuevo. Ningún label declarado prueba vigencia.

Las generaciones se persisten en `.<issue>.gate-generation` antes de encolar,
con lock de archivo y PID para evitar empates entre productores. La contención
falla cerrada; un lock abandonado queda disponible para diagnóstico operativo.
Los retries conservan nombre y generación. El consumidor mantiene precedencia
durable por número y target, según `precedencia-ordenes-caducidad.md`.

La validación desplegada sobre #5113 y PR #7215 corresponde a operación y
delivery después de revisión humana. Esta implementación no remueve
`needs-human`: esa autorización sigue siendo exclusivamente humana.
