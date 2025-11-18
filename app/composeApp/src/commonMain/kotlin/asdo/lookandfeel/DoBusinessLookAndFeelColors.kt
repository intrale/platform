package asdo.lookandfeel

import ext.auth.toExceptionResponse
import ext.lookandfeel.BusinessLookAndFeelColorsResponseDto
import ext.lookandfeel.CommGetBusinessLookAndFeelColorsService
import ext.lookandfeel.CommUpsertBusinessLookAndFeelColorsService
import ext.lookandfeel.UpdateBusinessLookAndFeelColorsRequestDto
import ext.storage.CommKeyValueStorage
import ui.session.BusinessColorPalette
import ui.session.LookAndFeelStore

interface ToGetBusinessLookAndFeelColors {
    suspend fun execute(businessId: String): Result<BusinessLookAndFeelColors>
}

interface ToSaveBusinessLookAndFeelColors {
    suspend fun execute(businessId: String, palette: BusinessColorPalette): Result<BusinessLookAndFeelColors>
}

data class BusinessLookAndFeelColors(
    val palette: BusinessColorPalette,
    val lastUpdated: String?,
    val updatedBy: String?
)

class DoGetBusinessLookAndFeelColors(
    private val service: CommGetBusinessLookAndFeelColorsService
) : ToGetBusinessLookAndFeelColors {
    override suspend fun execute(businessId: String): Result<BusinessLookAndFeelColors> =
        try {
            service.execute(businessId)
                .mapCatching { it.toDomain() }
                .onSuccess { LookAndFeelStore.updatePalette(it.palette) }
        } catch (e: Exception) {
            Result.failure(e.toExceptionResponse())
        }
}

class DoSaveBusinessLookAndFeelColors(
    private val service: CommUpsertBusinessLookAndFeelColorsService,
    private val storage: CommKeyValueStorage
) : ToSaveBusinessLookAndFeelColors {
    override suspend fun execute(
        businessId: String,
        palette: BusinessColorPalette
    ): Result<BusinessLookAndFeelColors> {
        val token = storage.token ?: return Result.failure(Exception("Token not found"))
        val request = UpdateBusinessLookAndFeelColorsRequestDto(colors = palette.normalized().toMap())
        return try {
            service.execute(businessId, token, request)
                .mapCatching { it.toDomain() }
                .onSuccess { LookAndFeelStore.updatePalette(it.palette) }
        } catch (e: Exception) {
            Result.failure(e.toExceptionResponse())
        }
    }
}

private fun BusinessLookAndFeelColorsResponseDto.toDomain(): BusinessLookAndFeelColors =
    BusinessLookAndFeelColors(
        palette = BusinessColorPalette.fromMap(colors),
        lastUpdated = lastUpdated,
        updatedBy = updatedBy
    )
