package asdo.business

interface ToDoGetBusinessDeliveryPeople {
    suspend fun execute(businessId: String): Result<List<DeliveryPersonSummary>>
}
