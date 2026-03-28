package ext.client

import ar.com.intrale.shared.client.ClientOrderDTO
import ar.com.intrale.shared.client.ClientOrderDetailDTO
import ar.com.intrale.shared.client.CreateClientOrderRequestDTO
import ar.com.intrale.shared.client.CreateClientOrderResponseDTO

interface CommClientOrdersService {
    suspend fun listOrders(): Result<List<ClientOrderDTO>>
    suspend fun fetchOrderDetail(orderId: String): Result<ClientOrderDetailDTO>
    suspend fun createOrder(request: CreateClientOrderRequestDTO): Result<CreateClientOrderResponseDTO>
}
