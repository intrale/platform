// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.client

interface ToDoGetPaymentMethods {
    suspend fun execute(): Result<List<PaymentMethod>>
}
