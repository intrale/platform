// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.client

/**
 * Verifica si un negocio está abierto en el momento actual,
 * basándose en sus horarios configurados.
 */
interface ToDoCheckBusinessOpen {
    suspend fun execute(businessId: String): Result<BusinessOpenStatus>
}
