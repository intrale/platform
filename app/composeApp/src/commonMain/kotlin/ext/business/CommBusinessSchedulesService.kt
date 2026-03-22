package ext.business

import ar.com.intrale.shared.business.BusinessSchedulesDTO
import ar.com.intrale.shared.business.UpdateBusinessSchedulesRequest

interface CommBusinessSchedulesService {
    suspend fun getSchedules(businessId: String): Result<BusinessSchedulesDTO>
    suspend fun updateSchedules(businessId: String, request: UpdateBusinessSchedulesRequest): Result<BusinessSchedulesDTO>
}
