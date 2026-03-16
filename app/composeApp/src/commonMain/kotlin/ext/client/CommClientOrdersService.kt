package ext.client

import ar.com.intrale.shared.client.ClientOrderDTO
import ar.com.intrale.shared.client.ClientOrderDetailDTO

interface CommClientOrdersService {
    suspend fun listOrders(): Result<List<ClientOrderDTO>>
    suspend fun fetchOrderDetail(orderId: String): Result<ClientOrderDetailDTO>
}
