package ar.com.intrale

data class RegisterBusinessRequest(
    val name: String,
    val emailAdmin: String,
    val description: String,
    val autoAcceptDeliveries: Boolean = false
)
