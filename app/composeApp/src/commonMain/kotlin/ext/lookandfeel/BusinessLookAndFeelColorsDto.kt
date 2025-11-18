package ext.lookandfeel

import kotlinx.serialization.Serializable

@Serializable
data class BusinessLookAndFeelColorsResponseDto(
    val colors: Map<String, String> = emptyMap(),
    val lastUpdated: String? = null,
    val updatedBy: String? = null
)

@Serializable
data class UpdateBusinessLookAndFeelColorsRequestDto(
    val colors: Map<String, String>
)
