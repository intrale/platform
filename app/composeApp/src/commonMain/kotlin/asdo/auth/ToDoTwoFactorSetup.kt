package asdo.auth

interface ToDoTwoFactorSetup {
    suspend fun execute(): Result<DoTwoFactorSetupResult>
}

