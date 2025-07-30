package asdo

import ext.CommSearchBusinessesService
import ext.SearchBusinessesResponse

class DoGetBusinesses(private val service: CommSearchBusinessesService) : ToGetBusinesses {
    override suspend fun execute(query: String): Result<SearchBusinessesResponse> = service.execute(query)
}
