// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

interface ToDoDeleteProduct {
    suspend fun execute(businessId: String, productId: String): Result<Unit>
}
