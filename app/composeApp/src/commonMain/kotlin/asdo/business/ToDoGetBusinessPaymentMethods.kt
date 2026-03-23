package asdo.business

import ar.com.intrale.shared.business.BusinessPaymentMethodDTO

interface ToDoGetBusinessPaymentMethods {
    suspend fun execute(businessId: String): Result<List<BusinessPaymentMethodDTO>>
}
