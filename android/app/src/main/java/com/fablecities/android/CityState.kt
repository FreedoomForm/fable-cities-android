package com.fablecities.android

import android.content.Context

/**
 * Persistent state for the native city; kept separate from rendering for later system ports.
 * Edits are stored as a compact token string ("r<idx>;z<idx>:<kind>;"), camera as seven floats
 * (target xyz, yaw, pitch, distance, hour) packed into a comma-separated string.
 */
data class CityState(
    var money: Int = 125_000,
    var population: Int = 240,
    var day: Int = 1,
    var hour: Float = 8f,
    var selectedTool: String = "SELECT",
    var edits: String = "",
    var camera: FloatArray? = null
) {
    fun save(context: Context) {
        val edit = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit()
        edit.putInt("money", money)
            .putInt("population", population)
            .putInt("day", day)
            .putFloat("hour", hour)
            .putString("selectedTool", selectedTool)
            .putString("edits", edits)
        edit.putString("camera", camera?.joinToString(",") { it.toString() } ?: "")
        edit.apply()
    }

    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = System.identityHashCode(this)

    companion object {
        private const val FILE = "fable_cities_city"

        fun load(context: Context): CityState {
            val prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            val camStr = prefs.getString("camera", "") ?: ""
            val cam = if (camStr.isBlank()) null else {
                val parts = camStr.split(',')
                if (parts.size == 7) {
                    FloatArray(7) { parts[it].toFloatOrNull() ?: 0f }
                } else null
            }
            return CityState(
                money = prefs.getInt("money", 125_000),
                population = prefs.getInt("population", 240),
                day = prefs.getInt("day", 1),
                hour = prefs.getFloat("hour", 8f),
                selectedTool = prefs.getString("selectedTool", "SELECT") ?: "SELECT",
                edits = prefs.getString("edits", "") ?: "",
                camera = cam
            )
        }
    }
}
