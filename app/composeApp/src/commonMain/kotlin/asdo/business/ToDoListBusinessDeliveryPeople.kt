package asdo.business

interface ToDoListBusinessDeliveryPeople {
    suspend fun execute(businessId: String): Result<List<BusinessDeliveryPerson>>
}
