import { NextRequest, NextResponse } from "next/server";
import {
  handleWhatsAppWebhookPost,
  WhatsAppWebhookPayloadSchema,
} from "@/lib/whatsapp-webhook";

/**
 * GET /api/webhook/whatsapp
 * Meta App Dashboard Webhook Verification Handshake
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");
  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (
    mode === "subscribe" &&
    Boolean(expectedToken) &&
    token === expectedToken &&
    challenge !== null
  ) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return NextResponse.json(
    { error: "Webhook verification failed: invalid mode or verify_token." },
    { status: 403 }
  );
}

/**
 * POST /api/webhook/whatsapp
 * Receives incoming WhatsApp messages from Meta Cloud API
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = WhatsAppWebhookPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Malformed webhook payload" }, { status: 400 });
  }

  try {
    const summary = await handleWhatsAppWebhookPost(parsed.data);
    return NextResponse.json({ status: "ok", ...summary }, { status: 200 });
  } catch (error) {
    console.error("[WhatsApp Webhook] Processing error:", error);
    return NextResponse.json(
      { status: "error", message: "Internal processing error logged" },
      { status: 200 }
    );
  }
}
