package ar.com.intrale

data class BusinessDTO(
    val id: String,
    val name: String,
    val description: String,
    val emailAdmin: String,
    val autoAcceptDeliveries: Boolean,
    val status: String
)
