package asdo.client

/**
 * Estados posibles de un pago en Mercado Pago.
 */
enum class PaymentStatus {
    PENDING, APPROVED, REJECTED, CANCELLED, IN_PROCESS, REFUNDED;

    companion object {
        fun fromString(value: String): PaymentStatus = when (value.uppercase()) {
            "APPROVED" -> APPROVED
            "REJECTED" -> REJECTED
            "CANCELLED" -> CANCELLED
            "IN_PROCESS", "IN_MEDIATION" -> IN_PROCESS
            "REFUNDED", "CHARGED_BACK" -> REFUNDED
            else -> PENDING
        }
    }

    val isTerminal: Boolean
        get() = this == APPROVED || this == REJECTED || this == CANCELLED || this == REFUNDED
}

data class PaymentStatusResult(
    val orderId: String,
    val paymentStatus: PaymentStatus,
    val paymentId: String? = null,
    val paymentMethod: String? = null,
    val paidAmount: Double? = null,
    val failureReason: String? = null
)

interface ToDoCheckPaymentStatus {
    suspend fun execute(orderId: String): Result<PaymentStatusResult>
}
