// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

interface Platform {
    val name: String
}

expect fun getPlatform(): Platform