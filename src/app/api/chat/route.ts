import { createServiceClient } from "@/lib/supabase/server";
import { mastra } from "@/mastra";
import {
  checkRateLimit,
  getClientIdentifier,
  rateLimitResponse,
  RATE_LIMIT_CONFIGS,
} from "@/lib/rate-limit";
import {
  buildSystemContext,
  buildOpeningPrompt,
  buildTurnPrompt,
} from "@/lib/interviewerPrompts";
import { createStreamCleaner, cleanForStorage } from "@/lib/interviewStream";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { interviewId, token, message, isStart, participantName } = body;

    const identifier = getClientIdentifier(req, token, "chat");
    const rateLimitResult = checkRateLimit(identifier, RATE_LIMIT_CONFIGS.chat);
    if (!rateLimitResult.success) return rateLimitResponse(rateLimitResult);

    const supabase = await createServiceClient();
    const { data: interview, error: fetchError } = await supabase
      .from("interviews")
      .select(
        "*, templates(rubric), projects(model, name, research_goals, target_audience, desired_outcome)",
      )
      .eq("access_token", token)
      .single();

    if (fetchError || !interview) {
      return new Response("Interview not found", { status: 404 });
    }
    if (interview.id !== interviewId) {
      return new Response("Interview ID mismatch", { status: 403 });
    }

    if (isStart && interview.status === "pending") {
      const updateData: {
        status: string;
        started_at: string;
        participant_name?: string;
      } = {
        status: "active",
        started_at: new Date().toISOString(),
      };
      if (participantName) updateData.participant_name = participantName;

      const { error: updateError } = await supabase
        .from("interviews")
        .update(updateData)
        .eq("id", interview.id);
      if (updateError) {
        console.error("Failed to activate interview:", updateError);
        return new Response("Failed to start interview", { status: 500 });
      }
      interview.status = "active";
      if (participantName) interview.participant_name = participantName;
    }

    if (interview.status !== "active" && !isStart) {
      return new Response("Interview is not active", { status: 403 });
    }

    // Fetch existing conversation history. We do this BEFORE the
    // user-message insert so:
    //   1. The prompt builder gets pre-insert history; the current user
    //      message is added separately by buildTurnPrompt (avoids
    //      double-quoting it in the prompt).
    //   2. The LLM call can start while the user-insert is still in
    //      flight on Supabase — saving ~100-300ms per turn.
    const { data: history } = await supabase
      .from("messages")
      .select("role, content")
      .eq("interview_id", interviewId)
      .order("created_at", { ascending: true });

    // Fire-and-forget the user-message insert. We await it before writing
    // the assistant message (below, in the stream pump) so DB ordering is
    // preserved. If the insert fails, we log and continue — the current
    // turn already has the text in the prompt, so the agent responds
    // correctly; the loss is only that this user message is missing from
    // future turns' history.
    const userInsertPromise: PromiseLike<unknown> = isStart
      ? Promise.resolve(null)
      : supabase
          .from("messages")
          .insert({
            interview_id: interviewId,
            role: "user",
            content: message,
          })
          .then(({ error }) => {
            if (error) console.error("Failed to save user message:", error);
            return error;
          });

    const interviewer = mastra.getAgent("interviewerAgent");
    const systemContext = buildSystemContext(
      interview.projects,
      interview.templates?.rubric,
    );
    const prompt = isStart
      ? buildOpeningPrompt(systemContext, {
          participant_name: interview.participant_name,
        })
      : buildTurnPrompt(systemContext, history, message);

    // ---- Streaming response ----
    // Tokens flow agent -> stream cleaner -> client (avatar speaks them as
    // they arrive). The cleaner holds back the tail so [INTERVIEW_COMPLETE]
    // can't leak to the wire. We persist to Supabase BEFORE closing the
    // stream so the client's `done` event implies DB-consistent state.
    const streamResult = await interviewer.stream(prompt);
    // Mastra returns its textStream typed against node:stream/web; runtime
    // is identical to the DOM ReadableStream.
    const textStream = streamResult.textStream as unknown as ReadableStream<string>;
    const cleaner = createStreamCleaner();
    const encoder = new TextEncoder();

    const responseStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = textStream.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            const emit = cleaner.push(value);
            if (emit) controller.enqueue(encoder.encode(emit));
          }

          // Persist BEFORE closing — see comment at top.
          const raw = cleaner.getRaw();
          if (raw.trim()) {
            const { cleaned, complete } = cleanForStorage(raw);
            // Make sure the user message lands first so the messages
            // table stays in natural user→assistant order.
            await userInsertPromise;
            const { error: assistantMsgError } = await supabase
              .from("messages")
              .insert({
                interview_id: interviewId,
                role: "assistant",
                content: cleaned,
              });
            if (assistantMsgError) {
              console.error("Failed to save assistant message:", assistantMsgError);
            }
            if (complete) {
              const { error: completeError } = await supabase
                .from("interviews")
                .update({
                  status: "completed",
                  completed_at: new Date().toISOString(),
                })
                .eq("id", interviewId);
              if (completeError) {
                console.error("Failed to mark interview complete:", completeError);
              }
            }
          } else {
            console.error("Agent returned empty stream");
          }

          const tailFlush = cleaner.flush();
          if (tailFlush) controller.enqueue(encoder.encode(tailFlush));
          controller.close();
        } catch (err) {
          console.error("Stream pump error:", err);
          controller.error(err);
        }
      },
    });

    return new Response(responseStream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return new Response("Internal server error", { status: 500 });
  }
}
