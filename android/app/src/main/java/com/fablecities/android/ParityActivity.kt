package com.fablecities.android

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.view.View
import android.view.Window
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader

/**
 * Web-parity activity: runs the exact production web build (three.js PBR + CSM shadows + bloom +
 * SMAA post stack) bundled into android assets, so the on-device look is 1:1 with the browser
 * game the user approved. This is the launcher. The hand-written native GLES renderer remains
 * installable and CI-gated as MainActivity (track B).
 *
 * Serving: WebViewAssetLoader maps https://appassets.androidplatform.net/assets/... onto
 * /android_asset/... — ES-module scripts and fetch()/localStorage require a real http(s) origin,
 * which file:// cannot provide.
 *
 * Touch: the browser game is pointer/keyboard first. One finger reaches the page as a normal
 * mouse-like pointer (tools, UI). The injected shim maps two-finger gestures onto the camera
 * bindings the desktop game expects: pinch -> wheel (zoom), two-finger drag -> middle-button
 * drag (pan). Rotation/twist stays on the desktop for now (documented in ANDROID_PORT.md).
 */
class ParityActivity : Activity() {

    private lateinit var web: WebView

    private val assetLoader = WebViewAssetLoader.Builder()
        .setDomain("appassets.androidplatform.net")
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
        .build()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        window.setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN)

        web = WebView(this)
        web.setBackgroundColor(0xFF0A0E14.toInt())
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        val s = web.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.useWideViewPort = true
        s.loadWithOverviewMode = true

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.host != "appassets.androidplatform.net"

            override fun onPageFinished(view: WebView, url: String) {
                view.evaluateJavascript(TOUCH_SHIM, null)
                view.evaluateJavascript(ESC_HINT_SHIM, null)
            }
        }
        web.webChromeClient = WebChromeClient() // page console -> logcat [CONSOLE lines, used by the CI gate

        setContentView(web)
        hideSystemBars()
        // Fresh load every process start: deterministic boot, the game's own localStorage
        // (DOM storage) provides persistence across runs.
        web.loadUrl("https://appassets.androidplatform.net/assets/web/index.html")
    }

    /** Back button sends Escape to the page (menus/pause), matching the desktop binding. */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        runOnUiThread {
            web.evaluateJavascript(ESC_DISPATCH, null)
            Toast.makeText(this, "Back = Esc (menus) • press again to leave", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        hideSystemBars()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    private fun hideSystemBars() {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                )
        }
    }

    private companion object {
        // Two-finger camera shim. CameraController bindings: pan = middle-drag (button 1),
        // zoom = wheel, rotate/tilt = right-drag (button 2, yaw -= dx * rotateSpeed).
        // Pinch-out (span grows) -> wheel deltaY < 0 -> zoom in. Two-finger drag -> middle
        // pan. When the gesture is dominantly a TWIST (fingers orbit the midpoint), the shim
        // switches to right-button hold and maps the accumulated angle to synthetic dx moves,
        // so the camera yaw follows the fingers (1 rad of twist = 1 rad of yaw).
        val TOUCH_SHIM = """
            (function(){
              var cv = document.getElementById('game');
              if (!cv || cv.__fcShim) return;
              cv.__fcShim = true;
              cv.style.touchAction = 'none';
              var lastSpan = 0, active = false, lastX = 0, lastY = 0;
              var lastAngle = 0, totalTwist = 0, rotateMode = false;
              var MID_BTN = 1, MID_MASK = 4, RIGHT_BTN = 2, RIGHT_MASK = 2;
              var ROTATE_SPEED = 0.0045; // CameraController.rotateSpeed
              var TWIST_ENTER = 0.21;    // ~12 deg of twist switches the gesture to rotate
              function mid(e){ return { x:(e.touches[0].clientX + e.touches[1].clientX)/2,
                                        y:(e.touches[0].clientY + e.touches[1].clientY)/2 }; }
              function span(e){ var dx=e.touches[0].clientX-e.touches[1].clientX,
                                     dy=e.touches[0].clientY-e.touches[1].clientY;
                                 return Math.hypot(dx,dy); }
              function angle(e){ return Math.atan2(e.touches[1].clientY-e.touches[0].clientY,
                                                   e.touches[1].clientX-e.touches[0].clientX); }
              function pd(x,y,btn,mask){ cv.dispatchEvent(new PointerEvent('pointerdown',
                {button:btn,buttons:mask,clientX:x,clientY:y,pointerId:9001,pointerType:'mouse',bubbles:true})); }
              function pm(x,y,mask){ window.dispatchEvent(new PointerEvent('pointermove',
                {button:rotateMode?RIGHT_BTN:MID_BTN,buttons:mask,clientX:x,clientY:y,pointerId:9001,pointerType:'mouse',bubbles:true})); }
              function pu(x,y,btn){ window.dispatchEvent(new PointerEvent('pointerup',
                {button:btn,buttons:0,clientX:x,clientY:y,pointerId:9001,pointerType:'mouse',bubbles:true})); }
              function wheel(x,y,dy){ cv.dispatchEvent(new WheelEvent('wheel',
                {clientX:x,clientY:y,deltaY:dy,deltaMode:0,bubbles:true,cancelable:true})); }
              cv.addEventListener('touchstart', function(e){
                if (e.touches.length === 2) {
                  e.preventDefault();
                  active = true; rotateMode = false; totalTwist = 0;
                  var m = mid(e);
                  lastSpan = span(e); lastX = m.x; lastY = m.y; lastAngle = angle(e);
                  pd(m.x, m.y, MID_BTN, MID_MASK);
                }
              }, {passive:false});
              cv.addEventListener('touchmove', function(e){
                if (!active || e.touches.length < 2) return;
                e.preventDefault();
                var s = span(e), m = mid(e), a = angle(e);
                var dA = a - lastAngle;
                if (dA > Math.PI) dA -= 2 * Math.PI; else if (dA < -Math.PI) dA += 2 * Math.PI;
                totalTwist += dA;
                lastAngle = a;
                if (!rotateMode && Math.abs(totalTwist) > TWIST_ENTER) {
                  // switch the hold from middle (pan) to right (rotate)
                  rotateMode = true;
                  pu(lastX, lastY, MID_BTN);
                  pd(m.x, m.y, RIGHT_BTN, RIGHT_MASK);
                }
                if (rotateMode) {
                  // yaw follows the twist: CameraController does yaw -= dx * ROTATE_SPEED
                  var dxRad = -dA / ROTATE_SPEED;
                  pm(lastX + dxRad, m.y, RIGHT_MASK);
                  lastX += dxRad; lastY = m.y;
                } else {
                  if (lastSpan > 0) {
                    var d = s - lastSpan;
                    if (Math.abs(d) > 0.5) wheel(m.x, m.y, -d * 2.0);
                  }
                  lastSpan = s;
                  pm(m.x, m.y, MID_MASK);
                  lastX = m.x; lastY = m.y;
                }
              }, {passive:false});
              cv.addEventListener('touchend', function(e){
                if (active && e.touches.length < 2) {
                  active = false; lastSpan = 0;
                  pu(lastX, lastY, rotateMode ? RIGHT_BTN : MID_BTN);
                  rotateMode = false;
                }
              }, {passive:false});
              cv.addEventListener('touchcancel', function(){
                if (active) { active = false; lastSpan = 0; pu(lastX, lastY, rotateMode ? RIGHT_BTN : MID_BTN); rotateMode = false; }
              }, {passive:false});
            })();
        """.trimIndent()

        // Surfaces a one-time hint so a touch user learns the mapping (page-side, once per save).
        val ESC_HINT_SHIM = """
            (function(){
              try {
                if (localStorage.getItem('fc_parity_hint')) return;
                localStorage.setItem('fc_parity_hint', '1');
                var d = document.createElement('div');
                d.textContent = '1 палец — инструменты/интерфейс • 2 пальца — камера (перетаскивание/щипок/поворот) • Back — Esc';
                d.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99999;' +
                  'background:rgba(10,16,24,.86);color:#dfe9f0;padding:10px 16px;border-radius:10px;' +
                  'font:13px/1.4 system-ui,sans-serif;border:1px solid rgba(140,190,220,.4);max-width:92%;text-align:center';
                document.body.appendChild(d);
                setTimeout(function(){ d.remove(); }, 9000);
              } catch (_) {}
            })();
        """.trimIndent()

        val ESC_DISPATCH = """
            (function(){
              var opts = {key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};
              window.dispatchEvent(new KeyboardEvent('keydown', opts));
              window.dispatchEvent(new KeyboardEvent('keyup', opts));
            })();
        """.trimIndent()
    }
}
