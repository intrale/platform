package asdo

interface ToDoTwoFactorSetup {
    suspend fun execute(): Result<DoTwoFactorSetupResult>
}

