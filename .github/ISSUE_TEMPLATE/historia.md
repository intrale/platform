---
name: Historia / Feature / Bug
about: Template estándar para issues que entran al pipeline V3 (definicion → desarrollo)
title: ""
labels: ["needs-definition"]
assignees: []
---

<!--
Este template alimenta al pipeline V3. Las secciones obligatorias son Objetivo, Contexto, Cambios requeridos y Criterios de aceptación.

Las secciones "Recomendación Guru (opcional)" y "Detalles Técnicos (Architect) (opcional)" son aportes que un humano puede dejar antes del pipeline si ya hizo research o sabe qué tocar; los agentes `guru` y `architect` las completan/refinan en comentarios separados durante la fase `analisis`.

Las fronteras entre `guru` y `architect` están documentadas en: docs/pipeline/roles-guru-architect.md
-->

## Objetivo

<!-- Una o dos frases que respondan: ¿qué problema resuelve este issue? ¿qué valor entrega? -->

## Contexto

<!--
¿Por qué surge este issue ahora? ¿De qué otro issue, decisión o incidente viene?
Linkear referencias (#NNNN) cuando aplique.
-->

## Cambios requeridos

<!--
Listado de cambios esperados a alto nivel (sin detalles técnicos de archivos exactos — eso lo firma `architect`).
Ej:
1. Agregar endpoint X al backend
2. Actualizar pantalla Y del app con campo Z
3. Documentar en docs/...
-->

## Criterios de aceptación

<!--
CAs verificables. Idealmente con escenarios Gherkin (Given/When/Then) cuando aplique.

- [ ] CA-1: ...
- [ ] CA-2: ...
-->

## Recomendación Guru (opcional)

<!--
Si ya investigaste tecnologías, patrones o implementaciones externas que aplican a este issue, dejalas acá. Si la dejás vacía, el agente `guru` la completa durante la fase `analisis`.

Esta sección es para RESEARCH EXTERNO: links a docs/repos/benchmarks, comparativas, alternativas evaluadas.

NO escribir acá archivos exactos del repo ni interfaces firmadas — eso es responsabilidad de `architect`.

Ej:
> Recomiendo migrar a kotlinx-rpc 0.3.0 porque resuelve la limitación X documentada en #1234.
> Alternativa B: mantener Ktor con polling — peor performance pero cero riesgo.
> Referencia: https://github.com/Kotlin/kotlinx-rpc/releases/tag/v0.3.0
-->

## Detalles Técnicos (Architect) (opcional)

<!--
Si ya tenés claro qué archivos del repo se tocan y con qué interfaz, dejalo acá. Si la dejás vacía, el agente `architect` la completa durante la fase `analisis`.

Esta sección es para FIRMA TÉCNICA INTERNA: archivos exactos, interfaces, impacto, tests, riesgo.

NO escribir acá research externo ni alternativas de stack — eso es responsabilidad de `guru`.

Ej:
> Archivos a tocar:
> - backend/src/.../X.kt (nueva clase Foo : SecuredFunction)
> - users/src/.../Y.kt (consumer; actualizar import + uso)
>
> Interfaces afectadas: Foo.execute(), nueva tag en Modules.kt
> Impacto: ningún consumer externo, endpoint nuevo.
> Tests existentes cubren regresión del módulo Y.
> Tests a agregar: happy path + caso usuario sin TOTP.
> Riesgo: 🟡 MEDIO (toca flujo de autenticación).
-->

## Notas técnicas

<!--
Cualquier información adicional que no encaje en las secciones anteriores: dependencias con otros issues, gotchas conocidos, performance considerations, etc.
-->
