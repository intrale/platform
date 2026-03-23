package asdo.client

interface ToDoGetClientOrders {
    suspend fun execute(): Result<List<ClientOrder>>
}

interface ToDoGetClientOrderDetail {
    suspend fun execute(orderId: String): Result<ClientOrderDetail>
}

data class RepeatOrderResult(
    val addedItems: List<ClientOrderItem>,
    val skippedItems: List<ClientOrderItem>
)

interface ToDoRepeatOrder {
    suspend fun execute(order: ClientOrderDetail): Result<RepeatOrderResult>
}

data class CreateOrderItemData(
    val productId: String,
    val productName: String,
    val quantity: Int,
    val unitPrice: Double
)

data class CreateOrderResult(
    val orderId: String,
    val publicId: String,
    val shortCode: String,
    val total: Double
)

interface ToDoCreateOrder {
    suspend fun execute(
        items: List<CreateOrderItemData>,
        addressId: String,
        paymentMethodId: String
    ): Result<CreateOrderResult>
}
