package ext.business

import ar.com.intrale.shared.business.BusinessDeliveryPersonDTO

interface CommListBusinessDeliveryPeopleService {
    suspend fun listDeliveryPeople(businessId: String): Result<List<BusinessDeliveryPersonDTO>>
}
