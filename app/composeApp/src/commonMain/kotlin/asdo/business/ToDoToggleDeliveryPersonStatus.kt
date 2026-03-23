package asdo.business

interface ToDoToggleDeliveryPersonStatus {
    suspend fun execute(businessId: String, email: String, newStatus: BusinessDeliveryPersonStatus): Result<BusinessDeliveryPerson>
}
