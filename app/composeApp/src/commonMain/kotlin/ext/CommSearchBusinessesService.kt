package ext

interface CommSearchBusinessesService {
    suspend fun execute(query: String): Result<SearchBusinessesResponse>
}
