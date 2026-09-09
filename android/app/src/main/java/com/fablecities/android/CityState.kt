package com.fablecities.android

import android.content.Context

/**
 * Persistent state for the native city; kept separate from rendering for later system ports.
 * Edits are stored as a compact token string ("r<idx>:<t>;z<idx>:<kind>;"), camera as seven floats
 * (target xyz, yaw, pitch, distance, hour) packed into a comma-separated string.
 * selectedTool is a tool TOKEN: "SELECT", "BULLDOZE", "ROAD:<id>", "ZONE:<id>", "SERVICE:<id>",
 * "INFO:<id>" (pre-catalog saves used the bare names ROAD/ZONE/SERVICE — mapped below).
 */
data class CityState(
    var money: Int = 350_000,   // the site's World.js starting money (the sim model owns it now)
    var population: Int = 0,
    var day: Int = 1,
    var hour: Float = 14f,
    var selectedTool: String = "SELECT",
    var cityName: String = "New Fable",
    var speed: Int = 1,
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
            .putString("cityName", cityName)
            .putInt("speed", speed)
            .putString("edits", edits)
        edit.putString("camera", camera?.joinToString(",") { it.toString() } ?: "")
        edit.apply()
    }

    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = System.identityHashCode(this)

    companion object {
        private const val FILE = "fable_cities_city"

        /** Legacy bare tool names (pre-catalog saves) map onto the catalog tokens. */
        fun normalizeTool(raw: String): String = when (raw) {
            "ROAD" -> "ROAD:local"
            "ZONE" -> "ZONE:res-low"
            "SERVICE" -> "SERVICE:power"
            "BULLDOZE" -> "BULLDOZE"
            else -> if (raw in listOf("SELECT") || ':' in raw) raw else "SELECT"
        }

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
                money = prefs.getInt("money", 350_000),
                population = prefs.getInt("population", 0),
                day = prefs.getInt("day", 1),
                hour = prefs.getFloat("hour", 14f),
                selectedTool = normalizeTool(prefs.getString("selectedTool", "SELECT") ?: "SELECT"),
                cityName = prefs.getString("cityName", "New Fable") ?: "New Fable",
                speed = prefs.getInt("speed", 1).coerceIn(0, 4),
                edits = prefs.getString("edits", "") ?: "",
                camera = cam
            )
        }
    }
}
