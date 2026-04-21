package ui.sc.business

import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.assertNull

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

class ChatbotConversationsViewModelTest {

    @Test
    fun `estado inicial es ComingSoon con lista vacia`() = runTest {
        val viewModel = ChatbotConversationsViewModel(loggerFactory = testLoggerFactory)

        assertEquals(ChatbotConversationsStatus.ComingSoon, viewModel.state.status)
        assertTrue(viewModel.state.items.isEmpty())
        assertNull(viewModel.state.errorMessage)
    }

    @Test
    fun `loadConversations con businessId nulo marca MissingBusiness`() = runTest {
        val viewModel = ChatbotConversationsViewModel(loggerFactory = testLoggerFactory)

        viewModel.loadConversations(businessId = null)

        assertEquals(ChatbotConversationsStatus.MissingBusiness, viewModel.state.status)
        assertTrue(viewModel.state.items.isEmpty())
    }

    @Test
    fun `loadConversations con businessId en blanco marca MissingBusiness`() = runTest {
        val viewModel = ChatbotConversationsViewModel(loggerFactory = testLoggerFactory)

        viewModel.loadConversations(businessId = "   ")

        assertEquals(ChatbotConversationsStatus.MissingBusiness, viewModel.state.status)
    }

    @Test
    fun `loadConversations con businessId valido mantiene estado ComingSoon`() = runTest {
        val viewModel = ChatbotConversationsViewModel(loggerFactory = testLoggerFactory)

        viewModel.loadConversations(businessId = "biz-123")

        assertEquals(ChatbotConversationsStatus.ComingSoon, viewModel.state.status)
        assertTrue(viewModel.state.items.isEmpty())
        assertNull(viewModel.state.errorMessage)
    }

    @Test
    fun `refresh usa el ultimo businessId cargado`() = runTest {
        val viewModel = ChatbotConversationsViewModel(loggerFactory = testLoggerFactory)

        viewModel.loadConversations(businessId = "biz-abc")
        assertEquals(ChatbotConversationsStatus.ComingSoon, viewModel.state.status)

        viewModel.refresh()
        assertEquals(ChatbotConversationsStatus.ComingSoon, viewModel.state.status)
    }

    @Test
    fun `refresh sin businessId previo marca MissingBusiness`() = runTest {
        val viewModel = ChatbotConversationsViewModel(loggerFactory = testLoggerFactory)

        viewModel.refresh()

        assertEquals(ChatbotConversationsStatus.MissingBusiness, viewModel.state.status)
    }

    @Test
    fun `clearError resetea errorMessage a null`() = runTest {
        val viewModel = ChatbotConversationsViewModel(loggerFactory = testLoggerFactory)

        // El caso "happy" no setea errores, verificamos idempotencia del clear.
        viewModel.clearError()

        assertNull(viewModel.state.errorMessage)
    }
}
