package asdo.business

import ar.com.intrale.shared.business.BusinessSchedulesDTO
import ar.com.intrale.shared.business.UpdateBusinessSchedulesRequest

interface ToDoUpdateBusinessSchedules {
    suspend fun execute(businessId: String, request: UpdateBusinessSchedulesRequest): Result<BusinessSchedulesDTO>
}
