package asdo.client

interface ToDoGetPaymentMethods {
    suspend fun execute(): Result<List<PaymentMethod>>
}
