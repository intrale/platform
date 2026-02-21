package ui.sc.client

import DIManager
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.RocketLaunch
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material.icons.filled.Storefront
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import ext.storage.CommKeyValueStorage
import kotlinx.coroutines.launch
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntraleGhostButton
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.th.spacing

const val CLIENT_ONBOARDING_PATH = "/client/onboarding"

data class ClientOnboardingUIState(
    val currentPage: Int = 0,
    val totalPages: Int = 4,
    val completed: Boolean = false,
)

class ClientOnboardingViewModel(
    private val storage: CommKeyValueStorage = DIManager.di.direct.instance(),
) : androidx.lifecycle.ViewModel() {

    private val logger = LoggerFactory.default.newLogger<ClientOnboardingViewModel>()

    var state by mutableStateOf(ClientOnboardingUIState())
        private set

    val isOnboardingCompleted: Boolean
        get() = storage.onboardingCompleted

    fun onPageChange(page: Int) {
        logger.info { "Cambio de pagina: $page" }
        state = state.copy(currentPage = page)
    }

    fun nextPage() {
        if (state.currentPage < state.totalPages - 1) {
            logger.info { "Avanzando a pagina ${state.currentPage + 1}" }
            state = state.copy(currentPage = state.currentPage + 1)
        }
    }

    fun completeOnboarding() {
        logger.info { "Marcando onboarding como completado" }
        storage.onboardingCompleted = true
        state = state.copy(completed = true)
    }
}

class ClientOnboardingScreen : Screen(CLIENT_ONBOARDING_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_onboarding_welcome_title

    private val logger = LoggerFactory.default.newLogger<ClientOnboardingScreen>()

    @Composable
    override fun screen() {
        val viewModel = androidx.lifecycle.viewmodel.compose.viewModel { ClientOnboardingViewModel() }

        LaunchedEffect(Unit) {
            if (viewModel.isOnboardingCompleted) {
                logger.info { "Onboarding ya completado, navegando a entry" }
                navigateClearingBackStack(CLIENT_ENTRY_PATH)
            }
        }

        LaunchedEffect(viewModel.state.completed) {
            if (viewModel.state.completed) {
                logger.info { "Onboarding completado, navegando a entry" }
                navigateClearingBackStack(CLIENT_ENTRY_PATH)
            }
        }

        if (!viewModel.isOnboardingCompleted && !viewModel.state.completed) {
            OnboardingPager(viewModel = viewModel)
        }
    }
}

@Composable
private fun OnboardingPager(viewModel: ClientOnboardingViewModel) {
    val pagerState = rememberPagerState(
        initialPage = viewModel.state.currentPage,
        pageCount = { viewModel.state.totalPages }
    )
    val coroutineScope = rememberCoroutineScope()

    LaunchedEffect(pagerState) {
        snapshotFlow { pagerState.currentPage }.collect { page ->
            viewModel.onPageChange(page)
        }
    }

    LaunchedEffect(viewModel.state.currentPage) {
        if (pagerState.currentPage != viewModel.state.currentPage) {
            pagerState.animateScrollToPage(viewModel.state.currentPage)
        }
    }

    val nextLabel = Txt(MessageKey.client_onboarding_next)
    val skipLabel = Txt(MessageKey.client_onboarding_skip)
    val startLabel = Txt(MessageKey.client_onboarding_start_button)
    val isLastPage = viewModel.state.currentPage == viewModel.state.totalPages - 1

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(
                horizontal = MaterialTheme.spacing.x3,
                vertical = MaterialTheme.spacing.x4,
            ),
    ) {
        HorizontalPager(
            state = pagerState,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        ) { page ->
            OnboardingPage(page = page)
        }

        PageIndicators(
            totalPages = viewModel.state.totalPages,
            currentPage = viewModel.state.currentPage,
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = MaterialTheme.spacing.x3),
        )

        if (isLastPage) {
            IntralePrimaryButton(
                text = startLabel,
                onClick = { viewModel.completeOnboarding() },
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            IntralePrimaryButton(
                text = nextLabel,
                onClick = {
                    coroutineScope.launch {
                        viewModel.nextPage()
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))

            IntraleGhostButton(
                text = skipLabel,
                onClick = { viewModel.completeOnboarding() },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun OnboardingPage(page: Int) {
    val pages = listOf(
        OnboardingPageData(
            titleKey = MessageKey.client_onboarding_welcome_title,
            descriptionKey = MessageKey.client_onboarding_welcome_subtitle,
            icon = null,
        ),
        OnboardingPageData(
            titleKey = MessageKey.client_onboarding_discover_title,
            descriptionKey = MessageKey.client_onboarding_discover_description,
            icon = Icons.Default.Storefront,
        ),
        OnboardingPageData(
            titleKey = MessageKey.client_onboarding_order_title,
            descriptionKey = MessageKey.client_onboarding_order_description,
            icon = Icons.Default.ShoppingCart,
        ),
        OnboardingPageData(
            titleKey = MessageKey.client_onboarding_start_title,
            descriptionKey = MessageKey.client_onboarding_start_description,
            icon = Icons.Default.RocketLaunch,
        ),
    )

    val data = pages[page]
    val title = Txt(data.titleKey)
    val description = Txt(data.descriptionKey)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = MaterialTheme.spacing.x2),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (data.icon != null) {
            Surface(
                shape = MaterialTheme.shapes.extraLarge,
                color = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f),
                tonalElevation = 0.dp,
            ) {
                Icon(
                    imageVector = data.icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .padding(MaterialTheme.spacing.x4)
                        .size(64.dp),
                )
            }
            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x4))
        }

        Text(
            text = title,
            style = MaterialTheme.typography.headlineMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))

        Text(
            text = description,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun PageIndicators(
    totalPages: Int,
    currentPage: Int,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(totalPages) { index ->
            val color by animateColorAsState(
                targetValue = if (index == currentPage) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurface.copy(alpha = 0.3f)
                },
            )
            Box(
                modifier = Modifier
                    .padding(horizontal = 4.dp)
                    .size(if (index == currentPage) 10.dp else 8.dp)
                    .clip(CircleShape)
                    .background(color),
            )
        }
    }
}

private data class OnboardingPageData(
    val titleKey: MessageKey,
    val descriptionKey: MessageKey,
    val icon: ImageVector?,
)
