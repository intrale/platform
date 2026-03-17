package asdo.business

import ar.com.intrale.shared.business.BusinessConfigDTO

interface ToDoGetBusinessConfig {
    suspend fun execute(businessId: String): Result<BusinessConfigDTO>
}
