package ext.location

/**
 * Resultado de una solicitud de ubicación o geocodificación. La UI no necesita
 * conocer la diferencia entre "permiso denegado", "GPS apagado" o "geocoder
 * sin resultados" — el rationale + fallback manual cubre todos los casos.
 */
sealed class LocationOutcome {
    data class Coordinates(val latitude: Double, val longitude: Double) : LocationOutcome()
    object PermissionDenied : LocationOutcome()
    object Unavailable : LocationOutcome()
    object NotFound : LocationOutcome()
    data class Error(val message: String) : LocationOutcome()
}

/**
 * Wrapper de servicios de ubicación (Fused Location + Geocoder).
 *
 * Diseño multiplataforma:
 * - Vive en `commonMain` para que el ViewModel del flujo de verificación
 *   (`AddressCheckViewModel`) compile en todos los targets.
 * - La implementación real es Android-only (`AndroidLocationProvider` en
 *   `androidMain`); plataformas no-Android usan [NoOpLocationProvider] que
 *   responde [LocationOutcome.Unavailable].
 *
 * Privacidad (CA-5 / CA-7):
 * - Las implementaciones NO deben loggear `latitude`, `longitude`,
 *   `Address`, `Location`. El loop con coordenadas debe quedar dentro de
 *   memoria y morir cuando el ViewModel se descarta.
 * - El proveedor NUNCA persiste la última posición; cada llamada solicita
 *   nuevamente al sistema.
 */
interface CommLocationProvider {
    /**
     * Indica si la plataforma soporta solicitar ubicación. En no-Android es
     * siempre false; en Android depende de Play Services + permiso runtime.
     */
    fun isAvailable(): Boolean

    /**
     * Solicita la ubicación coarse actual del dispositivo. Debe llamarse
     * SOLO después de que el usuario concedió el permiso runtime.
     */
    suspend fun requestCoarseLocation(): LocationOutcome

    /**
     * Convierte una dirección textual ingresada manualmente por el usuario
     * en coordenadas. Tolerante a formato (Geocoder.getFromLocationName).
     */
    suspend fun geocodeAddress(query: String): LocationOutcome
}

/**
 * Implementación no-op para plataformas sin soporte (iOS / Desktop / Wasm /
 * tests unitarios fuera del flujo Android). Devuelve siempre Unavailable.
 */
class NoOpLocationProvider : CommLocationProvider {
    override fun isAvailable(): Boolean = false
    override suspend fun requestCoarseLocation(): LocationOutcome = LocationOutcome.Unavailable
    override suspend fun geocodeAddress(query: String): LocationOutcome = LocationOutcome.Unavailable
}
