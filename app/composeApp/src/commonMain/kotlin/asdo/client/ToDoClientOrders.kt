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
