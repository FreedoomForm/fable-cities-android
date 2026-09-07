// Local kotlinc harness stub for symbols not covered by A1-A12 (CI compiles against the
// real Android SDK + androidx.webkit; these only satisfy the local type-check loop).
package androidx.webkit

// Mirrors androidx.webkit.WebViewAssetLoader's surface used by ParityActivity.
class WebViewAssetLoader {
    class Builder {
        fun setDomain(d: String): Builder = this
        fun addPathHandler(p: String, h: AssetsPathHandler): Builder = this
        fun build(): WebViewAssetLoader = WebViewAssetLoader()
    }
    class AssetsPathHandler(context: Any?)
    fun shouldInterceptRequest(u: android.net.Uri): android.webkit.WebResourceResponse? = null
}
