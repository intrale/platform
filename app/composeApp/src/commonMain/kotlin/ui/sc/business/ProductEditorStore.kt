package ui.sc.business

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

object ProductEditorStore {
    private val mutableDraft = MutableStateFlow<ProductDraft?>(null)

    val draft: StateFlow<ProductDraft?> = mutableDraft.asStateFlow()

    fun setDraft(draft: ProductDraft?) {
        mutableDraft.value = draft
    }

    fun update(transform: (ProductDraft?) -> ProductDraft?) {
        mutableDraft.update(transform)
    }

    fun clear() {
        mutableDraft.value = null
    }
}
