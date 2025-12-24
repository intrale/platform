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
        val defaultId = profile.defaultAddressId ?: addresses.firstOrNull { it.isDefault }?.id

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
        val defaultId = updatedProfile.defaultAddressId ?: addresses.firstOrNull { it.isDefault }?.id

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
        when (action) {
            is ManageAddressAction.Create -> addressesService.createAddress(action.address.toDto()).getOrThrow()
            is ManageAddressAction.Update -> addressesService.updateAddress(action.address.toDto()).getOrThrow()
            is ManageAddressAction.Delete -> addressesService.deleteAddress(action.addressId).getOrThrow()
            is ManageAddressAction.MarkDefault -> {
                val addresses = addressesService.listAddresses().getOrDefault(emptyList())
                val target = addresses.firstOrNull { it.id == action.addressId }
                    ?: throw IllegalArgumentException("Dirección no encontrada")
                val updated = target.copy(isDefault = true)
                addressesService.updateAddress(updated).getOrThrow()
            }
        }

        val refreshedAddresses = addressesService.listAddresses().getOrDefault(emptyList())
        val refreshedProfileResponse = profileService.fetchProfile().getOrNull()
        val refreshedProfile = refreshedProfileResponse?.profile?.toDomain(refreshedProfileResponse.preferences)
            ?: storage.profileCache?.toDomain()
            ?: ClientProfile()

        val preferences = refreshedProfileResponse?.preferences?.toDomain()
            ?: storage.profileCache?.toPreferences()
            ?: ClientPreferences()

        val defaultId = refreshedAddresses.firstOrNull { it.isDefault }?.id
            ?: refreshedProfile.defaultAddressId

        val data = ClientProfileData(
            profile = refreshedProfile.copy(defaultAddressId = defaultId),
            addresses = refreshedAddresses.map { it.toDomain(defaultId) },
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
