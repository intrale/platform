package asdo.client

interface ToDoGetClientProfile {
    suspend fun execute(): Result<ClientProfileData>
}

interface ToDoUpdateClientProfile {
    suspend fun execute(
        profile: ClientProfile,
        preferences: ClientPreferences
    ): Result<ClientProfileData>
}

interface ToDoManageClientAddress {
    suspend fun execute(action: ManageAddressAction): Result<ClientProfileData>
}
