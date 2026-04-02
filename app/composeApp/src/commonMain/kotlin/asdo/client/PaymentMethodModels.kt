package asdo.client

import ar.com.intrale.shared.client.PaymentMethodDTO

/**
 * Tipos de medio de pago soportados.
 * Extensible a futuro para pasarelas (MercadoPago, Stripe, etc.)
 */
enum class PaymentMethodType {
    CASH, TRANSFER, CARD, DIGITAL_WALLET, MERCADO_PAGO, OTHER;

    companion object {
        fun fromString(value: String): PaymentMethodType = when (value.uppercase()) {
            "CASH" -> CASH
            "TRANSFER" -> TRANSFER
            "CARD" -> CARD
            "DIGITAL_WALLET" -> DIGITAL_WALLET
            "MERCADO_PAGO", "MERCADOPAGO" -> MERCADO_PAGO
            else -> OTHER
        }
    }

    /**
     * Indica si este medio de pago requiere redirect a pasarela externa.
     */
    val requiresExternalPayment: Boolean
        get() = this == MERCADO_PAGO
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
