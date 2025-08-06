package ext

import kotlinx.serialization.Serializable

@Serializable
data class BusinessDTO(
    val id: String,
    val name: String,
    val description: String,
    val emailAdmin: String,
    val autoAcceptDeliveries: Boolean,
    val status: String
)
