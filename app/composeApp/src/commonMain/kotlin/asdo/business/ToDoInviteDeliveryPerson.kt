package asdo.business

interface ToDoInviteDeliveryPerson {
    suspend fun execute(businessId: String, email: String): Result<String>
}
