package asdo.business

import ar.com.intrale.shared.business.BusinessSchedulesDTO
import ar.com.intrale.shared.business.UpdateBusinessSchedulesRequest
import ext.business.CommBusinessSchedulesService

class DoUpdateBusinessSchedules(
    private val service: CommBusinessSchedulesService
) : ToDoUpdateBusinessSchedules {
    override suspend fun execute(
        businessId: String,
        request: UpdateBusinessSchedulesRequest
    ): Result<BusinessSchedulesDTO> =
        service.updateSchedules(businessId, request)
}
