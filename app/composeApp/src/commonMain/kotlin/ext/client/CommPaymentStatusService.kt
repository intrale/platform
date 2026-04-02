package ext.client

import ar.com.intrale.shared.client.PaymentStatusResponseDTO

interface CommPaymentStatusService {
    suspend fun checkPaymentStatus(orderId: String): Result<PaymentStatusResponseDTO>
}
