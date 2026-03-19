package asdo.business

interface ToDoAssignOrderDeliveryPerson {
    suspend fun execute(businessId: String, orderId: String, deliveryPersonEmail: String?): Result<BusinessOrder>
}
