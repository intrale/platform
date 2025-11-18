package ext.lookandfeel

interface CommUpsertBusinessLookAndFeelColorsService {
    suspend fun execute(
        businessId: String,
        token: String,
        request: UpdateBusinessLookAndFeelColorsRequestDto
    ): Result<BusinessLookAndFeelColorsResponseDto>
}
