# Guía para Testers — Firebase App Distribution

**Versión:** 1.0
**Actualizado:** 2026-03-13
**Audiencia:** Testers Friends & Family del programa Intrale Platform

---

## ¿Qué es Firebase App Distribution?

Es el canal oficial de distribución de las apps Android de Intrale para el programa Friends & Family.
Permite instalar las 3 apps directamente en tu dispositivo **sin necesidad de Play Store ni cuenta de desarrollador**.

## Requisitos previos

- Dispositivo Android con Android 6.0 o superior
- Cuenta de Google (Gmail) — la que el equipo de Intrale haya registrado como tester
- Conexión a internet

---

## Paso 1: Activar instalación desde fuentes desconocidas

Antes de la primera instalación, debés permitir la instalación de APKs externos:

1. Abrí **Configuración** → **Seguridad** (o **Privacidad**, según el dispositivo)
2. Buscá la opción **"Instalar apps desconocidas"** o **"Fuentes desconocidas"**
3. Habilitá la opción para el navegador que vas a usar (Chrome, Firefox, etc.)

> **Nota:** Esta configuración varía según el fabricante y la versión de Android. Si no la encontrás, buscá en tu ajustes "instalar apps" o consultá al equipo.

---

## Paso 2: Aceptar la invitación

Cuando hay una nueva versión disponible, recibirás un **email de Firebase** con asunto similar a:
> "You've been invited to test [Nombre de la app]"

1. Abrí el email desde tu dispositivo Android
2. Tocá el botón **"Download latest build"** o **"Descargar build"**
3. Se abrirá la consola de Firebase App Distribution en el navegador

---

## Paso 3: Instalar la app

1. En la consola de Firebase, tocá **"Download"** junto a la versión más reciente
2. Si es la primera vez, te pedirá instalar la app complementaria **Firebase App Tester** — seguí el proceso guiado (opcional pero recomendado para recibir notificaciones automáticas)
3. Una vez descargado el APK, tocá **"Instalar"** cuando el sistema lo solicite
4. Si aparece un aviso de seguridad, tocá **"Instalar de todos modos"** (el APK es legítimo)

---

## Paso 4: Usar la app

Las 3 apps disponibles son:

| App | Nombre | Descripción |
|-----|--------|-------------|
| **Intrale** | `com.intrale.app.client` | App para clientes — realizar pedidos |
| **Intrale Negocios** | `com.intrale.app.business` | App para negocios — gestionar pedidos y productos |
| **Intrale Repartos** | `com.intrale.app.delivery` | App para repartidores — gestionar entregas |

---

## Cómo recibir actualizaciones

### Opción A: Email (automático)
Cada vez que se sube una nueva versión, recibirás un email automático con el link de descarga.

### Opción B: App Firebase App Tester (recomendado)
Si instalaste la app complementaria **Firebase App Tester**:
1. Abrí la app
2. Verás las apps disponibles y si hay actualizaciones
3. Tocá "Actualizar" para descargar la nueva versión

---

## Reportar problemas

Si encontrás un bug o tenés feedback, reportalo por Telegram al canal del grupo.

Incluí:
- Nombre de la app (Intrale / Intrale Negocios / Intrale Repartos)
- Versión del build (número visible en la pantalla de Firebase o en la sección "Acerca de" de la app)
- Descripción del problema paso a paso
- Capturas de pantalla si es posible

---

## Preguntas frecuentes

**¿Necesito una cuenta de Google Play?**
No. La instalación es directa y no requiere Play Store.

**¿La app consumirá mis datos?**
Solo cuando usás las funcionalidades de red (login, cargar pedidos, etc.). La descarga del APK sí consume datos.

**¿Es seguro instalar APKs externos?**
Los APKs de Firebase App Distribution están firmados por el equipo de Intrale. Solo instalá APKs que lleguen por el email oficial de Firebase.

**¿Cómo sé qué versión tengo instalada?**
Podés verlo en la app Firebase App Tester, o en Configuración → Aplicaciones → [Nombre de la app] → Versión.

**¿Puedo tener las 3 apps instaladas al mismo tiempo?**
Sí. Son apps independientes con IDs distintos.

---

## Contacto

Para problemas de acceso o invitaciones al grupo de testers, escribí al equipo de Intrale por los canales acordados.
