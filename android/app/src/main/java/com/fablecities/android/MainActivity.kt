package com.fablecities.android

import android.app.Activity
import android.os.Bundle
import android.view.Window
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout

class MainActivity : Activity() {
    private lateinit var gameView: FableCitiesView
    private lateinit var hud: HudOverlayView
    private lateinit var menu: MenuOverlayView
    private var menuShowing = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // crash capture + boot event log FIRST — everything after this is diagnosable
        Diag.install(this)
        Diag.log("MainActivity.onCreate")
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        window.setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN)
        gameView = FableCitiesView(this)
        hud = HudOverlayView(this)
        hud.gameView = gameView
        menu = MenuOverlayView(this)
        menu.game = gameView
        menu.host = object : MenuOverlayView.Host {
            override fun onMenuResume() = dismissMenu()
            override fun onMenuStart(seed: Int, mode: Int, cityName: String) {
                // the world the player chose; edits from a different city do not follow it —
                // regenerate clears them and re-persists via onCityEdited once rebuilt.
                // The menu STAYS visible as the "Building the world…" progress screen and
                // dismisses itself (phase 1 → worldReady) — dismissing here would blank the
                // loading state exactly when the device is slowest.
                gameView.regenerate(seed, mode, cityName)
            }
        }
        val root = FrameLayout(this)
        root.addView(
            gameView, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        root.addView(
            hud, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        root.addView(
            menu, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        setContentView(root)
        // CI emulator gate caught this: hideSystemBars() ran BEFORE setContentView — the DecorView
        // did not exist yet, so window.insetsController dereferenced a null DecorView and the app
        // NPE-crashed instantly on launch on EVERY device (AndroidRuntime: ...MainActivity.kt:51).
        hideSystemBars()
        // the site boots into the start screen (config.menu); Resume / New / Demo dismiss it
        menuShowing = true
        hud.visibility = android.view.View.GONE
        // the world keeps rendering behind the menu (the live backdrop)
    }

    private fun dismissMenu() {
        menuShowing = false
        menu.visibility = android.view.View.GONE
        hud.visibility = android.view.View.VISIBLE
    }

    override fun onResume() {
        super.onResume()
        gameView.resumeGame()
        hud.resumeHud()
    }

    override fun onPause() {
        gameView.pauseGame()
        hud.pauseHud()
        super.onPause()
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
                android.view.View.SYSTEM_UI_FLAG_FULLSCREEN or
                    android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                    android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                    android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                )
        }
    }

    /** The site's hud.escape() on Back (settings → notifications → tool → tray → selection);
     *  while the start screen is up, a second press within 2.5 s exits. */
    private var lastBackAt = 0L

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (menuShowing) {
            val now = System.currentTimeMillis()
            if (now - lastBackAt < 2500) { super.onBackPressed(); return }
            lastBackAt = now
            android.widget.Toast.makeText(this, "Back again to exit", android.widget.Toast.LENGTH_SHORT).show()
            return
        }
        if (hud.escape()) return
        val now = System.currentTimeMillis()
        if (now - lastBackAt < 2500) {
            super.onBackPressed()
            return
        }
        lastBackAt = now
        android.widget.Toast.makeText(
            this, "Back again to exit", android.widget.Toast.LENGTH_SHORT
        ).show()
    }
}
