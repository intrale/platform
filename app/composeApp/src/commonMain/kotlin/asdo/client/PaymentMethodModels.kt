package asdo.client

import ar.com.intrale.shared.client.PaymentMethodDTO

/**
 * Tipos de medio de pago soportados.
 * Extensible a futuro para pasarelas (MercadoPago, Stripe, etc.)
 */
enum class PaymentMethodType {
    CASH, TRANSFER, CARD, DIGITAL_WALLET, OTHER;

    companion object {
        fun fromString(value: String): PaymentMethodType = when (value.uppercase()) {
            "CASH" -> CASH
            "TRANSFER" -> TRANSFER
            "CARD" -> CARD
            "DIGITAL_WALLET" -> DIGITAL_WALLET
            else -> OTHER
        }
    }
}

data class PaymentMethod(
    val id: String,
    val name: String,
    val type: PaymentMethodType,
    val description: String?,
    val isCashOnDelivery: Boolean,
    val enabled: Boolean
)

fun PaymentMethodDTO.toDomain(): PaymentMethod = PaymentMethod(
    id = id,
    name = name,
    type = PaymentMethodType.fromString(type),
    description = description,
    isCashOnDelivery = isCashOnDelivery,
    enabled = enabled
)
