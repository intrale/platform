package asdo.business

import ext.business.FontsDTO
import ext.business.FontsRequest

interface ToDoGetFonts {
    suspend fun execute(businessId: String): Result<FontsDTO>
}

interface ToDoUpdateFonts {
    suspend fun execute(businessId: String, request: FontsRequest): Result<FontsDTO>
}
