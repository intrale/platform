package ext.business

interface CommFontsService {
    suspend fun getFonts(businessId: String): Result<FontsDTO>
    suspend fun updateFonts(businessId: String, request: FontsRequest): Result<FontsDTO>
}
