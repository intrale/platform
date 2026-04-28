package asdo.client

/**
 * Resultado de verificacion de direccion contra zonas del negocio.
 *
 * - [shippingCost] = `null` significa que el negocio NO tiene zonas configuradas;
 *   el flujo de envio queda deshabilitado (CA-5 / CA-14 del issue #2424).
 * - [shippingCost] = `0.0` significa "Envio gratis" (CA-4 del issue #2424).
 * - [shippingCost] > 0 es el costo verificado a aplicar en el checkout (CA-2/CA-3).
 *
 * Las coordenadas [lat]/[lng] son las verificadas en la pantalla de check-address
 * (Hija A del split #2417). NUNCA loguear coordenadas (Security A09 — CA-10).
 */
data class DoCheckAddressResult(
    val businessId: String,
    val addressId: String? = null,
    val lat: Double,
    val lng: Double,
    val zoneId: String? = null,
    val zoneName: String? = null,
    val shippingCost: Double? = null
)

/**
 * Caso de uso para verificar direccion + zona de cobertura del negocio.
 *
 * Esta interfaz es el contrato que la Hija A (#2422 — `App Cliente A`) implementa
 * con `DoCheckAddress` consumiendo `/zones/check`. Para esta hija C (#2424) la
 * abstraccion permite recalcular el `shippingCost` cuando el cliente cambia la
 * direccion en el checkout (CA-6).
 */
interface ToDoCheckAddress {
    suspend fun execute(
        businessId: String,
        addressId: String?,
        lat: Double,
        lng: Double
    ): Result<DoCheckAddressResult>
}
