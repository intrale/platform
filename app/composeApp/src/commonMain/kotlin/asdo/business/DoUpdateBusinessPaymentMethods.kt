package asdo.business

import ar.com.intrale.shared.business.BusinessPaymentMethodDTO
import ar.com.intrale.shared.business.UpdateBusinessPaymentMethodsRequest
import ext.business.CommBusinessPaymentMethodsService

class DoUpdateBusinessPaymentMethods(
    private val service: CommBusinessPaymentMethodsService
) : ToDoUpdateBusinessPaymentMethods {
    override suspend fun execute(
        businessId: String,
        request: UpdateBusinessPaymentMethodsRequest
    ): Result<List<BusinessPaymentMethodDTO>> =
        service.updatePaymentMethods(businessId, request)
}
