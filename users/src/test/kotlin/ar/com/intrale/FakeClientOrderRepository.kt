package ar.com.intrale

/**
 * Helper para crear pedidos de test con timestamps arbitrarios.
 * No extiende ClientOrderRepository (es final), sino que manipula
 * internamente el mapa de pedidos via reflexión.
 */
object FakeOrderHelper {

    /**
     * Crea un pedido y luego sobreescribe su createdAt con el valor indicado.
     * Útil para simular pedidos de días anteriores.
     */
    fun createOrderWithTimestamp(
        repository: ClientOrderRepository,
        business: String,
        email: String,
        payload: ClientOrderPayload,
        createdAt: String
    ): ClientOrderPayload {
        val created = repository.createOrder(business, email, payload)
        patchCreatedAt(repository, created.id!!, createdAt)
        return created.copy(createdAt = createdAt)
    }

    /**
     * Sobreescribe el createdAt de un pedido existente via reflexión.
     */
    private fun patchCreatedAt(repository: ClientOrderRepository, orderId: String, createdAt: String) {
        val ordersField = ClientOrderRepository::class.java.getDeclaredField("orders")
        ordersField.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val ordersMap = ordersField.get(repository) as MutableMap<String, MutableList<ClientOrderPayload>>

        for ((_, list) in ordersMap) {
            val index = list.indexOfFirst { it.id == orderId }
            if (index >= 0) {
                list[index] = list[index].copy(createdAt = createdAt)
                return
            }
        }
        throw IllegalStateException("Pedido $orderId no encontrado para patch de createdAt")
    }
}
