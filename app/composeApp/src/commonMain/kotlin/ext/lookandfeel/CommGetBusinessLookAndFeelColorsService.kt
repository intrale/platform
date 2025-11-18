package ext.lookandfeel

interface CommGetBusinessLookAndFeelColorsService {
    suspend fun execute(businessId: String): Result<BusinessLookAndFeelColorsResponseDto>
}
