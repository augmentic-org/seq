import { type NextRequest, NextResponse } from "next/server"
import { generateText } from "ai"
import { textVisionModel, NO_KEY_ERROR } from "@/lib/ai-provider"

export const dynamic = "force-dynamic"

// Augmentic fork: plans N per-panel prompts from one scene description, so the
// storyboard can be generated as N separate text-to-image calls (flux-friendly)
// instead of one grid image that then needs slicing.
export async function POST(request: NextRequest) {
  try {
    const { prompt, panelCount } = await request.json()
    const count = Math.min(Math.max(Number(panelCount) || 6, 2), 12)

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "Prompt is required" }, { status: 400 })
    }

    const model = textVisionModel()
    if (!model) {
      // No LLM available — caller falls back to naive per-panel prompts
      return NextResponse.json({ error: "Configuration error", details: NO_KEY_ERROR }, { status: 500 })
    }

    const result = await generateText({
      model,
      prompt: `You are a professional storyboard artist planning a ${count}-shot sequence.

Scene description: "${prompt}"

Break this into exactly ${count} storyboard panels telling the story beat by beat.

Return ONLY valid JSON (no markdown fences, no commentary) in this shape:
{"style":"<one shared style clause: lighting, palette, lens, character/setting consistency — under 40 words>","panels":["<panel 1 visual description, one sentence, concrete and filmable>", ...exactly ${count} entries]}

Rules: each panel description is purely visual (no text/captions in the image), names the same characters/objects consistently, and advances the story.`,
    })

    let text = result.text.trim()
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) text = fence[1].trim()

    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed.panels) || parsed.panels.length === 0) {
      throw new Error("Model returned no panels array")
    }

    return NextResponse.json({
      style: typeof parsed.style === "string" ? parsed.style : "",
      // strip any leaked "Panel N:" / "Shot N:" prefixes — they'd end up rendered
      panels: parsed.panels
        .slice(0, count)
        .map((p: unknown) => String(p).replace(/^\s*(panel|shot|frame)\s*\d+\s*[:.\-–]\s*/i, "")),
    })
  } catch (error) {
    console.error("Panel planning error:", error)
    return NextResponse.json(
      { error: "Failed to plan panels", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}
