package asdo.business

import ar.com.intrale.shared.business.BusinessPaymentMethodDTO

interface ToDoGetBusinessPaymentMethods {
    suspend fun execute(): Result<List<BusinessPaymentMethodDTO>>
}
