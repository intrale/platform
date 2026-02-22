package asdo.client

import ext.client.ClientAddressDTO
import ext.client.ClientOrderDTO
import ext.client.ClientOrderDetailDTO
import ext.client.ClientOrderItemDTO

enum class ClientOrderStatus {
    PENDING, CONFIRMED, IN_PROGRESS, DELIVERED, CANCELLED, UNKNOWN
}

data class ClientOrder(
    val id: String,
    val label: String,
    val businessName: String,
    val status: ClientOrderStatus,
    val createdAt: String,
    val promisedAt: String?,
    val total: Double,
    val itemCount: Int
)

data class ClientOrderDetail(
    val id: String,
    val label: String,
    val businessName: String,
    val status: ClientOrderStatus,
    val createdAt: String,
    val promisedAt: String?,
    val total: Double,
    val itemCount: Int,
    val items: List<ClientOrderItem>,
    val address: ClientOrderAddress?
)

data class ClientOrderItem(
    val id: String,
    val name: String,
    val quantity: Int,
    val unitPrice: Double,
    val subtotal: Double
)

data class ClientOrderAddress(
    val label: String,
    val street: String,
    val number: String,
    val city: String
)

fun ClientOrderDTO.toDomain(): ClientOrder = ClientOrder(
    id = id ?: "",
    label = publicId.ifEmpty { shortCode.ifEmpty { id ?: "" } },
    businessName = businessName,
    status = status.toClientOrderStatus(),
    createdAt = createdAt,
    promisedAt = promisedAt,
    total = total,
    itemCount = itemCount
)

fun ClientOrderDetailDTO.toDomain(): ClientOrderDetail = ClientOrderDetail(
    id = id ?: "",
    label = publicId.ifEmpty { shortCode.ifEmpty { id ?: "" } },
    businessName = businessName,
    status = status.toClientOrderStatus(),
    createdAt = createdAt,
    promisedAt = promisedAt,
    total = total,
    itemCount = itemCount,
    items = items.map { it.toDomain() },
    address = address?.toOrderAddress()
)

fun ClientOrderItemDTO.toDomain(): ClientOrderItem = ClientOrderItem(
    id = id ?: "",
    name = name,
    quantity = quantity,
    unitPrice = unitPrice,
    subtotal = subtotal
)

fun ClientAddressDTO.toOrderAddress(): ClientOrderAddress = ClientOrderAddress(
    label = label,
    street = street,
    number = number,
    city = city
)

fun String.toClientOrderStatus(): ClientOrderStatus = when (this.lowercase()) {
    "pending" -> ClientOrderStatus.PENDING
    "confirmed" -> ClientOrderStatus.CONFIRMED
    "inprogress", "in_progress" -> ClientOrderStatus.IN_PROGRESS
    "delivered" -> ClientOrderStatus.DELIVERED
    "cancelled", "canceled" -> ClientOrderStatus.CANCELLED
    else -> ClientOrderStatus.UNKNOWN
}
