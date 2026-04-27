package ar.com.intrale.shared.client

import kotlinx.serialization.Serializable

/**
 * Body de la verificación de zona enviado al backend
 * (`POST /{business}/zones/check`).
 *
 * Privacidad (CA-5 / CA-7):
 * - Estos campos viajan UNICAMENTE en el body de la request bajo HTTPS.
 * - Cliente y backend NO deben loggear lat/lng. Cualquier interceptor de
 *   tracing debe censurar este endpoint.
 */
@Serializable
data class ZoneCheckRequest(
    val latitude: Double,
    val longitude: Double,
)

/**
 * Respuesta de la verificación de zona.
 *
 * El cliente valida `shippingCost ∈ [0, 100_000]` antes de exponer la card
 * positiva al usuario (CA-6). Fuera de rango devuelve error genérico.
 */
@Serializable
data class ZoneCheckResponse(
    val inZone: Boolean = false,
    val shippingCost: Double? = null,
    val etaMinutes: Int? = null,
    val zoneId: String? = null,
)
