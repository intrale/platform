// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ar.com.intrale

import io.ktor.http.HttpStatusCode

class CategoryResponse(
    val category: CategoryPayload?,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

class CategoryListResponse(
    val categories: List<CategoryPayload>,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

fun CategoryRecord.toPayload() = CategoryPayload(
    id = id,
    businessId = businessId,
    name = name,
    description = description
)
