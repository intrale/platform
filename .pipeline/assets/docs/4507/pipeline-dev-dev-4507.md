# Nota de implementación — #4507 (pipeline-dev)

## Objetivo
Garantizar que android-dev en la fase Desarrollo entregue SIEMPRE su nota de implementación o declare una excepción explícita auditable. Cierra un gap del épico #4255.

## Cambios
- **deliverable-index.js**: nueva API `upsertDeliverableException({issue,fase,agente,motivo,...})` — persiste `tipo:"exception"`, `path:null`, `bytes:0`. Motivo redactado (SEC-1) y truncado a 2048 chars con marcador (SEC-2). `redactMeta` ahora cubre `motivo`/`reason`. Persistencia atómica extraída a `persistRecord` compartido con `upsertDeliverableIndex`.
- **android-dev-deliverable-guard.js** (nuevo): decisión pura exception/error/ok del cierre. Sin side-effects, testeable.
- **pulpo.js** (barrido de entregables): enforcement acotado a `android-dev`/`dev`. Excepción explícita o incidencia por cierre silencioso; flag `entregableManejado` evita materializar un .md físico falso para la excepción.
- **deliverable-notify.js**: render text-only del motivo `entregable_no_aplica` aunque no haya adjunto; redacción defense-in-depth ("sin allowlist" no saltea redacción).
- **SKILL.md android-dev + docs/pipeline/entregables-multimedia-por-agente.md**: obligación + patrón de excepción (fin del warn-only para esta fila).

## Cómo se probó
22 tests nuevos node --test (deliverable-index 10, guard 7, notify 3, attachments 2). Suites relacionadas de notify/attachments en verde (199 tests, sin regresiones). Sin QA E2E: cambio de infra sin UI/endpoint de producto (qa:skipped).