package asdo.client

interface ToDoGetClientOrders {
    suspend fun execute(): Result<List<ClientOrder>>
}

interface ToDoGetClientOrderDetail {
    suspend fun execute(orderId: String): Result<ClientOrderDetail>
}

data class RepeatOrderResult(
    val addedItems: List<ClientOrderItem>,
    val skippedItems: List<SkippedItem>,
    val priceChangedItems: List<PriceChange> = emptyList()
)

/**
 * Item omitido al repetir pedido, con el motivo de exclusión del backend.
 */
data class SkippedItem(
    val item: ClientOrderItem,
    val reason: ar.com.intrale.shared.client.SkipReason
)

/**
 * Producto cuyo precio cambió respecto al pedido original.
 */
data class PriceChange(
    val item: ClientOrderItem,
    val currentPrice: Double,
    val difference: Double
)

interface ToDoRepeatOrder {
    suspend fun execute(order: ClientOrderDetail, businessId: String? = null): Result<RepeatOrderResult>
}

/**
 * Parametros para crear un pedido (issue #2424).
 *
 * Tamper-proofing (Security A04 - CA-8): este data class NUNCA debe definir
 * un campo `shippingCost`. El backend es la fuente unica de verdad del precio
 * de envio, calculado server-side desde `{businessId, lat, lng, zoneId}` y
 * persistido como snapshot inmutable (issue #2415).
 *
 * `zoneId` se envia solo como hint; el backend revalida la zona consultando
 * point-in-polygon con `lat`/`lng`.
 */
data class CreateClientOrderParams(
    val items: List<CreateClientOrderItem>,
    val addressId: String?,
    val paymentMethodId: String?,
    val notes: String?,
    val businessId: String? = null,
    val lat: Double? = null,
    val lng: Double? = null,
    val zoneId: String? = null
)

data class CreateClientOrderItem(
    val productId: String,
    val productName: String,
    val quantity: Int,
    val unitPrice: Double
)

/**
 * Resultado autoritativo de creacion de pedido. `shippingCost` y `zoneName`
 * provienen del backend (recalculados + persistidos), nunca del valor local.
 */
data class CreateClientOrderResult(
    val orderId: String,
    val shortCode: String,
    val status: String,
    val shippingCost: Double? = null,
    val zoneName: String? = null
)

interface ToDoCreateClientOrder {
    suspend fun execute(params: CreateClientOrderParams): Result<CreateClientOrderResult>
}
