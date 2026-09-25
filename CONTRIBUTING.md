# Cómo contribuir a Intrale

> **English summary.** This repository is public but **proprietary (all rights reserved)** — it is not open source. Contributions are welcome, but before we can merge a pull request, every commit author must accept our [Contributor License Agreement (CLA)](docs/legal/CLA.md). You keep the copyright of your work; you grant us a broad license so we can use and relicense it. To sign, comment the exact sentence below on your pull request, from the account that made the commits. The `contribution-agreement` check turns green automatically in a minute or two.
>
> ```
> I have read the Intrale CLA and I hereby sign it
> ```

¡Gracias por querer aportar! Esta guía explica cómo mandar un cambio y qué tenés que aceptar para que lo podamos integrar.

## Cómo contribuir

1. Hacé un fork del repositorio y creá una rama para tu cambio.
2. Mantené el cambio chico y enfocado en un solo tema. Si es grande, abrí primero un issue para conversarlo.
3. Asegurate de que el proyecto compila y los tests pasan (`./gradlew check --no-daemon`).
4. Abrí un pull request contra `main` explicando qué cambia y por qué.
5. Aceptá el acuerdo de contribución (ver abajo). Es un trámite de una sola vez.

## El acuerdo de contribución (CLA) en 30 segundos

**Qué es.** Un [Acuerdo de Licencia de Contribución](docs/legal/CLA.md): vos seguís siendo el autor y dueño de tu aporte, y nos das permiso amplio y permanente para usarlo, modificarlo, distribuirlo y cambiarle la licencia. **No nos cedés el copyright.**

**Por qué lo pedimos.** Este repositorio es público, pero **no es open source**: el código es propietario, con todos los derechos reservados. Si integráramos tu aporte sin un acuerdo, esa parte del código seguiría bajo tu copyright y no podríamos usarla en una versión comercial ni cambiar la licencia del proyecto sin pedirte permiso cada vez.

**Por qué CLA y no DCO.** El DCO (*Developer Certificate of Origin*) sólo certifica que el código es tuyo y que lo entregás bajo la licencia del proyecto. Como acá la licencia es propietaria, eso no nos da los permisos que necesitamos. El CLA sí: es una licencia explícita sobre tu aporte.

**Cómo firmarlo.** Comentá en tu pull request exactamente esta frase, desde la cuenta de GitHub que hizo los commits:

```
I have read the Intrale CLA and I hereby sign it
```

Tiene que ser la frase sola, sin nada antes ni después. En uno o dos minutos el chequeo `contribution-agreement` se pone en verde solo, sin que nadie tenga que hacer nada.

**Si en tu pull request hay commits de otras personas**, cada una tiene que comentar la frase desde su propia cuenta. Los commits tienen que estar hechos con una cuenta de GitHub: si el email del commit no está vinculado a ninguna cuenta, no se puede firmar y hay que rehacer el commit con un email de tu cuenta.

Firmás una sola vez: en tus próximos pull requests no se te vuelve a pedir, mientras el texto del acuerdo no cambie.

## Qué pasa si no firmás

El chequeo `contribution-agreement` queda en rojo y el pull request **no se puede integrar**. No se pierde nada: podés firmar cuando quieras y el chequeo se actualiza.

## Qué pasa si cambia el acuerdo

La firma queda atada al texto exacto del acuerdo. Si el texto cambia, **aunque sea para corregir una errata**, hay que volver a firmar comentando la misma frase en el pull request.

## Si el chequeo falla por un error técnico

Si el chequeo muestra "No se pudo verificar el CLA", no es un problema tuyo: falló la verificación. Un mantenedor puede volver a ejecutarla. Si pasa un rato y sigue igual, dejá un comentario en el pull request avisando.

## Qué datos guardamos

Sólo el ID numérico de tu cuenta de GitHub, tu nombre de usuario al momento de firmar, la fecha, el pull request y la versión del acuerdo. **No guardamos tu email ni otros datos personales.**

## Mientras el repositorio sea público

Este acuerdo aplica a los aportes externos mientras el repositorio sea público. Si en algún momento pasa a ser privado, dejará de recibir aportes externos por fork.

## Para mantenedores: cómo se tratan los aportes internos

- Los pull requests de miembros de la organización (`OWNER`/`MEMBER`) o de cuentas de la allowlist (por ID numérico) no requieren firma.
- Los commits **sin cuenta de GitHub vinculada** (por ejemplo, los de los agentes del pipeline, que commitean como `<skill>-agent@intrale`) se atribuyen al autor del pull request **sólo** si el pull request es interno **y** su rama vive en este mismo repositorio (no en un fork). Pushear a este repositorio exige permiso de escritura, así que el miembro que abre el pull request responde por esos commits. En un pull request externo o desde un fork, un commit sin cuenta sigue bloqueando el chequeo.
- Un commit con cuenta vinculada de alguien externo exige su firma aunque el pull request sea interno.
- GitHub no informa la pertenencia a la organización de los autores de commits. Un miembro que no está en la allowlist y no es el autor del pull request se trata como externo: si hace falta, agregá su ID numérico a la allowlist de `.pipeline/lib/contribution-agreement.js`.
