package ext.business

import ar.com.intrale.shared.business.FontsDTO
import ar.com.intrale.shared.business.FontsRequest

interface CommFontsService {
    suspend fun getFonts(businessId: String): Result<FontsDTO>
    suspend fun updateFonts(businessId: String, request: FontsRequest): Result<FontsDTO>
}
