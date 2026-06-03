/**
 * Per-interview persona/session config for the Anam avatar.
 *
 * We reference a **stateful Persona** configured in lab.anam.ai (Build tab
 * → Personas) by its persona ID. That persona bundles the avatar, voice,
 * system prompt, and LLM in one place. Change them in the lab and the
 * next interview picks them up — no redeploy.
 *
 * **CRITICAL:** The persona's LLM in lab.anam.ai MUST be set to
 * "Custom (client-side)". Otherwise Anam's built-in LLM will respond to
 * the user IN ADDITION to our /api/chat brain (Mastra interviewerAgent),
 * producing duplicate or contradictory turns.
 *
 * Why client-side LLM? The InterviewOST app already owns the conversation
 * (rubric, story-based questioning, snapshot, OST). Our route streams the
 * agent's text back to the avatar via `anamClient.createTalkMessageStream`.
 * Anam in this mode handles only STT, TTS, video, and lip-sync.
 *
 * Docs: https://anam.ai/docs/personas/llms/custom-llms
 *       https://anam.ai/docs/api-reference/sessions/create-session-token
 */

// Persona ID from lab.anam.ai (Build tab → click the persona → see URL).
// To change which persona is used, swap this UUID.
const DEFAULT_PERSONA_ID = "ee9cc649-dab9-41e5-87fa-1a4048527dcf";

export interface BuildPersonaConfigOptions {
  /** Override the persona id (defaults to the project's persona). */
  personaId?: string;
}

/**
 * Shape sent to Anam's /v1/auth/session-token endpoint under personaConfig.
 * Anam accepts either:
 *   - { personaId }                                          ← stateful (this)
 *   - { name, avatarId, voiceId, llmId, systemPrompt }       ← ephemeral
 * We use the stateful form so face/voice/prompt are editable in Anam Lab.
 */
export interface AnamPersonaConfig {
  personaId: string;
}

export function buildPersonaConfig(
  opts: BuildPersonaConfigOptions = {},
): AnamPersonaConfig {
  return { personaId: opts.personaId ?? DEFAULT_PERSONA_ID };
}

/**
 * Session-level options forwarded at the TOP LEVEL of the session-token
 * request (the route spreads `sessionOptions` next to `personaConfig`).
 *
 * - `skipGreeting`: true because our Interviewer agent generates the
 *   opening on the first /api/chat call; the avatar speaks that.
 * - `uninterruptibleGreeting`: false so the participant can barge-in
 *   immediately if they want.
 * - `voiceDetectionOptions.speechEnhancementLevel`: 1 = maximum noise
 *   reduction on the mic input before VAD runs. Background sounds
 *   (cough, paper rustle, fan, dog bark) are filtered out and won't
 *   spuriously interrupt the avatar mid-sentence. Intentional speech
 *   from the participant still triggers barge-in normally — Anam does
 *   not expose a "disable barge-in entirely" switch.
 * - `voiceDetectionOptions.endOfSpeechSensitivity`: 0 = the agent
 *   waits until it's confident the participant has finished speaking
 *   before responding. Reduces "responded to a half-sentence" mistakes.
 */
export const SESSION_OPTIONS = {
  skipGreeting: true,
  uninterruptibleGreeting: false,
  voiceDetectionOptions: {
    speechEnhancementLevel: 1,
    endOfSpeechSensitivity: 0,
  },
} as const;
