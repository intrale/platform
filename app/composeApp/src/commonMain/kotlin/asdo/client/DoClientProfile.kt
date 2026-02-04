package asdo.client

import ext.client.ClientPreferencesDTO
import ext.client.ClientProfileDTO
import ext.client.CommClientAddressesService
import ext.client.CommClientProfileService
import ext.client.toClientException
import ext.storage.CommKeyValueStorage
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoGetClientProfile(
    private val profileService: CommClientProfileService,
    private val addressesService: CommClientAddressesService,
    private val storage: CommKeyValueStorage
) : ToDoGetClientProfile {

    private val logger = LoggerFactory.default.newLogger<DoGetClientProfile>()

    override suspend fun execute(): Result<ClientProfileData> = runCatching {
        logger.info { "Ejecutando obtención de perfil de cliente" }
        val profileResponse = profileService.fetchProfile().getOrThrow()
        val profile = profileResponse.profile ?: ClientProfileDTO()
        val preferences = profileResponse.preferences ?: ClientPreferencesDTO(language = storage.preferredLanguage ?: "es")
        val addresses = addressesService.listAddresses().getOrDefault(emptyList())
        val defaultId = profile.defaultAddressId
            ?: addresses.firstOrNull { it.isDefault }?.id
            ?: addresses.firstOrNull()?.id

        val data = ClientProfileData(
            profile = profile.copy(defaultAddressId = defaultId).toDomain(preferences),
            addresses = addresses.map { it.toDomain(defaultId) },
            preferences = preferences.toDomain()
        )
        storage.profileCache = data.toCache()
        storage.preferredLanguage = data.preferences.language
        data
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo obteniendo perfil de cliente" }
        throw throwable.toClientException()
    }
}

class DoUpdateClientProfile(
    private val profileService: CommClientProfileService,
    private val addressesService: CommClientAddressesService,
    private val storage: CommKeyValueStorage
) : ToDoUpdateClientProfile {

    private val logger = LoggerFactory.default.newLogger<DoUpdateClientProfile>()

    override suspend fun execute(
        profile: ClientProfile,
        preferences: ClientPreferences
    ): Result<ClientProfileData> = runCatching {
        logger.info { "Actualizando perfil del cliente" }
        val preferencesDto = preferences.toDto()
        val profileDto = profile.toDto()
        val response = profileService.updateProfile(profileDto, preferencesDto).getOrThrow()

        val updatedProfile = (response.profile ?: profileDto).copy(
            defaultAddressId = profile.defaultAddressId
        )
        val addresses = addressesService.listAddresses().getOrDefault(emptyList())
        val defaultId = updatedProfile.defaultAddressId
            ?: addresses.firstOrNull { it.isDefault }?.id
            ?: addresses.firstOrNull()?.id

        val data = ClientProfileData(
            profile = updatedProfile.copy(defaultAddressId = defaultId).toDomain(response.preferences ?: preferencesDto),
            addresses = addresses.map { it.toDomain(defaultId) },
            preferences = (response.preferences ?: preferencesDto).toDomain()
        )

        storage.profileCache = data.toCache()
        storage.preferredLanguage = data.preferences.language
        data
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo actualizando perfil" }
        throw throwable.toClientException()
    }
}

class DoManageClientAddress(
    private val profileService: CommClientProfileService,
    private val addressesService: CommClientAddressesService,
    private val storage: CommKeyValueStorage
) : ToDoManageClientAddress {

    private val logger = LoggerFactory.default.newLogger<DoManageClientAddress>()

    override suspend fun execute(action: ManageAddressAction): Result<ClientProfileData> = runCatching {
        logger.info { "Gestionando dirección: $action" }
        var updatedDefaultRequested = false
        val actionDefaultId = when (action) {
            is ManageAddressAction.Create -> action.address.id
            is ManageAddressAction.Update -> action.address.id
            is ManageAddressAction.MarkDefault -> action.addressId
            is ManageAddressAction.Delete -> null
        }
        val updatedId = when (action) {
            is ManageAddressAction.Create -> {
                val created = addressesService.createAddress(action.address.toDto()).getOrThrow()
                updatedDefaultRequested = action.address.isDefault || created.isDefault
                if (updatedDefaultRequested) {
                    created.id?.let { addressesService.markDefault(it).getOrThrow() }
                }
                created.id
            }

            is ManageAddressAction.Update -> {
                val updated = addressesService.updateAddress(action.address.toDto()).getOrThrow()
                updatedDefaultRequested = action.address.isDefault || updated.isDefault
                if (updatedDefaultRequested) {
                    updated.id?.let { addressesService.markDefault(it).getOrThrow() }
                }
                updated.id
            }

            is ManageAddressAction.Delete -> {
                addressesService.deleteAddress(action.addressId).getOrThrow()
                null
            }

            is ManageAddressAction.MarkDefault -> {
                updatedDefaultRequested = true
                addressesService.markDefault(action.addressId).getOrThrow()
                action.addressId
            }
        }

        val refreshedAddresses = addressesService.listAddresses().getOrDefault(emptyList())
        val refreshedProfileResponse = profileService.fetchProfile().getOrNull()
        val refreshedProfile = refreshedProfileResponse?.profile?.toDomain(refreshedProfileResponse.preferences)
            ?: storage.profileCache?.toDomain()
            ?: ClientProfile()

        val profileDefaultId = refreshedProfileResponse?.profile?.defaultAddressId
        val defaultId = listOfNotNull(
            (updatedId ?: actionDefaultId)?.takeIf { updatedDefaultRequested },
            refreshedAddresses.firstOrNull { it.isDefault }?.id,
            profileDefaultId?.takeIf { id -> refreshedAddresses.any { it.id == id } },
            refreshedAddresses.firstOrNull()?.id
        ).firstOrNull()

        val normalizedAddresses = refreshedAddresses.map { address ->
            address.copy(isDefault = defaultId != null && address.id == defaultId)
        }

        val preferences = refreshedProfileResponse?.preferences?.toDomain()
            ?: storage.profileCache?.toPreferences()
            ?: ClientPreferences()

        val data = ClientProfileData(
            profile = refreshedProfile.copy(defaultAddressId = defaultId),
            addresses = normalizedAddresses.map { it.toDomain(defaultId) },
            preferences = preferences
        )

        storage.profileCache = data.toCache()
        storage.preferredLanguage = data.preferences.language
        data
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al gestionar dirección" }
        throw throwable.toClientException()
    }
}
