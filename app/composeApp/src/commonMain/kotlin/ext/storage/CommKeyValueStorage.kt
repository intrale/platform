// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.storage

import ext.storage.model.ClientProfileCache

interface CommKeyValueStorage {
    var token: String?
    var profileCache: ClientProfileCache?
    var preferredLanguage: String?
    var onboardingCompleted: Boolean
}
