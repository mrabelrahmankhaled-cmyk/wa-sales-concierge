import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  buildPoliteFallbackReply,
  clearSessionHistory,
  MissingApiKeyError,
  runSalesAgent,
} from "@/lib/agent";
import { loadStore, StoreNotFoundError } from "@/lib/store";

const ChatRequestSchema = z.object({
  storeSlug: z.string().min(1),
  sessionId: z.string().min(1),
  message: z.string().optional().default(""),
  action: z.enum(["chat", "reset"]).optional().default("chat"),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 });
  }

  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "بيانات الطلب غير مكتملة" }, { status: 400 });
  }

  const { storeSlug, sessionId, message, action } = parsed.data;

  if (action === "reset") {
    clearSessionHistory(storeSlug, sessionId);
    return NextResponse.json({ ok: true });
  }

  try {
    const result = await runSalesAgent({
      storeSlug,
      sessionId,
      message,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof StoreNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }

    const store = loadStore(storeSlug);

    if (error instanceof MissingApiKeyError) {
      return NextResponse.json(
        {
          reply: buildPoliteFallbackReply(store),
          toolCalls: [],
          handedOff: false,
          modelUsed: "unconfigured",
          apiKeyMissing: true,
          debugError: error.message,
        },
        { status: 200 }
      );
    }

    const debugError = error instanceof Error ? error.message : String(error);
    console.error("[/api/chat] Unexpected error:", debugError);

    return NextResponse.json(
      {
        reply: buildPoliteFallbackReply(store),
        toolCalls: [],
        handedOff: false,
        modelUsed: "fallback-error",
        debugError,
      },
      { status: 200 }
    );
  }
}
