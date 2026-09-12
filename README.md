# okx-agent — Cumartesi spot piyasasında kaybetmemeyi kovalayan otonom ajan

OKX TR Agentic Trading Hackathon, 12 Eylül 2026, Komünite Space. Tek kişi, tek gün, 30 USDT.

## Tez

26 haftalık OKX TR 15 dakikalık veride (40 likit parite, 25 Cumartesi) 16 giriş sinyali test edildi.
Hiçbiri komisyonu (gidiş-dönüş %0,2) güvenilir şekilde yenmedi; kırılım ve göreli güç kovalayan sinyaller eksi.
Cumartesi spot **geri dönüş piyasası**dır. Bu yüzden ajan kâr kovalamaz, **kaybetmemeyi** kovalar:

- stopları avlanmış coini alır (dip süpürme + içeri yeşil kapanış),
- 3 saatlik aralığın ortasına dönünce satar,
- BTC bozulunca nakitte bekler.

**LLM karar verir, ama risk kafesinin içinde. Kafes koddur.**

## Karar döngüsü

```
her 60 s  ─► pozisyonları yönet: hedef → sat · 19:15 → hepsini sat · gün freni → hepsini sat, dur
her 15 dk ─► BTC kapısı ─► evren taraması (≤50 likit USDT paritesi) ─► süpürme adayları
            ─► zenginleştirme (emir defteri dengesi · smart money · haber)
            ─► LLM seçici (gerekçeli seç / reddet) ─► risk motoru (boyut, tavan, fren)
            ─► limit alış + borsada ekli stop ─► karar günlüğü (JSONL · Markdown · Telegram)
```

| Katman | Kural |
|---|---|
| BTC kapısı | BTC 4 saatlik getiri < −%1 → yeni giriş yok |
| Giriş | son 15 dk mumu 3 saatlik dibi ≥ %0,3 delip üstüne yeşil kapanmış; göreli güç ≤ +%2; cooldown 2 saat |
| Boyut | min(özkaynak × %0,5 / %4, özkaynak × %12,5) |
| Sınırlar | aynı anda ≤ 3 pozisyon, günde ≤ 10 işlem, gün −%2 → fren |
| Çıkış | hedef = aralık ortası (≥ giriş + %0,3); 19:15 zorunlu nakit; %4 felaket stopu **borsada** |
| Emir | limit, mum kapanış fiyatı; 120 s içinde dolmazsa iptal |

LLM'in yetkisi: adaylar arasından seçmek ya da hepsini reddetmek, gerekçesiyle. Boyut, stop, kapı ve frene erişimi yok.
LLM cevap vermezse kural motoru derinliğe göre seçer ve günlüğe "LLM çevrimdışı" düşer.

## Mimari

Beş rol, iki ritim. Her günlük satırı hangi rolün konuştuğunu söyler.

| Rol | İş | Ritim |
|---|---|---|
| Gözcü | BTC kapısı, evren taraması, süpürme adayları | 15 dk |
| Seçici (LLM) | adayları haber, defter, smart money ile gerekçelendirip seçer/reddeder | 15 dk |
| Hakem | boyut, tavanlar, gün freni, stop takibi; LLM'in erişemediği kafes | her karar |
| İcracı | limit alış + ekli stop, iptal, hedefte satış, 19:15 nakit | 60 s |
| Kâtip | karar günlüğü: JSONL, Markdown, Telegram; gün sonu raporu | her olay |


| Dosya | İş |
|---|---|
| `src/mcp.ts` | OKX Agent Trade Kit MCP istemcisi (stdio JSON-RPC). Emir ve hesap sadece buradan. |
| `src/market.ts` | Evren, mumlar, emir defteri, smart money, haber. REST yedek (anahtarsız, sadece piyasa verisi). |
| `src/signals.ts` | Saf sinyal fonksiyonları: süpürme, göreli güç, kapı, defter dengesi. Testli. |
| `src/risk.ts` | Saf risk motoru: boyut, tavanlar, fren, lot yuvarlama. Testli. |
| `src/llm.ts` | Seçici. `claude -p` → Gemini → kural. |
| `src/exchange.ts` | Limit alış + ekli SL, iptal, piyasa satış, algo iptali. `--dry-run` hiç emir göndermez. |
| `src/journal.ts` | Karar günlüğü: `state/journal.jsonl`, `state/journal.md`, Telegram. |
| `src/agent.ts` | Döngü, durum (`state/state.json`), yeniden başlatmada borsayla uzlaştırma. |
| `src/report.ts` | Gün sonu performans dökümü (`state/report.md`). |

Güvenilirlik: durum her adımda diske; yeniden başlatmada bakiye ve pozisyonlar borsadan okunur; MCP çağrıları 3 deneme;
LLM düşerse kurallar sürer; MCP düşerse yeni emir yok, borsadaki stoplar korur; Telegram düşerse ajan durmaz.

## Çalıştırma

```
bun install
cp .env.example .env        # TG_BOT_TOKEN, TG_CHAT_ID, LLM_PROVIDER
okx config init             # ~/.okx/config.toml → [profiles.live] site="tr"
bun test                    # sinyal + risk testleri
bun run dry                 # emir göndermeden tam döngü
bun run agent               # canlı
bun run report              # performans dökümü
```

## Etkileşim

Telegram (sadece sahibin sohbeti): `/durum` · `/pozisyon` (anlık kâr/zarar) · `/adaylar` (son tarama + Seçici'nin gerekçeleri) ·
`/neden COIN` (günlükten o coinin kararları) · `/kurallar` · `/rapor` · `/dur` (acil fren, hepsini sat) · `/devam` · `/zincir` (X Layer izi).
Panel: `bun run dashboard` → http://localhost:8787 (canlı karar akışı, pozisyonlar, özkaynak, MCP araç defteri, zincir kayıtları).

## Denetim izi (X Layer)

Her 15 dakikada karar günlüğü batch'i SHA-256 ile hash'lenir ve X Layer testnet'e (chain 1952) sıfır değerli işlemin data alanına yazılır.
`state/anchors.jsonl` tx hash + batch dosyasını tutar; günlük sonradan değiştirilemez. Gaz yoksa modül kendini kapatır, ajan etkilenmez.

## Araştırma

`docs/spec.md` tasarım; strateji araştırması (6 ve 26 haftalık faktör testleri, gün simülasyonları) etkinlik öncesi
yapıldı ve sunumda tablo olarak gösterildi. Ajanın kendisi etkinlik günü sıfırdan yazıldı.
