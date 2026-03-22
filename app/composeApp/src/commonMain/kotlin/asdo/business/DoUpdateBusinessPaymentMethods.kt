package asdo.business

import ar.com.intrale.shared.business.BusinessPaymentMethodDTO
import ar.com.intrale.shared.business.UpdatePaymentMethodsRequest
import ext.business.CommBusinessPaymentMethodsService

class DoUpdateBusinessPaymentMethods(
    private val service: CommBusinessPaymentMethodsService
) : ToDoUpdateBusinessPaymentMethods {
    override suspend fun execute(request: UpdatePaymentMethodsRequest): Result<List<BusinessPaymentMethodDTO>> =
        service.updatePaymentMethods(request)
}
