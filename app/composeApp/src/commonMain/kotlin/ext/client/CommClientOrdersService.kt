package ext.client

import ar.com.intrale.shared.client.ClientOrderDTO
import ar.com.intrale.shared.client.ClientOrderDetailDTO
import ar.com.intrale.shared.client.CreateClientOrderResponseDTO
import asdo.client.CreateOrderItemData

interface CommClientOrdersService {
    suspend fun listOrders(): Result<List<ClientOrderDTO>>
    suspend fun fetchOrderDetail(orderId: String): Result<ClientOrderDetailDTO>
    suspend fun createOrder(
        items: List<CreateOrderItemData>,
        shippingAddressId: String,
        paymentMethodId: String
    ): Result<CreateClientOrderResponseDTO>
}
