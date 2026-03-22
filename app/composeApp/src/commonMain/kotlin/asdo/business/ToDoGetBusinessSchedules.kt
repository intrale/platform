package asdo.business

import ar.com.intrale.shared.business.BusinessSchedulesDTO

interface ToDoGetBusinessSchedules {
    suspend fun execute(businessId: String): Result<BusinessSchedulesDTO>
}
