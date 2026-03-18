package asdo.client

interface ToDoCreateOrder {
    suspend fun execute(request: CreateOrderInput): Result<CreateOrderOutput>
}

data class CreateOrderInput(
    val items: List<CreateOrderItemInput>,
    val addressId: String?,
    val notes: String?,
    val paymentMethod: String?
)

data class CreateOrderItemInput(
    val productId: String,
    val productName: String,
    val quantity: Int,
    val unitPrice: Double
)

data class CreateOrderOutput(
    val orderId: String,
    val shortCode: String,
    val status: String,
    val total: Double
)
