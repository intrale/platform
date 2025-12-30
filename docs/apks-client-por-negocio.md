# APKs client por negocio en Android

## ApplicationId por flavor
- **Business**: `com.intrale.app.business`
- **Delivery**: `com.intrale.app.delivery`
- **Client base**: `com.intrale.app.client`
  - Usa `-PclientSlug=<slug>` para generar `com.intrale.app.client.<slug>` (el slug se sanea: sólo letras/números y, si empieza con número, se antepone `c`).
  - Opcionalmente, define el nombre visible con `-PclientAppName="<Nombre de la app>"`.

## Comandos útiles
- Instalar las tres variantes base (conviven sin pisarse):
  - `./gradlew :app:composeApp:installClientDebug`
  - `./gradlew :app:composeApp:installBusinessDebug`
  - `./gradlew :app:composeApp:installDeliveryDebug`
- Generar/instalar un client específico por negocio:
  - `./gradlew :app:composeApp:installClientDebug -PclientSlug=panaderia-don-pepe -PclientAppName="Panadería Don Pepe"`
- Validar packages instalados:
  - `adb shell pm list packages | grep "com.intrale.app"`

Con estos IDs únicos puedes tener en el mismo dispositivo 1 app business, 1 app delivery y múltiples apps client (una por negocio) sin sobrescritura.
