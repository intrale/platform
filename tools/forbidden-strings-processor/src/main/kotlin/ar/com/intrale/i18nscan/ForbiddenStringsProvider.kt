package ar.com.intrale.i18nscan

import com.google.devtools.ksp.processing.SymbolProcessor
import com.google.devtools.ksp.processing.SymbolProcessorEnvironment
import com.google.devtools.ksp.processing.SymbolProcessorProvider

class ForbiddenStringsProvider : SymbolProcessorProvider {
    override fun create(environment: SymbolProcessorEnvironment): SymbolProcessor =
        ForbiddenStringsProcessor(
            logger = environment.logger,
            options = environment.options
        )
}
