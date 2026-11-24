import { z } from "zod";
import { runSalesAgent, type GenAIClientLike } from "./agent";
import { loadStore } from "./store";

const DEDUP_TTL_MS = 30 * 60 * 1000; // Keep processed message IDs for 30 minutes
const processedMessageIds = new Map<string, number>();

function pruneProcessedMessageIds(now = Date.now()): void {
  for (const [id, timestamp] of processedMessageIds.entries()) {
    if (now - timestamp > DEDUP_TTL_MS) {
      processedMessageIds.delete(id);
    }
  }
}

export function isDuplicateMessageId(messageId: string, now = Date.now()): boolean {
  pruneProcessedMessageIds(now);
  if (processedMessageIds.has(messageId)) {
    return true;
  }
  processedMessageIds.set(messageId, now);
  return false;
}

export function resetWebhookDeduplication(): void {
  processedMessageIds.clear();
}

export const WhatsAppMessageSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    timestamp: z.string().optional(),
    type: z.string(),
    text: z
      .object({
        body: z.string(),
      })
      .optional(),
  })
  .passthrough();

export const WhatsAppWebhookPayloadSchema = z
  .object({
    object: z.string().optional(),
    entry: z
      .array(
        z
          .object({
            id: z.string().optional(),
            changes: z
              .array(
                z
                  .object({
                    field: z.string().optional(),
                    value: z
                      .object({
                        messaging_product: z.string().optional(),
                        metadata: z
                          .object({
                            phone_number_id: z.string().optional(),
                          })
                          .passthrough()
                          .optional(),
                        messages: z.array(WhatsAppMessageSchema).optional(),
                      })
                      .passthrough(),
                  })
                  .passthrough()
              )
              .optional(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

export interface ExtractedWhatsAppMessage {
  id: string;
  from: string;
  type: string;
  textBody?: string;
  phoneNumberId?: string;
}

/**
 * Safely validates and extracts incoming user messages from a Meta WhatsApp Cloud API payload.
 */
export function extractWhatsAppMessages(payload: unknown): ExtractedWhatsAppMessage[] {
  const parsed = WhatsAppWebhookPayloadSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.entry) {
    return [];
  }

  const extracted: ExtractedWhatsAppMessage[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes ?? []) {
      const phoneNumberId = change.value?.metadata?.phone_number_id;
      for (const msg of change.value?.messages ?? []) {
        extracted.push({
          id: msg.id,
          from: msg.from,
          type: msg.type,
          textBody: msg.type === "text" ? msg.text?.body : undefined,
          phoneNumberId,
        });
      }
    }
  }
  return extracted;
}

export async function sendWhatsAppCloudReply(params: {
  to: string;
  body: string;
  phoneNumberId?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ sent: boolean; status?: number }> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneId =
    process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || params.phoneNumberId?.trim();

  if (!accessToken || !phoneId) {
    console.warn(
      "[WhatsApp Webhook] Skipping Graph API outbound call because WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not configured."
    );
    return { sent: false };
  }

  const endpoint = `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}/messages`;
  const fetchFn = params.fetchImpl ?? fetch;

  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: params.to,
      type: "text",
      text: {
        preview_url: true,
        body: params.body,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.error(`[WhatsApp Webhook] Graph API error (${response.status}): ${errText}`);
    return { sent: false, status: response.status };
  }

  return { sent: true, status: response.status };
}

export interface WebhookDependencies {
  aiClient?: GenAIClientLike;
  fetchImpl?: typeof fetch;
}

/**
 * Core WhatsApp Cloud API POST processor
 */
export async function handleWhatsAppWebhookPost(
  payload: unknown,
  deps?: WebhookDependencies
): Promise<{
  processed: number;
  duplicatesIgnored: number;
  replies: Array<{ to: string; reply: string; handedOff: boolean }>;
}> {
  const storeSlug = process.env.DEFAULT_STORE_SLUG?.trim() || "demo-jewelry";
  const store = loadStore(storeSlug);
  const incomingMessages = extractWhatsAppMessages(payload);

  let processed = 0;
  let duplicatesIgnored = 0;
  const replies: Array<{ to: string; reply: string; handedOff: boolean }> = [];

  for (const msg of incomingMessages) {
    if (isDuplicateMessageId(msg.id)) {
      duplicatesIgnored += 1;
      continue;
    }

    processed += 1;

    // Handle non-text messages gracefully (images, voice notes, stickers, locations, etc.)
    if (msg.type !== "text" || !msg.textBody?.trim()) {
      const politeFallback = `يا هلا وحياك الله في ${store.config.storeName} ✨\nحالياً أقدر أخدمك عبر الرسائل النصية فقط 🙏 ياليت ترسل لي استفسارك كتابةً أو كود القطعة (مثل B039) وأبشر بالرد الفوري، أو تواصل مباشرة مع فريق المبيعات على ${store.config.humanHandoffPhone}.`;
      await sendWhatsAppCloudReply({
        to: msg.from,
        body: politeFallback,
        phoneNumberId: msg.phoneNumberId,
        fetchImpl: deps?.fetchImpl,
      });
      replies.push({ to: msg.from, reply: politeFallback, handedOff: false });
      continue;
    }

    const agentResult = await runSalesAgent({
      storeSlug,
      sessionId: `wa:${msg.from}`,
      message: msg.textBody,
      client: deps?.aiClient,
    });

    await sendWhatsAppCloudReply({
      to: msg.from,
      body: agentResult.reply,
      phoneNumberId: msg.phoneNumberId,
      fetchImpl: deps?.fetchImpl,
    });

    replies.push({
      to: msg.from,
      reply: agentResult.reply,
      handedOff: agentResult.handedOff,
    });
  }

  return { processed, duplicatesIgnored, replies };
}
