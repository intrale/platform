package ext.client

import ar.com.intrale.shared.client.ClientOrderDTO
import ar.com.intrale.shared.client.ClientOrderDetailDTO
import ar.com.intrale.shared.client.CreateOrderRequestDTO
import ar.com.intrale.shared.client.CreateOrderResponseDTO

interface CommClientOrdersService {
    suspend fun listOrders(): Result<List<ClientOrderDTO>>
    suspend fun fetchOrderDetail(orderId: String): Result<ClientOrderDetailDTO>
    suspend fun createOrder(request: CreateOrderRequestDTO): Result<CreateOrderResponseDTO>
}
