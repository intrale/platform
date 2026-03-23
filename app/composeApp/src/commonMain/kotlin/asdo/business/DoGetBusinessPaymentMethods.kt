package asdo.business

import ar.com.intrale.shared.business.BusinessPaymentMethodDTO
import ext.business.CommBusinessPaymentMethodsService

class DoGetBusinessPaymentMethods(
    private val service: CommBusinessPaymentMethodsService
) : ToDoGetBusinessPaymentMethods {
    override suspend fun execute(businessId: String): Result<List<BusinessPaymentMethodDTO>> =
        service.getPaymentMethods(businessId)
}
