package asdo.delivery

interface ToDoGetDeliveryProfile {
    suspend fun execute(): Result<DeliveryProfileData>
}

interface ToDoUpdateDeliveryProfile {
    suspend fun execute(profile: DeliveryProfile): Result<DeliveryProfileData>
}
