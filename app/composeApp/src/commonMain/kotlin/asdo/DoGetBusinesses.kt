package asdo

import ext.CommSearchBusinessesService
import ext.SearchBusinessesResponse

class DoGetBusinesses(private val service: CommSearchBusinessesService) : ToGetBusinesses {
    override suspend fun execute(
        query: String,
        status: String?,
        limit: Int?,
        lastKey: String?
    ): Result<SearchBusinessesResponse> = service.execute(query, status, limit, lastKey)
}
