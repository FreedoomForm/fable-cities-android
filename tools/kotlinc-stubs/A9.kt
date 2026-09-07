package android.webkit
class WebSettings {
    companion object { const val LOAD_DEFAULT = -1 }
    var javaScriptEnabled: Boolean = false
    var domStorageEnabled: Boolean = false
    var databaseEnabled: Boolean = false
    var mediaPlaybackRequiresUserGesture: Boolean = false
    var cacheMode: Int = 0
    var useWideViewPort: Boolean = false
    var loadWithOverviewMode: Boolean = false
}
class WebResourceRequest { val url: android.net.Uri = android.net.Uri() }
class WebResourceResponse(mime: String? = null, enc: String? = null, data: java.io.InputStream? = null)
class WebView(context: Any?) : android.widget.FrameLayout(context) {
    val settings: WebSettings = WebSettings()
    var webViewClient: WebViewClient = WebViewClient()
    var webChromeClient: WebChromeClient = WebChromeClient()
    fun setBackgroundColor(c: Int): Unit = Unit
    fun loadUrl(u: String): Unit = Unit
    fun evaluateJavascript(js: String, cb: Any?): Unit = Unit
    fun onPause(): Unit = Unit
    fun onResume(): Unit = Unit
    fun destroy(): Unit = Unit
}
open class WebViewClient {
    open fun shouldInterceptRequest(v: WebView, r: WebResourceRequest): WebResourceResponse? = null
    open fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean = false
    open fun onPageFinished(v: WebView, url: String): Unit = Unit
}
open class WebChromeClient
class WebViewAssetLoader {
    class Builder {
        fun setDomain(d: String): Builder = this
        fun addPathHandler(p: String, h: AssetsPathHandler): Builder = this
        fun build(): WebViewAssetLoader = WebViewAssetLoader()
    }
    class AssetsPathHandler(context: Any?)
    fun shouldInterceptRequest(u: android.net.Uri): WebResourceResponse? = null
}
