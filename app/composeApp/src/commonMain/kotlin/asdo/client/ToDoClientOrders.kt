package asdo.client

interface ToDoGetClientOrders {
    suspend fun execute(): Result<List<ClientOrder>>
}

interface ToDoGetClientOrderDetail {
    suspend fun execute(orderId: String): Result<ClientOrderDetail>
}

data class RepeatOrderResult(
    val addedItems: List<ClientOrderItem>,
    val skippedItems: List<SkippedItem>
)

/**
 * Item omitido al repetir pedido, con el motivo de exclusión del backend.
 */
data class SkippedItem(
    val item: ClientOrderItem,
    val reason: ar.com.intrale.shared.client.SkipReason
)

interface ToDoRepeatOrder {
    suspend fun execute(order: ClientOrderDetail): Result<RepeatOrderResult>
}

data class CreateClientOrderParams(
    val items: List<CreateClientOrderItem>,
    val addressId: String?,
    val paymentMethodId: String?,
    val notes: String?
)

data class CreateClientOrderItem(
    val productId: String,
    val productName: String,
    val quantity: Int,
    val unitPrice: Double
)

data class CreateClientOrderResult(
    val orderId: String,
    val shortCode: String,
    val status: String
)

interface ToDoCreateClientOrder {
    suspend fun execute(params: CreateClientOrderParams): Result<CreateClientOrderResult>
}
