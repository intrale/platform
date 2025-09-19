package ext.dto

import kotlinx.serialization.Serializable

@Serializable
data class StatusCodeDTO (val value: Int, val description: String?)
