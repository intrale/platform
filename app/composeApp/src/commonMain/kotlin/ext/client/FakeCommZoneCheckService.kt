package ext.client

import ar.com.intrale.shared.client.ZoneCheckResponse

/**
 * Implementación falsa de [CommZoneCheckService] para usar en builds locales,
 * tests E2E con AVD y mientras el backend de #2415 no está deployado.
 *
 * Política de fixtures (heurística determinística):
 * - Coordenadas en CABA aproximada (lat ∈ [-34.7, -34.5]) → `inZone=true`.
 * - Cualquier otra coordenada válida → `inZone=false`.
 * - `shippingCost` se calcula como una función simple de la latitud (no del
 *   par lat/lng) para mantener el fake reproducible y que las verificaciones
 *   de log no levanten falsos positivos.
 *
 * Esta clase NO loggea las coordenadas para mantener la consistencia con el
 * cliente real (CA-7).
 */
class FakeCommZoneCheckService(
    private val forceInZone: Boolean? = null,
    private val forceShippingCost: Double? = null,
    private val forceFailure: Throwable? = null,
) : CommZoneCheckService {

    override suspend fun checkZone(
        latitude: Double,
        longitude: Double
    ): Result<ZoneCheckResponse> {
        forceFailure?.let { return Result.failure(it) }

        val inZone = forceInZone ?: (latitude in CABA_MIN_LAT..CABA_MAX_LAT)
        val shippingCost = forceShippingCost
            ?: if (inZone) DEFAULT_SHIPPING_COST else 0.0
        val eta = if (inZone) DEFAULT_ETA_MIN else null
        return Result.success(
            ZoneCheckResponse(
                inZone = inZone,
                shippingCost = shippingCost,
                etaMinutes = eta,
                zoneId = if (inZone) "fake-zone-default" else null,
            )
        )
    }

    companion object {
        private const val CABA_MIN_LAT: Double = -34.70
        private const val CABA_MAX_LAT: Double = -34.50
        private const val DEFAULT_SHIPPING_COST: Double = 1500.0
        private const val DEFAULT_ETA_MIN: Int = 30
    }
}
