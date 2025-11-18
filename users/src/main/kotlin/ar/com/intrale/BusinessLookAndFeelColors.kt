package ar.com.intrale

class BusinessLookAndFeelColorsResponse(
    val colors: Map<String, String>,
    val lastUpdated: String?,
    val updatedBy: String?
) : Response()

class BusinessLookAndFeelColorsRequest(
    val colors: Map<String, String>?
)
