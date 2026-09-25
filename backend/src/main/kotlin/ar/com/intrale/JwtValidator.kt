// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ar.com.intrale

import com.auth0.jwt.interfaces.DecodedJWT

interface JwtValidator {
    fun validate(token: String): DecodedJWT
}
