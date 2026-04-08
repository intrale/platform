package asdo.client

import ar.com.intrale.shared.client.SkipReason

interface ToDoGetClientOrders {
    suspend fun execute(): Result<List<ClientOrder>>
}

interface ToDoGetClientOrderDetail {
    suspend fun execute(orderId: String): Result<ClientOrderDetail>
}

/**
 * Item excluido al repetir un pedido, con el motivo de exclusion.
 */
data class SkippedItem(
    val item: ClientOrderItem,
    val reason: SkipReason
)

data class RepeatOrderResult(
    val addedItems: List<ClientOrderItem>,
    val skippedItems: List<SkippedItem>
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
