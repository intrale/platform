# Licenciamiento de los repositorios de Intrale

> ⚠️ **No es asesoramiento legal.** Este documento ordena opciones y consecuencias para que el operador decida. Los puntos que necesitan abogado están listados en [Puntos que requieren consulta profesional](#puntos-que-requieren-consulta-profesional).

Historia: [#7590](https://github.com/intrale/platform/issues/7590) · Épico: [#7589](https://github.com/intrale/platform/issues/7589) · Historia que aplica la decisión: [#7591](https://github.com/intrale/platform/issues/7591)

## Resumen para el operador

- Hoy **ningún repo activo tiene licencia**. Legalmente el código ya es tuyo ("todos los derechos reservados" nace solo, sin trámite), pero no lo dice en ningún lado.
- Lo que pediste ("que no lo clonen ni lo usen sin permiso, aunque después quizá lo abra") lo cubre mejor una **licencia propietaria explícita**: prohíbe todo uso sin tu permiso y, como titular, podés abrirlo más adelante cuando quieras.
- **`kernel`:** propietaria y privado. **`platform`:** propietaria (si en algún momento querés que otros lo lean y lo usen sin fines comerciales, el paso siguiente sería BUSL 1.1).
- **Legado (2020-2025):** propietaria mínima y archivar. Mejor todavía: privatizar, después del escaneo de secretos ([#7624](https://github.com/intrale/platform/issues/7624)).
- **Los dos ejemplos con Apache/BSD:** no se puede revocar esa licencia, así que se archivan tal como están.
- **Hay una condición abierta:** hay commits de las cuentas `codex` y `leitocodexbot` y la API no prueba de quién son. Hasta que lo confirmes, la idea de "titular único que relicencia sin pedir permiso" queda **condicionada**.
- **Para decidir:** completá la tabla de [Decisión del operador](#decisión-del-operador) y firmá el commit siguiendo el protocolo de esa sección.

## Estado verificado

Inventario regenerado el **23/09/2026 a las 15:16 UTC** con:

```bash
gh repo list intrale --limit 100 --json name,visibility,licenseInfo,isFork,isArchived,pushedAt
```

Resultado: **23 repos**, 22 públicos y 1 privado. **0 forks** y **0 archivados**. Sólo dos tienen licencia, heredada de un template.

Categorías:
- **(a) Activos:** `platform` y `kernel`.
- **(b) Legado sin licencia:** repos de 2020-2025 que ya no reciben desarrollo.
- **(c) Ejemplos con licencia heredada de un template.**

| Repo | Visibilidad | Licencia actual | Categoría | Último push |
|---|---|---|---|---|
| `platform` | Pública | Ninguna | (a) Activo | 2026-09-23 |
| `kernel` | Privada | Ninguna | (a) Activo | 2026-07-28 |
| `app` | Pública | Ninguna | (b) Legado | 2025-06-12 |
| `back-core` | Pública | Ninguna | (b) Legado | 2025-02-14 |
| `backend` | Pública | Ninguna | (b) Legado | 2025-06-26 |
| `codex` | Pública | Ninguna | (b) Legado | 2025-06-27 |
| `intrale-arq-ms` | Pública | Ninguna | (b) Legado | 2023-01-10 |
| `intrale-back-test` | Pública | Ninguna | (b) Legado | 2025-04-16 |
| `intrale-commons` | Pública | Ninguna | (b) Legado | 2023-05-02 |
| `intrale-core` | Pública | Ninguna | (b) Legado | 2023-04-25 |
| `intrale-delivery` | Pública | Ninguna | (b) Legado | 2023-10-30 |
| `intrale-files` | Pública | Ninguna | (b) Legado | 2023-05-03 |
| `intrale-mobile` | Pública | Ninguna | (b) Legado | 2023-01-30 |
| `intrale-notifications` | Pública | Ninguna | (b) Legado | 2022-08-11 |
| `intrale-parent` | Pública | Ninguna | (b) Legado | 2022-04-14 |
| `intrale-products` | Pública | Ninguna | (b) Legado | 2023-05-02 |
| `intrale-test` | Pública | Ninguna | (b) Legado | 2023-05-02 |
| `intrale-users` | Pública | Ninguna | (b) Legado | 2023-05-02 |
| `intrale-web` | Pública | Ninguna | (b) Legado | 2022-02-09 |
| `repo` | Pública | Ninguna | (b) Legado | 2025-06-28 |
| `users` | Pública | Ninguna | (b) Legado | 2025-06-26 |
| `intrale-mobile-mercadopago` | Pública | BSD-3-Clause | (c) Ejemplo | 2024-03-11 |
| `kotlin-multiplatform-example` | Pública | Apache-2.0 | (c) Ejemplo | 2024-05-06 |

`platform` tampoco tiene hoy un archivo `LICENSE`: se verificó con `ls` en este mismo ciclo.

## Qué es el copyright y qué agrega registrar

- **El derecho nace con la obra, sin trámite.** En Argentina, la [Ley 11.723 de Propiedad Intelectual](https://servicios.infoleg.gob.ar/infolegInternet/anexos/40000-44999/42755/texact.htm) protege las obras desde que existen. La [Ley 25.036](https://servicios.infoleg.gob.ar/infolegInternet/anexos/50000-54999/54178/norma.htm) incluyó expresamente a los programas de computación (código fuente y objeto). En el exterior rige lo mismo por el [Convenio de Berna](https://www.wipo.int/treaties/es/ip/berne/), que prohíbe exigir formalidades para proteger una obra.
- **Sin licencia = todos los derechos reservados.** Que un repo sea público no le da a nadie permiso para copiarlo, modificarlo ni usarlo ([choosealicense.com — sin licencia](https://choosealicense.com/no-permission/)). El problema actual no es que falte protección: es que **no está escrito**, y entonces no hay un texto al que apuntar si alguien lo usa mal.
- **Qué agrega registrar en la DNDA** (Dirección Nacional del Derecho de Autor, el organismo argentino que recibe los depósitos de obras): el [depósito de obra](https://www.argentina.gob.ar/justicia/derechodeautor) sirve como **prueba de fecha y de titularidad**, útil en un conflicto, porque da vuelta la carga de la prueba. Se pueden depositar obras inéditas (sin publicar) o publicadas.
- **Qué NO agrega registrar:** no crea el derecho (ya existe), no impide que alguien copie, no protege el nombre "Intrale" (eso es una **marca** y se tramita aparte, en el INPI) y no tiene efecto automático en otros países.
- **Punto débil: el código que escribió una IA.** Para la [US Copyright Office](https://www.copyright.gov/ai/) (informe [*Copyrightability*, parte 2, enero 2025](https://www.copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf)), lo generado por una IA **sin un aporte creativo humano demostrable** no tiene copyright. Sí lo tienen la selección, el orden, la edición y las partes que decide una persona. En Argentina no hay criterio firme, pero la Ley 11.723 parte de un autor persona. Consecuencia: la protección de este repo depende de poder mostrar la **dirección humana** (issues, criterios, revisiones y decisiones del operador). Eso se trabaja en la historia de autoría del épico [#7589](https://github.com/intrale/platform/issues/7589).

## Opciones

Las cuatro opciones usan el mismo formato: **Qué permite a terceros / Qué gana el proyecto / Qué pierde / Reversibilidad**. Entre paréntesis se aclara cada término técnico la primera vez que aparece.

### 1. Propietaria ("todos los derechos reservados" explícito)

Un `LICENSE` corto que dice que el código es de Intrale y que nadie lo puede usar, copiar, modificar ni distribuir sin permiso escrito.

- **Qué permite a terceros:** nada, salvo lo mínimo que exigen los términos de GitHub para los repos públicos: verlo y hacer un *fork* (copia) dentro de GitHub ([Términos de GitHub, D.5](https://docs.github.com/es/site-policy/github-terms/github-terms-of-service#5-license-grant-to-other-users)). No pueden usarlo, ni siquiera sin fines comerciales.
- **Qué gana el proyecto:** máxima protección y un texto claro al que apuntar ante un uso indebido. Sirve igual para repos públicos y privados.
- **Qué pierde:** adopción externa cero. Nadie puede contribuir ni probarlo legalmente, y un repo público queda en "mirar y no tocar".
- **Reversibilidad:** total hacia más apertura. Si el titular es único, puede pasarse después a BUSL o Apache sin pedirle permiso a nadie (con la condición que se describe en [Titularidad de las cuentas contribuidoras](#titularidad-de-las-cuentas-contribuidoras)).

### 2. Source-available con apertura diferida: BUSL 1.1

*Source-available* quiere decir "código a la vista": se puede leer y auditar, pero no usar libremente. La [Business Source License 1.1](https://mariadb.com/bsl11/) (BUSL) es la más conocida. No es open source según la [OSI](https://opensource.org/licenses) (la organización que certifica qué licencias son open source).

- **Qué permite a terceros:** leer, copiar, modificar y usar el código **en producción sólo dentro de lo que diga el *Additional Use Grant*** (el "permiso adicional": un campo de texto que **completa el operador**, por ejemplo "uso no comercial" o "uso interno de hasta N comercios"). Todo lo demás requiere una licencia comercial.
- **Qué gana el proyecto:** transparencia (se puede auditar), algo de adopción y **apertura automática**: en la *Change Date* (la "fecha de cambio", que BUSL 1.1 exige que sea **como máximo 4 años** después de publicar cada versión) esa versión pasa sola a una licencia open source compatible con GPL, normalmente Apache-2.0. Codifica justamente el "no sin permiso ahora, abierto después".
- **Qué pierde:** el reloj corre por versión. Todo lo publicado hoy queda abierto en ≤ 4 años aunque después cambies de idea. Además, redactar mal el *Additional Use Grant* deja agujeros.
- **Reversibilidad:** parcial. Se puede cambiar de licencia para las versiones futuras, pero cada versión ya publicada bajo BUSL conserva su *Change Date*.

### 3. Source-available sin apertura: Elastic 2.0 y PolyForm

- **Qué permite a terceros:**
  - [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license): usar, copiar y modificar, **salvo** ofrecerlo como servicio gestionado a terceros o eludir sus controles de licencia. **No tiene apertura diferida**: queda así para siempre.
  - [PolyForm](https://polyformproject.org/licenses/): una familia de licencias con variantes. *Noncommercial* permite cualquier uso no comercial; *Shield* permite todo menos competir con el licenciante; *Strict* sólo permite uso personal o no comercial, sin modificar ni redistribuir.
- **Qué gana el proyecto:** textos estándar, cortos y probados (menos redacción propia que una propietaria o un *Additional Use Grant*), y bloqueo del uso comercial o competidor.
- **Qué pierde:** poca adopción, y la sensación de "open source a medias" puede espantar a los contribuidores. Ninguna se abre sola.
- **Reversibilidad:** igual que la propietaria para lo futuro. Lo ya publicado bajo esa licencia sigue disponible bajo esas condiciones para quien lo haya obtenido.

### 4. Open source con CLA: Apache-2.0 + acuerdo de contribución

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) es una licencia open source permisiva. Un *CLA* (*Contributor License Agreement*, "acuerdo de licencia del contribuidor") es un contrato que firma cada persona externa antes de aportar: le da al proyecto los derechos sobre su aporte, incluido el de relicenciarlo ([modelo de la Apache Software Foundation](https://www.apache.org/licenses/contributor-agreements.html)). La alternativa liviana es el *DCO* (*Developer Certificate of Origin*, [certificado de origen](https://developercertificate.org/)): una línea `Signed-off-by` en cada commit, que certifica que el aporte es propio pero **no** cede derechos para relicenciar.

- **Qué permite a terceros:** todo: usar, modificar, vender y ofrecerlo como servicio, con la condición de mantener el aviso de copyright y la licencia. Incluye una licencia de patentes.
- **Qué gana el proyecto:** adopción máxima, contribuciones externas y confianza. La autoría se conserva (el aviso de copyright es obligatorio) y el CLA permite relicenciar las versiones futuras.
- **Qué pierde:** cualquiera, incluido un competidor, puede usarlo comercialmente sin pagar. Es lo opuesto a lo que se pidió hoy.
- **Reversibilidad:** **nula** para lo ya publicado: una licencia Apache otorgada no se revoca. Sólo se puede cambiar de licencia hacia adelante.

### Comparación rápida

| Opción | ¿Se puede leer? | ¿Uso comercial de terceros? | ¿Se abre sola después? | ¿Adopción externa? |
|---|---|---|---|---|
| Propietaria | ✅ Sí, si el repo es público | ❌ No | ❌ No | ❌ Nula |
| BUSL 1.1 | ✅ Sí | ❌ No, salvo el permiso adicional | ✅ Sí, en ≤ 4 años | 🟡 Baja |
| Elastic 2.0 / PolyForm | ✅ Sí | ❌ No (Elastic: no como servicio) | ❌ No | 🟡 Baja |
| Apache-2.0 + CLA | ✅ Sí | ✅ Sí | No aplica: ya es abierta | ✅ Máxima |

## Lo que una licencia NO hace

- **No revoca licencias ya otorgadas.** Lo publicado bajo Apache-2.0 o BSD-3 (los dos repos de ejemplo) sigue disponible bajo esa licencia para quien ya lo obtuvo. Un cambio de licencia sólo rige hacia adelante.
- **No borra clones ni historial.** Ni un `LICENSE` propietario ni archivar o privatizar un repo hacen desaparecer las copias que ya se hicieron, ni el historial público. Lo que se publicó sin licencia ya estaba en "todos los derechos reservados", así que no se pierde protección; pero tampoco se recupera el control sobre lo que ya se clonó.
- **No reemplaza el escaneo de secretos.** Si en el historial de un repo público quedó algún dato sensible, ninguna licencia lo protege. Eso lo trata [#7624](https://github.com/intrale/platform/issues/7624), que conviene resolver **antes** de decidir la visibilidad de cada repo de legado.
- **No protege el nombre ni la idea.** El nombre "Intrale" es una marca (se registra aparte) y el copyright protege el código, no la idea de negocio.

## Licencia vs. proveedores de IA

Son dos cosas distintas y conviene no mezclarlas:

- **La licencia obliga al licenciatario:** a quien *recibe* el código bajo esa licencia, por ejemplo alguien que lo clona desde GitHub.
- **Al proveedor de IA al que nosotros le mandamos código lo obligan sus propios términos** (retención de datos, uso para entrenamiento, acuerdo de procesamiento de datos o *DPA*), no la licencia del repo. Mandarle código es un acto voluntario del titular, y la licencia no lo limita.

Por eso, qué proveedor puede ver qué parte del código se decide en la política de proveedores del pipeline, no acá. Referencias conceptuales: la evaluación de proveedores ([#6860](https://github.com/intrale/platform/issues/6860)) y la [documentación multi-provider](../pipeline/multi-provider.md).

| Licencia | Qué implica si un proveedor retiene o entrena con el código |
|---|---|
| Propietaria | Si se lo mandamos nosotros, la licencia no lo frena: rigen sus términos. Si lo toma de un repo público para entrenar, la licencia sirve como declaración expresa de "no autorizado", pero el scraping para entrenamiento sigue siendo terreno legal sin resolver (*fair use* en EE. UU.). |
| BUSL 1.1 | Igual que la propietaria para lo que le mandamos. Para lo público, además, el proveedor podría argumentar que "leer" está permitido. Y a la *Change Date* esa versión queda abierta para cualquiera, incluido el entrenamiento. |
| Elastic 2.0 / PolyForm | Igual que la propietaria para lo que le mandamos. Para lo público, las restricciones apuntan al uso comercial o como servicio, no al entrenamiento: la cobertura es dudosa. |
| Apache-2.0 + CLA | No hay restricción: cualquiera, un proveedor incluido, puede usarlo para entrenar mientras respete el aviso de copyright. |

Conclusión: **la licencia no es la herramienta para controlar a los proveedores de IA**. Eso lo controlan los términos contratados y la política de proveedores. La licencia sí ayuda a declarar la titularidad frente a terceros.

## Titularidad de las cuentas contribuidoras

Para relicenciar sin pedir permiso, todo el código tiene que ser del mismo titular. Cuentas que aparecen como contribuidoras en la API de GitHub (`gh api repos/intrale/<repo>/contributors`) de los repos `platform`, `kernel`, `backend`, `app`, `users` y `codex`, con el tipo obtenido el 23/09/2026 mediante `gh api users/<login> -q .type`:

| Cuenta | Tipo | Dueño verificado | Evidencia |
|---|---|---|---|
| `leitolarreta` | User | Operador | Es la cuenta dueña de la organización. Autor de la gran mayoría de los commits (`platform` 2303, `kernel` 699). |
| `leitocodexbot` | User | **Pendiente de confirmación del operador** | Cuenta de usuario común creada el 2025-06-10, con 41 commits en `platform`. La API no expone quién la controla. |
| `codex` | User (no es una GitHub App) | **Pendiente de confirmación del operador** | Cuenta de usuario común con nombre público "Codex", creada el 2026-03-11. Sus commits (`platform` 31, `users` 47, `backend` 14, `app` 1, `codex` 2) tienen un **autor git del dominio de OpenAI**: GitHub se los atribuye a esta cuenta por el email, y la cuenta es posterior a varios de esos commits. Esto sugiere que es la cuenta de un tercero, no del operador. |
| `github-actions[bot]` | Bot | GitHub (automatización) | Commits generados por los workflows de CI del propio repo. No aportan autoría creativa. |

Además, en `platform` hay 1 commit con autor git `Claude Code` que GitHub no vincula a ninguna cuenta.

**Condición:** la premisa "titular único, relicenciable sin permiso" queda **condicionada** a que el operador confirme lo siguiente:
1. Que `leitocodexbot` es una cuenta suya.
2. Que los commits atribuidos a `codex` los produjo un agente de IA **por encargo del operador**, y que los términos de ese proveedor le asignan el resultado al usuario. Hay que revisar los términos vigentes del proveedor; ver [Puntos que requieren consulta profesional](#puntos-que-requieren-consulta-profesional).

Si alguna de las dos no se confirma, esos aportes quedan fuera de la premisa y habría que identificarlos, reescribirlos o conseguir la cesión de derechos antes de relicenciar.

## Recomendación por repo

La visibilidad sugerida es **sólo un insumo** para la historia de visibilidad del épico [#7589](https://github.com/intrale/platform/issues/7589). Este documento no la decide.

| Repo | Licencia recomendada | Visibilidad sugerida (insumo) | Fundamento |
|---|---|---|---|
| `kernel` | Propietaria | Privada (sin cambio) | Es el núcleo reutilizable y el activo más valioso: no tiene sentido exponerlo. |
| `platform` | Propietaria | Pública o privada, a definir | Cumple el "no sin permiso" pedido y deja abierta la puerta a BUSL o Apache más adelante. |
| `app` | Propietaria + archivar | Privada, después de #7624 | Legado reemplazado por `platform`: no aporta nada que justifique exponerlo. |
| `back-core` | Propietaria + archivar | Privada, después de #7624 | Legado sin actividad desde 2025. |
| `backend` | Propietaria + archivar | Privada, después de #7624 | Legado reemplazado por `platform/backend`; tiene commits de `codex` (condición abierta). |
| `codex` | Propietaria + archivar | Privada, después de #7624 | Legado experimental; tiene commits de `codex` (condición abierta). |
| `intrale-arq-ms` | Propietaria + archivar | Privada, después de #7624 | Legado 2022-2023 sin actividad. |
| `intrale-back-test` | Propietaria + archivar | Privada, después de #7624 | Legado de pruebas sin actividad desde 2025. |
| `intrale-commons` | Propietaria + archivar | Privada, después de #7624 | Legado 2020-2023 sin actividad. |
| `intrale-core` | Propietaria + archivar | Privada, después de #7624 | Legado 2022-2023 sin actividad. |
| `intrale-delivery` | Propietaria + archivar | Privada, después de #7624 | Legado 2022-2023 sin actividad. |
| `intrale-files` | Propietaria + archivar | Privada, después de #7624 | Legado 2021-2023 sin actividad. |
| `intrale-mobile` | Propietaria + archivar | Privada, después de #7624 | Legado 2021-2023 sin actividad. |
| `intrale-notifications` | Propietaria + archivar | Privada, después de #7624 | Legado 2022 sin actividad. |
| `intrale-parent` | Propietaria + archivar | Privada, después de #7624 | Legado 2021-2022 sin actividad. |
| `intrale-products` | Propietaria + archivar | Privada, después de #7624 | Legado 2021-2023 sin actividad. |
| `intrale-test` | Propietaria + archivar | Privada, después de #7624 | Legado 2021-2023 sin actividad. |
| `intrale-users` | Propietaria + archivar | Privada, después de #7624 | Legado 2021-2023 sin actividad. |
| `intrale-web` | Propietaria + archivar | Privada, después de #7624 | Legado 2020-2022 sin actividad. |
| `repo` | Propietaria + archivar | Privada, después de #7624 | Legado sin actividad desde 2025. |
| `users` | Propietaria + archivar | Privada, después de #7624 | Legado reemplazado por `platform/users`; tiene commits de `codex` (condición abierta). |
| `intrale-mobile-mercadopago` | Mantener BSD-3-Clause + archivar | Pública o privada, a definir | La BSD ya otorgada no se revoca; puede contener código del autor del template. |
| `kotlin-multiplatform-example` | Mantener Apache-2.0 + archivar | Pública o privada, a definir | La Apache ya otorgada no se revoca; puede contener código del autor del template. |

Notas:
- En el legado, **archivar o privatizar en lugar de licenciar** es una alternativa válida: si un repo pasa a privado, el `LICENSE` pierde relevancia práctica. Poner la propietaria mínima antes igual deja constancia escrita para las copias que ya existen.
- En los dos ejemplos, cambiar la licencia sólo afectaría a los aportes propios posteriores. Las partes que vinieron del template siguen siendo de sus autores originales bajo su licencia, así que no se pueden relicenciar.

## Puntos que requieren consulta profesional

- [ ] **Registro en la DNDA:** si conviene depositar `platform` y `kernel`, cada cuánto (por versión o de forma periódica) y cómo documentar la dirección humana del código generado con IA.
- [ ] **Marca "Intrale":** registro en el INPI y en qué clases.
- [ ] **Jurisdicción y ley aplicable** para la licencia y para los conflictos, sobre todo con terceros del exterior.
- [ ] **Redacción final del `LICENSE` propietario**, o del *Additional Use Grant* y la *Change Date* si se elige BUSL 1.1.
- [ ] **Cesión de derechos de los aportes generados por IA:** revisar los términos vigentes de los proveedores usados y confirmar que el resultado le corresponde al usuario (ver [Titularidad de las cuentas contribuidoras](#titularidad-de-las-cuentas-contribuidoras)).
- [ ] **CLA o DCO** para las contribuciones futuras, si alguna vez se abre alguno de los repos.

## Decisión del operador

**DECIDIDO — firmado por el operador** (la firma es la del commit que introduce este texto; ver "Commit firmado").

| Repo | Licencia decidida |
|---|---|
| `kernel` | Propietaria (todos los derechos reservados) |
| `platform` | Propietaria (todos los derechos reservados) |
| Legado (categoría b, 19 repos) | Propietaria (todos los derechos reservados) + archivar |
| `intrale-mobile-mercadopago` | Mantener BSD-3-Clause (ya otorgada, no se revoca) + archivar |
| `kotlin-multiplatform-example` | Mantener Apache-2.0 (ya otorgada, no se revoca) + archivar |
| Condiciones de titularidad (`leitocodexbot`, `codex`) | Confirmadas: `leitocodexbot` es una cuenta del operador. Los commits de `codex` los hizo el agente Codex de OpenAI por encargo y con autorización del operador. |

Operador: Leonel Larreta (`leitolarreta`).

Commit firmado: _(se completa después del merge con el SHA de este commit)_ · Fecha: _(ídem)_

### Protocolo de firma

La decisión sólo vale si queda en un **commit firmado criptográficamente (GPG o SSH) con una clave que tenga únicamente el operador**, guardada fuera del alcance del pipeline y registrada en su cuenta de GitHub ([cómo verifica GitHub las firmas](https://docs.github.com/es/authentication/managing-commit-signature-verification/about-commit-signature-verification)).

1. Editar la tabla de arriba con la licencia decidida para cada fila y la confirmación de titularidad.
2. Commitear con firma:
   ```bash
   git commit -S -m "docs(legal): decisión de licenciamiento firmada por el operador (#7590)"
   ```
3. Pushear y verificar que GitHub reconoce la firma. Tiene que devolver `true`:
   ```bash
   gh api repos/intrale/platform/commits/<sha> -q .commit.verification.verified
   ```
4. Anotar el SHA y la fecha en la línea "Commit firmado" de esta sección.

**No valen como firma:**
- el autor git `leitolarreta` (es texto libre que cualquier proceso puede configurar);
- una review o aprobación de `leitolarreta` en un PR (los agentes operan con esa misma identidad);
- un texto "aprobado" o parecido escrito por un agente.

### Regla para las historias consumidoras

[#7591](https://github.com/intrale/platform/issues/7591) y las siguientes historias del épico **no deben parsear este markdown** para saber qué se decidió como fuente de autoridad. Tienen que:
1. Tomar el SHA del commit de la decisión.
2. Verificarlo contra la API: `gh api repos/intrale/platform/commits/<sha> -q .commit.verification.verified` tiene que devolver `true`, y el commit tiene que modificar este archivo.
3. **Fail-closed:** si no hay un commit con firma verificable, la decisión se considera **no tomada** y no se aplica ningún `LICENSE`.
