// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.business

import ar.com.intrale.shared.business.BusinessPaymentMethodDTO
import ar.com.intrale.shared.business.UpdateBusinessPaymentMethodsRequest

interface CommBusinessPaymentMethodsService {
    suspend fun getPaymentMethods(businessId: String): Result<List<BusinessPaymentMethodDTO>>
    suspend fun updatePaymentMethods(
        businessId: String,
        request: UpdateBusinessPaymentMethodsRequest
    ): Result<List<BusinessPaymentMethodDTO>>
}
