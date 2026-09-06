package app.murmur.android.overlay

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Where the dictation button may rest, independent of screen size and keyboard height: the
 * button's centre sits at [xFraction] of the screen width and [offsetDp] dp above the top edge of
 * the keyboard. A negative offset puts it over the keyboard, e.g. on its toolbar row.
 */
data class OverlayAnchor(val xFraction: Float, val offsetDp: Float) {
    /** Rounded for storage (a tenth of a pixel on a 1080 px wide screen) so a drag does not persist float noise. */
    fun rounded(): OverlayAnchor =
        OverlayAnchor(Math.round(xFraction * 10_000f) / 10_000f, Math.round(offsetDp * 100f) / 100f)

    /** The same row, reflected across the middle of the screen. */
    fun mirrored(): OverlayAnchor = copy(xFraction = 1f - xFraction)

    /** Close enough to [other] that the two buttons would overlap on screen. */
    fun overlaps(other: OverlayAnchor): Boolean =
        abs(xFraction - other.xFraction) < OVERLAP_X && abs(offsetDp - other.offsetDp) < OVERLAP_DP

    /** Human-readable position, e.g. "Centred, 30 dp above the keyboard"; [short] drops the filler words for chips. */
    fun describe(short: Boolean = false): String {
        val across = when {
            xFraction <= 0.02f -> "Left edge"
            xFraction >= 0.98f -> "Right edge"
            abs(xFraction - 0.5f) < 0.015f -> "Centred"
            xFraction < 0.5f -> "${(xFraction * 100).roundToInt()}% from the left"
            else -> "${((1f - xFraction) * 100).roundToInt()}% from the right"
        }
        val o = offsetDp.roundToInt()
        val vertical = when {
            o > 0 -> if (short) "$o dp above" else "$o dp above the keyboard"
            o == 0 -> if (short) "on the edge" else "on the keyboard's top edge"
            else -> if (short) "${-o} dp over" else "${-o} dp down over the keyboard"
        }
        return if (short) "$across · $vertical" else "$across, $vertical"
    }

    companion object {
        /** Centred above the keyboard. */
        const val DEFAULT_X = 0.5f

        /** A 36 dp button whose bottom edge floats 12 dp above the keyboard: centre = 12 + 36 / 2. */
        const val DEFAULT_OFFSET_DP = 30f

        val DEFAULT = OverlayAnchor(DEFAULT_X, DEFAULT_OFFSET_DP)

        private const val OVERLAP_X = 0.12f
        private const val OVERLAP_DP = 30f
    }
}

/** How the spots of a layout relate to each other while they are being edited. */
enum class OverlayArrangement(val id: String) {
    /** Every spot moves on its own; alignment guides help line them up. */
    FREE("free"),

    /** All spots share one vertical position: dragging any of them up or down moves the whole row. */
    SAME_ROW("row"),

    /** All spots share one horizontal position: dragging any of them sideways moves the whole column. */
    SAME_COLUMN("column");

    companion object {
        fun from(id: String?): OverlayArrangement = entries.firstOrNull { it.id == id } ?: FREE
    }
}

/**
 * The places the dictation button can be parked. Outside of editing, dragging the button lets it
 * go to the nearest spot; [activeIndex] is the one it currently rests on. Plain Kotlin so the
 * rules can be unit-tested; persisted through [OverlayLayoutCodec].
 */
data class OverlayLayout(
    val spots: List<OverlayAnchor>,
    val activeIndex: Int = 0,
    val arrangement: OverlayArrangement = OverlayArrangement.FREE
) {
    init {
        require(spots.isNotEmpty()) { "a layout needs at least one spot" }
        require(spots.size <= MAX_SPOTS) { "at most $MAX_SPOTS spots" }
        require(activeIndex in spots.indices) { "active spot $activeIndex out of range" }
    }

    /** The spot the button rests on (and the one selected while editing). */
    val active: OverlayAnchor get() = spots[activeIndex]

    val isDefault: Boolean get() = this == DEFAULT

    val canAdd: Boolean get() = spots.size < MAX_SPOTS

    val canRemove: Boolean get() = spots.size > 1

    fun activated(index: Int): OverlayLayout = copy(activeIndex = index.coerceIn(0, spots.lastIndex))

    /**
     * Move one spot. Under [OverlayArrangement.SAME_ROW] the other spots follow it vertically,
     * under [OverlayArrangement.SAME_COLUMN] horizontally, so the lock always holds.
     */
    fun moved(index: Int, to: OverlayAnchor): OverlayLayout {
        val target = to.rounded()
        return copy(
            spots = spots.mapIndexed { i, spot ->
                when {
                    i == index -> target
                    arrangement == OverlayArrangement.SAME_ROW -> spot.copy(offsetDp = target.offsetDp)
                    arrangement == OverlayArrangement.SAME_COLUMN -> spot.copy(xFraction = target.xFraction)
                    else -> spot
                }
            }
        )
    }

    /** Switch arrangement; locking to a row or column lines every spot up with the active one. */
    fun arranged(next: OverlayArrangement): OverlayLayout = copy(arrangement = next).moved(activeIndex, active)

    /**
     * Add a spot and make it active. It goes on the active spot's row, mirrored across the middle
     * of the screen (or to the far edge when the active spot is near the middle), skipping places
     * that would overlap an existing spot. Under a column lock it stacks above instead.
     * @return null when the layout is full.
     */
    fun added(): OverlayLayout? {
        if (!canAdd) return null
        val spot = suggestNext()
        return copy(spots = spots + spot, activeIndex = spots.size)
    }

    /** @return null when this is the last spot. */
    fun removed(index: Int): OverlayLayout? {
        if (!canRemove || index !in spots.indices) return null
        val remaining = spots.filterIndexed { i, _ -> i != index }
        val nextActive = when {
            activeIndex > index -> activeIndex - 1
            activeIndex == index -> index.coerceAtMost(remaining.lastIndex)
            else -> activeIndex
        }
        return copy(spots = remaining, activeIndex = nextActive)
    }

    private fun suggestNext(): OverlayAnchor {
        val base = active
        val candidates = if (arrangement == OverlayArrangement.SAME_COLUMN) {
            listOf(48f, -48f, 96f, -96f, 144f).map { base.copy(offsetDp = base.offsetDp + it) }
        } else {
            val mirrored = base.mirrored().takeIf { abs(it.xFraction - base.xFraction) >= 0.2f }
            listOfNotNull(mirrored) + listOf(1f, 0f, 0.5f, 0.25f, 0.75f).map { base.copy(xFraction = it) }
        }
        return (candidates.firstOrNull { c -> spots.none { it.overlaps(c) } } ?: candidates.first()).rounded()
    }

    companion object {
        const val MAX_SPOTS = 4

        /** Centred above the keyboard, plus a second spot at the right end of the same row. */
        val DEFAULT = OverlayLayout(
            spots = listOf(OverlayAnchor.DEFAULT, OverlayAnchor(1f, OverlayAnchor.DEFAULT_OFFSET_DP)),
            activeIndex = 0,
            arrangement = OverlayArrangement.FREE
        )

        /** Builds that stored a single position: keep it as the active spot and add a companion. */
        fun fromLegacy(anchor: OverlayAnchor): OverlayLayout {
            val single = OverlayLayout(listOf(anchor.rounded()))
            return (single.added() ?: single).activated(0)
        }
    }
}

/** Persists an [OverlayLayout] as one JSON string, tolerating anything an older or newer build may have written. */
object OverlayLayoutCodec {
    @Serializable
    private data class SpotJson(val x: Float, val y: Float)

    @Serializable
    private data class LayoutJson(val spots: List<SpotJson>, val active: Int = 0, val arrangement: String = "free")

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun encode(layout: OverlayLayout): String = json.encodeToString(
        LayoutJson(
            spots = layout.spots.map { SpotJson(it.xFraction, it.offsetDp) },
            active = layout.activeIndex,
            arrangement = layout.arrangement.id
        )
    )

    /** @return null when [raw] is blank or unusable, so the caller can fall back to a default. */
    fun decode(raw: String?): OverlayLayout? {
        if (raw.isNullOrBlank()) return null
        val parsed = try {
            json.decodeFromString<LayoutJson>(raw)
        } catch (_: Exception) {
            return null
        }
        val spots = parsed.spots
            .filter { it.x.isFinite() && it.y.isFinite() }
            .map { OverlayAnchor(it.x.coerceIn(0f, 1f), it.y.coerceIn(-2_000f, 2_000f)) }
            .take(OverlayLayout.MAX_SPOTS)
        if (spots.isEmpty()) return null
        return OverlayLayout(
            spots = spots,
            activeIndex = parsed.active.coerceIn(0, spots.lastIndex),
            arrangement = OverlayArrangement.from(parsed.arrangement)
        )
    }
}
