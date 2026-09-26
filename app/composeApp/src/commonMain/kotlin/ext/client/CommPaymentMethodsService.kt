// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.client

import ar.com.intrale.shared.client.PaymentMethodDTO

interface CommPaymentMethodsService {
    suspend fun listPaymentMethods(): Result<List<PaymentMethodDTO>>
}
