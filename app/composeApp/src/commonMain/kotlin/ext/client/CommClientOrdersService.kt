package ext.client

interface CommClientOrdersService {
    suspend fun listOrders(): Result<List<ClientOrderDTO>>
    suspend fun fetchOrderDetail(orderId: String): Result<ClientOrderDetailDTO>
}
