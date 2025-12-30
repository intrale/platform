package ext.business

import ext.dto.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class CategoryDTO(
    val id: String? = null,
    val businessId: String? = null,
    val name: String,
    val description: String? = null,
    val productCount: Int? = null
)

@Serializable
data class CategoryRequest(
    val name: String,
    val description: String? = null
)

@Serializable
data class CategoryListResponse(
    val statusCode: StatusCodeDTO? = null,
    val categories: List<CategoryDTO> = emptyList()
)
