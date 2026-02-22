package asdo.client

import ext.client.ClientOrderDTO
import ext.client.ClientOrderDetailDTO
import ext.client.ClientOrderItemDTO

enum class ClientOrderStatus {
    PENDING, CONFIRMED, PREPARING, READY, DELIVERING, DELIVERED, CANCELLED, UNKNOWN
}

data class ClientOrder(
    val id: String,
    val publicId: String,
    val shortCode: String,
    val businessName: String,
    val status: ClientOrderStatus,
    val createdAt: String,
    val promisedAt: String?,
    val total: Double,
    val itemCount: Int
)

data class ClientOrderDetail(
    val id: String,
    val publicId: String,
    val shortCode: String,
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
    val id: String?,
    val name: String,
    val quantity: Int,
    val unitPrice: Double,
    val subtotal: Double
)

data class ClientOrderAddress(
    val label: String,
    val street: String,
    val number: String,
    val city: String,
    val reference: String?,
    val postalCode: String?
)

fun String.toClientOrderStatus(): ClientOrderStatus = when (this.uppercase()) {
    "PENDING" -> ClientOrderStatus.PENDING
    "CONFIRMED" -> ClientOrderStatus.CONFIRMED
    "PREPARING" -> ClientOrderStatus.PREPARING
    "READY" -> ClientOrderStatus.READY
    "DELIVERING" -> ClientOrderStatus.DELIVERING
    "DELIVERED" -> ClientOrderStatus.DELIVERED
    "CANCELLED" -> ClientOrderStatus.CANCELLED
    else -> ClientOrderStatus.UNKNOWN
}

fun ClientOrderDTO.toDomain(): ClientOrder = ClientOrder(
    id = id.orEmpty(),
    publicId = publicId,
    shortCode = shortCode,
    businessName = businessName,
    status = status.toClientOrderStatus(),
    createdAt = createdAt,
    promisedAt = promisedAt,
    total = total,
    itemCount = itemCount
)

fun ClientOrderDetailDTO.toDomain(): ClientOrderDetail = ClientOrderDetail(
    id = id.orEmpty(),
    publicId = publicId,
    shortCode = shortCode,
    businessName = businessName,
    status = status.toClientOrderStatus(),
    createdAt = createdAt,
    promisedAt = promisedAt,
    total = total,
    itemCount = itemCount,
    items = items.map { it.toDomain() },
    address = address?.let {
        ClientOrderAddress(
            label = it.label,
            street = it.street,
            number = it.number,
            city = it.city,
            reference = it.reference,
            postalCode = it.postalCode
        )
    }
)

fun ClientOrderItemDTO.toDomain(): ClientOrderItem = ClientOrderItem(
    id = id,
    name = name,
    quantity = quantity,
    unitPrice = unitPrice,
    subtotal = subtotal
)
