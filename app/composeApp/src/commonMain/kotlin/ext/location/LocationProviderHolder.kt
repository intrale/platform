package ext.location

/**
 * Holder global que permite a `MainActivity` registrar la implementación
 * Android-específica de [CommLocationProvider] (que requiere `Context`)
 * sin acoplar el módulo `commonMain` a `android.*`.
 *
 * Patrón equivalente al de `PushNotificationDisplay`: la interface vive
 * en `commonMain`, la implementación en `androidMain`, y el binding en
 * Kodein delega lecturas a este holder para que `AddressCheckViewModel`
 * pueda inyectar el contrato común sin conocer la plataforma.
 *
 * El holder solo guarda una referencia de instancia; nunca persiste estado.
 */
object LocationProviderHolder {
    @Volatile
    private var current: CommLocationProvider = NoOpLocationProvider()

    fun set(provider: CommLocationProvider) {
        current = provider
    }

    fun get(): CommLocationProvider = current
}

/**
 * Adapter que permite bindear `LocationProviderHolder` en Kodein como un
 * singleton estable: la búsqueda en el holder ocurre en cada llamada, así
 * que `MainActivity` puede registrar la implementación Android tarde sin
 * romper el cache del DI.
 */
class HolderBackedLocationProvider : CommLocationProvider {
    override fun isAvailable(): Boolean = LocationProviderHolder.get().isAvailable()
    override suspend fun requestCoarseLocation(): LocationOutcome =
        LocationProviderHolder.get().requestCoarseLocation()
    override suspend fun geocodeAddress(query: String): LocationOutcome =
        LocationProviderHolder.get().geocodeAddress(query)
}
