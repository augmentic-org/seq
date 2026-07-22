// Augmentic fork: AI provider resolution.
// Preferred: direct Google Gemini API with a FREE AI Studio key
// (GOOGLE_GENERATIVE_AI_API_KEY — aistudio.google.com; nano-banana image tier).
// Fallback: Vercel AI Gateway (AI_GATEWAY_API_KEY — paid, also unlocks gpt-image).
import { createGateway } from "@ai-sdk/gateway"
import { createGoogleGenerativeAI } from "@ai-sdk/google"

export type ProviderKind = "google" | "gateway" | null

export function activeProvider(): ProviderKind {
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) return "google"
  if (process.env.AI_GATEWAY_API_KEY) return "gateway"
  return null
}

export const NO_KEY_ERROR =
  "No AI key configured. Set GOOGLE_GENERATIVE_AI_API_KEY (free key from aistudio.google.com) or AI_GATEWAY_API_KEY in .env.local."

function googleProvider() {
  return createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY })
}

export function gatewayProvider() {
  return createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY })
}

// Text + vision model (prompt enhancement, storyboard analysis).
export function textVisionModel() {
  const kind = activeProvider()
  if (kind === "google") return googleProvider()(process.env.SEQ_GOOGLE_TEXT_MODEL || "gemini-2.5-flash")
  if (kind === "gateway") return gatewayProvider()("google/gemini-2.5-flash")
  return null
}

// Multimodal image-output model (Gemini-style generateText that returns image files).
// Default direct-Google model is nano banana (gemini-2.5-flash-image) — the free-tier one.
export function geminiImageModel() {
  const kind = activeProvider()
  if (kind === "google") return googleProvider()(process.env.SEQ_GOOGLE_IMAGE_MODEL || "gemini-2.5-flash-image")
  if (kind === "gateway") return gatewayProvider()("google/gemini-3-pro-image")
  return null
}
