import Link from "next/link";
import { isGeminiConfigured } from "@/lib/agent";
import { listStoreSlugs, loadStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const slugs = listStoreSlugs();
  const stores = slugs.map((slug) => loadStore(slug));
  const apiKeyReady = isGeminiConfigured();

  return (
    <main className="min-h-screen bg-gradient-to-b from-[#075e54] via-[#0a4a43] to-slate-950 text-white px-4 py-12">
      <div className="max-w-4xl mx-auto space-y-8">
        <header className="space-y-3 text-center">
          <span className="inline-flex items-center gap-2 rounded-full bg-emerald-400/15 border border-emerald-300/30 px-4 py-1 text-xs font-medium text-emerald-200">
            Zero-Hallucination AI Sales Engine • Salla &amp; Zid Ready
          </span>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
            مساعد مبيعات واتساب الذكي للمتاجر السعودية
          </h1>
          <p className="text-emerald-100/80 max-w-2xl mx-auto text-sm sm:text-base leading-relaxed">
            محرك مبيعات ذكي متعدد المتاجر يعمل بـ Gemini Function Calling بدون أي اختلاق للأسعار أو
            الأوزان أو المخزون، مع محاكي واتساب تفاعلي وربط مباشر مع Meta WhatsApp Cloud API.
          </p>
        </header>

        {!apiKeyReady && (
          <div className="rounded-2xl border border-amber-300/40 bg-amber-500/15 p-4 text-amber-100 text-sm leading-relaxed">
            <p className="font-semibold mb-1">⚠️ تنبيه إعداد المفتاح (GEMINI_API_KEY غير مضاف)</p>
            <p>
              لتشغيل الردود الحية في المحاكي، انسخ ملف{" "}
              <code className="bg-black/30 px-1.5 py-0.5 rounded font-mono">.env.example</code> إلى{" "}
              <code className="bg-black/30 px-1.5 py-0.5 rounded font-mono">.env.local</code> وأضف
              مفتاح <code className="bg-black/30 px-1.5 py-0.5 rounded font-mono">GEMINI_API_KEY</code>.
            </p>
          </div>
        )}

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-emerald-100">
              المتاجر المفعّلة ({stores.length})
            </h2>
            <span className="text-xs text-emerald-200/70 font-mono" dir="ltr">
              src/stores/&lt;slug&gt;/
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {stores.map(({ config, catalog }) => {
              const inStockCount = catalog.filter((p) => p.inStock).length;
              return (
                <div
                  key={config.slug}
                  className="rounded-2xl bg-white/10 backdrop-blur-md border border-white/15 p-5 flex flex-col justify-between gap-5"
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-lg font-bold text-white">{config.storeName}</h3>
                      <span
                        className="text-xs font-mono bg-black/25 px-2.5 py-0.5 rounded-full text-emerald-200"
                        dir="ltr"
                      >
                        /{config.slug}
                      </span>
                    </div>
                    <p className="text-xs text-emerald-100/80">
                      {catalog.length} منتجات في الكتالوج ({inStockCount} متوفر •{" "}
                      {catalog.length - inStockCount} نفدت كميته) • العملة: {config.currency}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Link
                      href={`/demo/${config.slug}`}
                      className="flex-1 text-center rounded-xl bg-[#25d366] hover:bg-[#20bd5a] text-slate-950 font-semibold py-2.5 px-4 text-sm transition"
                    >
                      فتح محاكي واتساب
                    </Link>
                    <Link
                      href={`/demo/${config.slug}?debug=1`}
                      className="rounded-xl bg-white/10 hover:bg-white/20 text-white font-medium py-2.5 px-3.5 text-xs transition flex items-center"
                    >
                      وضع المطور (Debug)
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-2xl bg-black/25 border border-white/10 p-5 space-y-2 text-xs text-emerald-100/80">
          <div className="font-semibold text-white text-sm">
            القناة الثانية: ربط Meta WhatsApp Cloud API الجاهز للإنتاج
          </div>
          <p>
            نقطة الربط المباشرة:{" "}
            <code className="bg-white/10 px-2 py-0.5 rounded font-mono text-emerald-200" dir="ltr">
              /api/webhook/whatsapp
            </code>{" "}
            تدعم التحقق عبر <code className="font-mono">GET</code> واستقبال الرسائل ومنع التكرار
            والرد التلقائي عبر نفس محرك المبيعات عبر <code className="font-mono">POST</code>.
          </p>
        </section>
      </div>
    </main>
  );
}
