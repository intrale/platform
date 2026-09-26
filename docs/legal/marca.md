# Marca del proyecto — disponibilidad, registro y costo de renombrar

Alcance: marca del producto **Intrale** (las apps cliente, Intrale Negocios e Intrale Repartos). No cubre el kernel/pipeline, que es un producto aparte.

> **No somos abogados.** Todo lo marcado con ⚖️ (requiere abogado) necesita consulta profesional antes de actuar. Los montos y plazos son aproximados y tienen fecha: si pasaron más de 3 meses, hay que volver a consultarlos.

Historia: #7600 · Épico: #7589 · Fecha del relevamiento: 2026-09-23

## Resumen para decidir

- **Riesgo de conflicto: medio.** En las tiendas no aparece ninguna app llamada "Intrale", pero **el dominio `intrale.com` está registrado por un tercero desde 2003** (no hay evidencia en el repo de que sea nuestro) y los registros de marcas (INPI, WIPO) no se pudieron consultar de forma automática.
- **Registrar en Argentina cuesta poco:** unos $40.000 por clase en tasas del INPI (septiembre 2026), o sea ~$80.000 para las 2 clases base, más los honorarios de un agente de marcas si se usa uno. Tarda de 12 a 24 meses. ⚖️ (requiere abogado)
- **Renombrar hoy es barato; en un año puede ser caro.** Hoy ninguna app está publicada en Google Play ni en App Store, así que el nombre visible se cambia con un puñado de archivos. Una vez publicadas, el identificador de cada app en la tienda queda congelado y los clientes ya conocen el nombre.
- **Opciones:** 1 registrar · 2 esperar · 3 renombrar. Decisión del operador (2026-09-26): **esperar** (ver §4).

## 1. Disponibilidad y riesgo de conflicto

| Fuente | Búsqueda | Resultado | Fecha de consulta |
|---|---|---|---|
| INPI (Argentina) | "intrale", clases 9 y 42 | `no consultada` — el buscador del INPI requiere formulario web interactivo, no accesible desde el agente | 2026-09-23 |
| WIPO Global Brand Database | "intrale" | `no consultada` — la base es una aplicación web interactiva, no accesible desde el agente | 2026-09-23 |
| Google Play | búsqueda "intrale" | ✅ libre: sin apps con ese nombre (lo más parecido: "Intra Mini", "Intrare Empresa") | 2026-09-23 |
| Google Play | `com.intrale.app.client` / `.business` / `.delivery` | ✅ no publicadas: las 3 fichas devuelven 404 | 2026-09-23 |
| App Store (AR y US) | búsqueda "intrale" | ✅ libre: AR 0 resultados; US 27 resultados, ninguno llamado "Intrale" | 2026-09-23 |
| Dominio `intrale.com` | RDAP de Verisign + HTTP | ⚠️ ocupado: registrado en 2003, vence 2028-02-12, sirve un sitio WordPress en italiano. Titularidad **pendiente del operador** (confirmar si es propio) | 2026-09-23 |
| Dominio `intrale.com.ar` | RDAP de NIC.ar + DNS | ✅ libre: NIC.ar devuelve 404 y el DNS no existe | 2026-09-23 |
| Dominios `intrale.app`, `intrale.net`, `intrale.io` | DNS | ✅ aparentemente libres (sin DNS; confirmar en el registrador antes de comprar) | 2026-09-23 |

**Variantes cercanas (typosquatting):**

- `intralle.com` — sin DNS, aparentemente libre.
- `intral.com` — ⚠️ ocupado (tercero, detrás de Cloudflare).
- `intrail.com` — ⚠️ ocupado (tercero).
- Apps parecidas en tiendas: "Intra Mini", "Intrare Empresa" (México). Nombres distintos, bajo riesgo de confusión, pero conviene tenerlos presentes.

**Dominios defensivos sugeridos** (si se decide registrar la marca): `intrale.com.ar` (prioridad alta, está libre y es la jurisdicción propia), `intrale.app` y `intralle.com.ar`.

**Hallazgo lateral:** el repo usa direcciones `@intrale.com` como usuarios de prueba (CI en `.github/workflows/pr-checks.yml`, flujos de `.maestro/`, evidencia de `qa/`). Si el dominio no es nuestro, esos emails (por ejemplo, los de recuperación de contraseña de QA) podrían terminar en un servidor ajeno. No se corrige en esta historia (alcance acotado); si se confirma que el dominio no es propio, amerita una historia aparte.

**Riesgo: medio.** Las tiendas están libres y no apareció ninguna marca de software con ese nombre, pero el `.com` es de un tercero y los registros de marca no se consultaron. Antes de registrar hace falta la búsqueda de anterioridad en INPI. ⚖️ (requiere abogado)

## 2. Costo y plazo aproximados de registro

| Registro | Qué protege | Costo aproximado | Plazo estimado | Fuente (fecha) |
|---|---|---|---|---|
| INPI clase 9 (base) | Software y apps descargables | $39.735 de tasa por clase (100 UMAPI); rango práctico $40.000–$60.000 con actualización mensual por IPC. Honorarios de agente aparte ⚖️ | 12–24 meses hasta la concesión ⚖️ | Aranceles INPI, Res. 75/2026, UMAPI de agosto 2026 (2026-09-23) |
| INPI clase 42 (base) | Software como servicio y plataformas en línea | Igual que la clase 9 ⚖️ | Igual ⚖️ | Ídem |
| INPI clase 35 (opcional) | Comercio y gestión de negocios: sólo si la plataforma se presenta como marketplace o servicio comercial | Igual, por clase ⚖️ | Igual ⚖️ | Ídem |
| INPI clase 39 (opcional) | Transporte y reparto: sólo si Intrale Repartos se ofrece como servicio de reparto propio, no sólo como software | Igual, por clase ⚖️ | Igual ⚖️ | Ídem |
| USPTO / Sistema de Madrid | Protección fuera de Argentina | Sólo si hay expansión internacional; se cotiza en ese momento ⚖️ | — | — |

- Base recomendada: clases 9 + 42, con un costo aproximado de $80.000–$120.000 en tasas (septiembre 2026). ⚖️ (requiere abogado)
- La tasa se actualiza todos los meses (UMAPI por IPC): el monto de hoy no es el de dentro de 30 días.
- La renovación es cada 10 años y tiene su propio arancel. ⚖️ (requiere abogado)
- Fuentes: [Aranceles INPI — argentina.gob.ar](https://www.argentina.gob.ar/inpi/aranceles-inpi), [Aranceles del INPI agosto 2026](https://unamarca.com.ar/aranceles-inpi/).

## 3. Costo de renombrar: ahora vs. en un año

**Dato de entrada: ¿alguna app está publicada en Play/App Store? — No.**
Verificado el 2026-09-23: las fichas de Google Play de `com.intrale.app.client`, `com.intrale.app.business` y `com.intrale.app.delivery` devuelven 404, y la búsqueda "intrale" en App Store (AR) devuelve 0 resultados. Límite: una app en prueba cerrada o interna no aparece en la tienda pública; si existe alguna, lo confirma el operador desde la consola.

**Dos cosas distintas:**

- **Marca visible:** lo que ve el usuario. Es el nombre de la app en el celular y en la tienda (`app_name`: "Intrale Negocios" / "Intrale Repartos"), el ícono y los textos. Esto se puede renombrar.
- **Identificador técnico:** el `applicationId` (el identificador de la app en la tienda, que no se puede cambiar una vez publicada) y el paquete interno `ar.com.intrale`. **Esto no se renombra**: el usuario no lo ve, y cambiarlo después de publicar obliga a publicar una app nueva y migrar a los usuarios.

| Superficie | Hoy | En un año (con apps publicadas) |
|---|---|---|
| Nombre visible (`app_name` en `app/composeApp/build.gradle.kts`, catálogos `DefaultCatalog_es/en.kt`) | Barato: pocos archivos | Barato en código; caro en reputación (clientes que ya conocen el nombre) |
| Assets (`docs/branding/icon-pack`, `docs/branding/icons`) | Costo de diseño, sin costo técnico | Igual, más volver a subir las capturas a las tiendas |
| `applicationId` de los 3 flavors (`com.intrale.app.*`) | Se puede cambiar, pero no hace falta (es invisible) | **No se puede cambiar**: se deja como está |
| Paquete `ar.com.intrale` | No se toca | No se toca |
| Dominios, DNS, TLS y email | Moderado: comprar el dominio nuevo y mover la config | Alto: clientes, links y emails apuntando al dominio viejo |
| Cognito (dominio, callbacks/redirects, orígenes) | Moderado | Alto: hay que convivir con los dos dominios durante la migración |
| Org `intrale` y repos de GitHub | Moderado-alto: rompe clones, worktrees y rutas del pipeline | Igual; no depende de la publicación |
| Infra de AWS (Lambda, buckets, user pool) | Nombres internos: no hace falta renombrar | Igual |

**Inventario medido el 2026-09-23 sobre `origin/main` (355ae0825):**

| Qué | Comando | Resultado |
|---|---|---|
| Archivos que mencionan "intrale" | `git grep -il intrale origin/main -- . \| wc -l` | 3.678 (666 son `.kt`) |
| Referencias a `com.intrale.app` | `git grep -n 'com\.intrale\.app' origin/main -- . \| wc -l` | 142 |
| Referencias a `intrale.com` | `git grep -n 'intrale\.com' origin/main -- . \| wc -l` | 252 (16 de ellas `intrale.com.ar`) |

La mayoría de las menciones son el paquete `ar.com.intrale` y documentación, que no cambian en un renombre de la marca visible. Las referencias a `com.intrale.app` están sobre todo en scripts de QA y pruebas E2E.

**Checklist de seguridad si algún día se renombra:**

- [ ] `applicationId` / bundle IDs: no cambiarlos en apps publicadas (serían apps nuevas).
- [ ] Clave de firma de las apps: no se rota como parte del renombre.
- [ ] Cognito: agregar el dominio nuevo a callbacks/redirects y orígenes; quitar el viejo recién después del corte.
- [ ] DNS, certificados TLS y remitentes de email (SPF, DKIM, DMARC) del dominio nuevo, configurados antes del corte.
- [ ] Dominios viejos: mantenerlos registrados y redirigiendo durante un plazo largo. **Nunca dejarlos vencer**: quien los registre recibe tráfico, emails de recuperación y callbacks de usuarios reales.
- [ ] Cuentas de las tiendas y del registrador de dominios a nombre del proyecto u operador (no de terceros) y con 2FA. Los datos del titular quedan en el store de credenciales/legales, nunca en el repo.

**Criterios para un nombre nuevo** (si se evalúa): que se pronuncie y escriba igual en español, que funcione con los sufijos ("X Negocios", "X Repartos") y que no se confunda con los nombres parecidos del §1.

**Conclusión:** hoy el costo dominante de renombrar no es el código sino **el dominio y la infra** (DNS, Cognito, GitHub). Con apps publicadas dentro de un año se suma lo más caro: el nombre ya instalado en los celulares y en la cabeza de los clientes, y el `applicationId` congelado. Si hay dudas sobre el nombre, el momento barato para decidir es antes de la primera publicación.

## 4. Decisión del operador

- Decisión: **esperar** (opción 2) — no registrar ni renombrar por ahora; se revisa cuando el operador lo indique (o ante alguno de los disparadores de abajo). No bloquea ninguna otra tarea.
- Fecha: 2026-09-26
- Firmó: `leitolarreta` (decisión comunicada por Telegram al Commander, audit_ref `commander-2026-09-26-marca-7600`)
- Fuente: comentario "Decisión del operador sobre la marca" del 2026-09-26 (01:37 UTC) en el [issue #7600](https://github.com/intrale/platform/issues/7600), en respuesta al pedido de decisión del mismo issue

Antecedente (no es decisión): el 2026-09-22 el operador dijo que la marca no le preocupa mucho y que, llegado el caso, se podría renombrar.

**Disparadores para revisar la decisión:**

- Antes de la primera publicación de cualquier app en Google Play o App Store.
- Si aparece un conflicto (reclamo de un tercero, marca parecida registrada en INPI, app homónima en tiendas).
- Si se confirma que `intrale.com` no es propio y no se puede adquirir.
- Si hay expansión a otro país.
