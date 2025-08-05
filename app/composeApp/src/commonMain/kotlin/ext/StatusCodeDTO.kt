package ext

import kotlinx.serialization.Serializable

@Serializable
data class StatusCodeDTO (val value: Int, val description: String?)
