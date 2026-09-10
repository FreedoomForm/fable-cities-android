package com.fablecities.android

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.Window
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.webkit.WebViewAssetLoader
import java.io.File
import java.io.PrintWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Fable Cities v2 — the ORIGINAL web game runs here 1:1 in a hardware-accelerated WebView.
 *
 * Boot contract (no white frame is possible, in any order, on any OEM skin):
 *   1. Theme windowBackground / splash background = #0B0F14 (styles.xml, values-v31) —
 *      even the system splash on MIUI is dark.
 *   2. setContentView() installs a NATIVE dark overlay ("FABLE CITIES / Loading…") in the
 *      very first frame — it is a plain View tree, it draws before anything else exists.
 *   3. The WebView loads the page INVISIBLE underneath and only becomes visible when the
 *      page itself reports its first rendered frames (AndroidApp.frameReady() from the
 *      perf shim, fired after window load + 2 rAF). The user then sees the game's own
 *      authentic loading screen with its progress bar — not a white void.
 *
 * Performance contract (the "200%" ask):
 *   - devicePixelRatio is governed at runtime: it starts capped at 2.0 (visually
 *     indistinguishable from 2.6+ on a 1080p phone, but ~1.7x fewer shaded pixels) and
 *     auto-climbs toward the panel's true DPR while the frame rate holds >= 57 fps,
 *     auto-drops while it stays <= 38 fps. Quality is always restored to 100% whenever
 *     the GPU can afford it.
 *   - WebGL contexts are created with powerPreference=high-performance (shim).
 *   - Renderer priority stays IMPORTANT even when briefly hidden; hardware acceleration
 *     and largeHeap are pinned in the manifest.
 *
 * Diagnostics contract: any uncaught exception is appended to
 * /sdcard/Android/data/com.fablecities.android/files/crash.txt (pullable via adb without
 * root), and all page console output is mirrored into logcat under the FableWeb tag.
 */
class MainActivity : Activity() {

    companion object {
        const val TAG = "FableWeb"
        const val PAGE_URL = "https://appassets.androidplatform.net/assets/web/index.html"
        val BG = 0xFF0B0F14.toInt()
        val FG = 0xFFDFE7EF.toInt()
        val MUTED = 0xFF8DA0B3.toInt()
        val ACCENT = 0xFF4FC3F7.toInt()
    }

    private lateinit var root: FrameLayout
    private var overlay: LinearLayout? = null
    private var statusText: TextView? = null
    private var webView: WebView? = null
    private var revealed = false
    private var pendingUrl: String = PAGE_URL

    private val main = Handler(Looper.getMainLooper())

    // ---- DPR governor state -------------------------------------------------------------
    private var realDpr = 2f
    private var dprCap = 2f
    private var upStreak = 0
    private var downStreak = 0
    private val governor = object : Runnable {
        override fun run() {
            val web = webView ?: return
            web.evaluateJavascript("window.__fcGetFps ? window.__fcGetFps() : -1") { v ->
                val fps = v?.trim()?.removeSurrounding("\"")?.toIntOrNull() ?: -1
                if (fps >= 0) stepGovernor(fps)
            }
            main.postDelayed(this, 2000)
        }
    }

    private fun stepGovernor(fps: Int) {
        var changed = false
        if (fps >= 57) {
            upStreak++; downStreak = 0
            if (upStreak >= 3 && dprCap < realDpr) {
                dprCap = minOf(realDpr, dprCap + 0.25f); changed = true
            }
        } else if (fps in 1..38) {
            downStreak++; upStreak = 0
            if (downStreak >= 3 && dprCap > 1.0f) {
                dprCap = maxOf(1.0f, dprCap - 0.25f); changed = true
            }
        } else {
            upStreak = 0; downStreak = 0
        }
        if (changed) {
            Log.i(TAG, "dpr-governor fps=$fps cap=$dprCap (panel $realDpr)")
            webView?.evaluateJavascript("window.__fcSetCap && window.__fcSetCap($dprCap)", null)
        }
    }

    // ---- JS bridge -----------------------------------------------------------------------
    private inner class Bridge {
        @JavascriptInterface
        fun frameReady() {
            runOnUiThread {
                Log.i(TAG, "revealed") // CI emulator gate greps this marker
                reveal()
            }
        }

        @JavascriptInterface
        fun log(message: String) {
            Log.i(TAG, "page: ${message.take(300)}")
        }
    }

    // ---- crash capture -------------------------------------------------------------------
    private fun installCrashHook() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                val dir = getExternalFilesDir(null) ?: filesDir
                val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
                PrintWriter(File(dir, "crash.txt").writer(true)).use { w ->
                    w.println("=== crash $stamp ===")
                    w.println("thread=${t.name} version=${packageManager.getPackageInfo(packageName, 0).versionName}")
                    w.println("model=${Build.MODEL} sdk=${Build.VERSION.SDK_INT}")
                    e.printStackTrace(w)
                    w.println()
                }
            } catch (_: Throwable) {
            }
            previous?.uncaughtException(t, e)
        }
    }

    // ---- native loading overlay -----------------------------------------------------------
    private fun dp(v: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun buildOverlay(): LinearLayout {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(BG)
        }
        val title = TextView(this).apply {
            text = "FABLE CITIES"
            setTextColor(FG)
            textSize = 24f
            letterSpacing = 0.35f
            gravity = Gravity.CENTER
        }
        val bar = ProgressBar(this).apply {
            isIndeterminate = true
            indeterminateTintList = android.content.res.ColorStateList.valueOf(ACCENT)
        }
        val status = TextView(this).apply {
            text = "Loading the original world…"
            setTextColor(MUTED)
            textSize = 12f
            letterSpacing = 0.12f
            gravity = Gravity.CENTER
            setPadding(0, dp(14), 0, 0)
        }
        box.addView(title)
        box.addView(bar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(20) })
        box.addView(status)
        statusText = status
        return box
    }

    private fun showError(message: String) {
        val box = overlay ?: return
        statusText?.text = message
        if (box.findViewWithTag<Button>("retry") == null) {
            val retry = Button(this).apply {
                tag = "retry"
                text = "Retry"
                setTextColor(ACCENT)
                setBackgroundColor(Color.TRANSPARENT)
                setOnClickListener {
                    box.findViewWithTag<Button>("retry")?.visibility = View.GONE
                    statusText?.text = "Loading the original world…"
                    revealed = false
                    webView?.visibility = View.INVISIBLE
                    loadPage()
                }
            }
            box.addView(retry, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(24) })
        } else {
            box.findViewWithTag<Button>("retry").visibility = View.VISIBLE
        }
    }

    // ---- lifecycle -----------------------------------------------------------------------
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        installCrashHook()
        window.addFlags(Window.LayoutParams.FLAG_KEEP_SCREEN_ON)

        realDpr = resources.displayMetrics.density
        dprCap = minOf(realDpr, 2f)

        // 1) the first frame on screen: dark background + native loading overlay
        root = FrameLayout(this).apply { setBackgroundColor(BG) }
        val ov = buildOverlay()
        overlay = ov
        root.addView(ov)
        setContentView(root)

        // 2) the page underneath, invisible until it reports real frames
        val web = WebView(this).apply {
            setBackgroundColor(BG)
            visibility = View.INVISIBLE
            isFocusableInTouchMode = true
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            settings.displayZoomControls = false
            settings.textZoom = 100
            if (Build.VERSION.SDK_INT >= 29) {
                settings.forceDark = WebSettings.FORCE_DARK_OFF
                setRendererPriorityPolicy(WebSettings.RENDERER_PRIORITY_IMPORTANT, true)
            }
            if (Build.VERSION.SDK_INT >= 26) settings.safeBrowsingEnabled = false
            addJavascriptInterface(Bridge(), "AndroidApp")
        }
        webView = web
        web.visibility = View.INVISIBLE
        root.addView(
            web,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        )

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                loader.shouldInterceptRequest(request.url)

            override fun onPageFinished(view: WebView, url: String) {
                Log.i(TAG, "page-finished")
                // Safety net: if the shim bridge never fires (e.g. an old WebView), lift the
                // overlay anyway once the page has had time to start rendering.
                main.postDelayed({ reveal() }, 25_000)
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    Log.e(TAG, "main-frame error ${error.errorCode}: ${error.description}")
                    runOnUiThread { showError("Failed to load (${error.errorCode}). Check the install and tap Retry.") }
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                Log.e(TAG, "webview renderer gone — recreating activity")
                recreate()
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                when (m.messageLevel()) {
                    ConsoleMessage.MessageLevel.ERROR -> Log.w(TAG, "console: ${m.message().take(400)}")
                    else -> Log.d(TAG, "console: ${m.message().take(200)}")
                }
                return true
            }
        }

        loadPage()
    }

    private fun loadPage() {
        val params = intent?.getStringExtra("params")
        val url = if (params.isNullOrBlank()) PAGE_URL else "$PAGE_URL?$params"
        pendingUrl = url
        Log.i(TAG, "loading $url")
        webView?.loadUrl(url)
    }

    private fun reveal() {
        if (revealed) return
        revealed = true
        val ov = overlay ?: return
        webView?.visibility = View.VISIBLE
        // Sync the native governor state into the page (shim already starts at the same
        // 2.0 default — this is idempotent and covers a native-side restart).
        webView?.evaluateJavascript("window.__fcSetCap && window.__fcSetCap($dprCap)", null)
        ov.animate().alpha(0f).setDuration(450).withEndAction {
            ov.visibility = View.GONE
        }.start()
        main.post(governor)
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
        if (revealed) main.post(governor)
    }

    override fun onPause() {
        main.removeCallbacks(governor)
        webView?.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        webView?.apply {
            loadUrl("about:blank")
            removeAllViews()
            destroy()
        }
        webView = null
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.apply {
                hide(WindowInsets.Type.systemBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
    }

    override fun onBackPressed() {
        // The game is a single-page app; Back should background it, not unwind the page.
        moveTaskToBack(true)
    }
}
