package asdo.business

import ext.business.CommFontsService
import ar.com.intrale.shared.business.FontsDTO
import ar.com.intrale.shared.business.FontsRequest

class DoGetFonts(
    private val service: CommFontsService
) : ToDoGetFonts {
    override suspend fun execute(businessId: String): Result<FontsDTO> =
        service.getFonts(businessId)
}

class DoUpdateFonts(
    private val service: CommFontsService
) : ToDoUpdateFonts {
    override suspend fun execute(businessId: String, request: FontsRequest): Result<FontsDTO> =
        service.updateFonts(businessId, request)
}
