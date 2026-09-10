package com.fablecities.android

import android.content.Context
import android.content.Intent
import android.os.Build
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Device-side diagnostics for the white/black-screen hunt on real GPUs (the CI emulator runs
 * SwiftShader; a Mali/Adreno phone can fail in ways CI never sees and the user cannot report).
 *
 * Three capture paths, one text report:
 *  - boot/events ring buffer (Diag.log from the renderer, activity, menu) — timings of every
 *    boot phase, GPU identity, watchdog flips, GL errors;
 *  - shader failures (labels + driver info logs) recorded by the renderer;
 *  - uncaught exceptions: the default handler chains AFTER writing crash.txt, so even a hard
 *    crash leaves a readable file in getExternalFilesDir (no adb needed).
 *
 * The menu's SEND DIAGS button shares the whole report as plain text — the user pastes it
 * into the chat and we see exactly what their GPU did.
 */
object Diag {

    private val bootAt = System.currentTimeMillis()
    private val lines = ArrayDeque<String>()
    private const val MAX_LINES = 400

    @Volatile
    var shaderFails: List<String> = emptyList() // set by the renderer
        @Synchronized get
        @Synchronized private set

    @Synchronized
    fun recordShaderFails(fails: List<String>) {
        shaderFails = fails.take(16)
        fails.forEach { log("SHADER FAIL: $it") }
    }

    /** One boot event. Always logcat'd (visible via adb) + kept in the ring for the report. */
    @Synchronized
    fun log(message: String) {
        val dt = (System.currentTimeMillis() - bootAt) / 1000.0
        val line = "[t+${"%.1f".format(dt)}s] $message"
        android.util.Log.i("FableDiag", line)
        if (lines.size >= MAX_LINES) lines.removeFirst()
        lines.addLast(line)
    }

    /** The full text report: device, app version, GPU (if captured), events, shader fails. */
    @Synchronized
    fun report(gpu: String? = null): String {
        val sb = StringBuilder()
        sb.appendLine("Fable Cities diagnostics")
        sb.appendLine("device: ${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})")
        try {
            val ctx = appCtx
            if (ctx != null) {
                val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
                val build = if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode
                            else @Suppress("DEPRECATION") pi.versionCode.toLong()
                sb.appendLine("app: v${pi.versionName} (build $build)")
            }
        } catch (_: Exception) {}
        if (!gpu.isNullOrEmpty()) sb.appendLine("gpu: $gpu")
        sb.appendLine("worldReady: $worldReadyFlag")
        sb.appendLine()
        sb.appendLine("-- events --")
        lines.forEach { sb.appendLine(it) }
        val fails = shaderFails
        if (fails.isNotEmpty()) {
            sb.appendLine()
            sb.appendLine("-- shader failures (${fails.size}) --")
            fails.forEach { sb.appendLine(it) }
        }
        return sb.toString()
    }

    @Volatile var worldReadyFlag: Boolean = false
    @Volatile private var appCtx: Context? = null

    /** Crash capture: write the report + stack to crash.txt, THEN chain to the default handler
     *  (which kills the process exactly as before — behaviour for the OS is unchanged). */
    fun install(context: Context) {
        appCtx = context.applicationContext
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, t ->
            try {
                val dir = context.getExternalFilesDir(null)
                if (dir != null) {
                    val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
                    File(dir, "crash-$stamp.txt").writeText(
                        report() + "\n-- crash on ${thread.name} --\n" + t.stackTraceToString()
                    )
                }
            } catch (_: Exception) {}
            prev?.uncaughtException(thread, t)
        }
        log("diag installed (${Build.MANUFACTURER} ${Build.MODEL}, SDK ${Build.VERSION.SDK_INT})")
    }

    /** Persist the current report to diag.txt (next to crash-*.txt). */
    @Synchronized
    fun save(context: Context?, gpu: String? = null) {
        if (context == null) return
        try {
            val dir = context.getExternalFilesDir(null) ?: return
            File(dir, "diag.txt").writeText(report(gpu))
        } catch (_: Exception) {}
    }

    /** The menu's SEND DIAGS: share the report as plain text (user pastes it into the chat). */
    fun share(context: Context, gpu: String?) {
        val text = report(gpu)
        val dir = context.getExternalFilesDir(null)
        if (dir != null) { try { File(dir, "diag.txt").writeText(text) } catch (_: Exception) {} }
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "Fable Cities diagnostics")
            putExtra(Intent.EXTRA_TEXT, text.take(9000))
        }
        context.startActivity(Intent.createChooser(intent, "Send diagnostics"))
    }
}
