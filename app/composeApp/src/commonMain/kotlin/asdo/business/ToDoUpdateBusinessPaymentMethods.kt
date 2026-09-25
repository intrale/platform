// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.business

import ar.com.intrale.shared.business.BusinessPaymentMethodDTO
import ar.com.intrale.shared.business.UpdateBusinessPaymentMethodsRequest

interface ToDoUpdateBusinessPaymentMethods {
    suspend fun execute(
        businessId: String,
        request: UpdateBusinessPaymentMethodsRequest
    ): Result<List<BusinessPaymentMethodDTO>>
}
