// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ar.com.intrale

class SearchBusinessesResponse(
    val businesses: Array<BusinessDTO>,
    val lastKey: String? = null
) : Response()
