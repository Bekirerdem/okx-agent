# okx-agent

**Kâr kovalamayan, kaybetmemeyi kovalayan otonom spot ajanı.**
OKX TR Agentic Trading Hackathon, 12 Eylül 2026, Komünite Space. Tek geliştirici, tek gün, 30 USDT gerçek sermaye.

> *An autonomous spot-trading agent for OKX TR. The LLM decides, but only inside a risk cage written in code. Every decision, including every rejection, is journaled, streamed to Telegram, rendered on a live panel, and hash-anchored to X Layer.*

---

## 1. Problem

Perakende kripto otomasyonunun iki başarısız ucu var. Kural botları hızlı ama kör: haberi okuyamaz, kararını açıklayamaz. LLM botları konuşkan ama tehlikeli: boyutu, stopu ve sermayeyi bir dil modelinin insafına bırakır. Hafta sonu spot piyasası bu ikisini de cezalandırır: hacim hafta içinin dörtte biri, komisyon gidiş-dönüş yüzde 0,2, hareketin çoğu testere.

## 2. Ürün

okx-agent üçüncü bir yol kurar: **LLM karar verir, kafes koddur.**

- **Ne yapar:** OKX TR spot piyasasında likit 50 pariteyi 15 dakikada bir tarar, stopları avlanmış coini alır, aralığın ortasına dönünce satar, BTC bozulunca nakitte bekler, 19:15'te zorunlu nakde geçer.
- **LLM'in yetkisi:** aday listesinden seçmek ya da hepsini reddetmek, gerekçesiyle. Haber vetosu. Sahibinin sorularına günlükten cevap.
- **LLM'in yetkisi olmayan:** pozisyon boyutu, stop mesafesi, BTC kapısı, günlük fren, işlem sayısı. Bunlar config dosyasında sabittir ve prompt'ta görünmez.
- **Kime değer:** otomasyon isteyen ama sermayesini bir dil modeline teslim etmek istemeyen herkes. Ajanın çıktısı işlem değil, **gerekçeli karar akışı**; işlem onun yan ürünüdür.

## 3. Kanıt

Strateji tahmin değil, ölçüm. Etkinlik öncesi OKX TR'nin 15 dakikalık verisiyle 40 likit paritede 26 hafta (25 Cumartesi) test edildi, komisyon düşülmüş:

| Bulgu | Sonuç |
|---|---|
| 16 giriş sinyali (RSI, EMA, Bollinger, VWAP, hacim, kırılım, geri test, funding…) | Hiçbiri 1-2 saatlik ufukta komisyonu güvenilir şekilde yenmedi |
| Kırılım kovalama, hacimli 15 dk mum | Cumartesi başabaş, hafta içi işlem başına −%0,16 |
| Göreli güç kovalama, en güçlü 3 coini tut | Cumartesi günde ortalama −%1,36 |
| Dip süpürme + içeri kapanış, aralık ortası hedef | İşlem başına +%0,26, işlemlerin %70'i pozitif |
| Gün sonucu ↔ BTC'nin günü | Korelasyon 0,43; BTC yeşilken +%0,81, kırmızıyken −%0,43 |
| Tam risk motoruyla gün simülasyonu | 25 Cumartesi'nin 15'i pozitif, en kötü gün −%0,34, ortalama max DD −%0,24 |

Çıkarım: hafta sonu spotta kenar sinyalde değil, seçicilikte ve BTC kapısında. Ajan bu ölçümün ürünüdür.

## 4. Mimari

Beş rol, iki ritim. Her günlük satırı hangi rolün konuştuğunu söyler.

```
 60 s ┐  İcracı   pozisyonları yönet: hedef → sat · 19:15 → hepsini sat · fren → hepsini sat, dur
      │  Hakem    stop takibi · gün freni · özkaynak ölçümü
15 dk ┤  Gözcü    BTC kapısı → evren (≤50 likit USDT paritesi) → süpürme adayları
      │  Seçici   emir defteri · smart money · duygu skoru · haber → gerekçeli seç / reddet   [LLM]
      │  Hakem    boyut · tavanlar · fren                                                     [kod]
      │  İcracı   limit alış + borsada ekli stop
      └  Kâtip    JSONL · Markdown · Telegram · X Layer denetim izi
```

| Rol | Modül | Sorumluluk |
|---|---|---|
| Gözcü | `market.ts`, `signals.ts` | Evren, mumlar, BTC kapısı, süpürme tespiti, göreli güç, defter dengesi |
| Seçici | `llm.ts` | Adayları zenginleştirilmiş bağlamla gerekçelendirir; `claude -p` → Gemini → kural motoru |
| Hakem | `risk.ts` | Pozisyon boyutu, tavanlar, günlük fren, lot ve fiyat yuvarlama. Saf fonksiyonlar, birim testli |
| İcracı | `exchange.ts` | Limit alış + ekli stop, zaman aşımı iptali, hedefte satış, algo iptali. `--dry-run` hiç emir göndermez |
| Kâtip | `journal.ts`, `anchor.ts`, `report.ts` | Karar günlüğü, Telegram, X Layer, gün sonu raporu |
| Döngü | `agent.ts` | İki ritim, durum yönetimi, yeniden başlatmada borsayla uzlaştırma |
| Arayüz | `commands.ts`, `dashboard.ts` | Telegram komutları ve serbest soru; canlı panel |

## 5. Risk kafesi

| Kural | Değer | Uygulayan |
|---|---|---|
| BTC kapısı | 4 saatlik getiri < −%1 → yeni giriş yok | kod |
| Giriş | son 15 dk mumu 3 saatlik dibi ≥ %0,3 delmiş, üstüne yeşil kapanmış; göreli güç ≤ +%2; cooldown 2 saat | kod |
| Boyut | min(özkaynak × %0,5 / %4, özkaynak × %12,5) | kod |
| Sınırlar | aynı anda ≤ 3 pozisyon · günde ≤ 10 işlem · gün −%2 → fren | kod |
| Stop | %4 altta, emre ekli, **borsa tarafında**; ajan çökse de çalışır | borsa |
| Çıkış | 3 saatlik aralığın ortası (≥ giriş + %0,3) · 19:15 zorunlu nakit | kod |
| Emir | limit, mum kapanış fiyatı; 120 s içinde dolmazsa iptal | kod |
| Seçim ve veto | aday seçimi, haber vetosu, gerekçe | LLM |

## 6. OKX Agent Trade Kit entegrasyonu

Emir ve hesap işlemleri yalnızca ATK MCP sunucusu üzerinden gider (`okx-trade-mcp`, stdio JSON-RPC). Piyasa verisi için anahtarsız REST yedeği vardır; yedek asla emir göndermez. `site = "tr"` ile OKX TR'ye bağlanır; aynı yapılandırma `global` ile OKX Global'e de bağlanır.

| Modül | Araçlar | Kullanım |
|---|---|---|
| market | `get_tickers` `get_instruments` `get_candles` `get_ticker` `get_orderbook` | Evren, lot kuralları, 15 dk mumlar, son fiyat, ±%1 defter dengesi |
| spot | `place_order` (ekli SL) `get_order` `cancel_order` `get_algo_orders` `cancel_algo_order` `get_fills` | Giriş, takip, iptal, stop yönetimi, gerçekleşen işlemler |
| account | `get_balance` | Özkaynak, kullanılabilir ve dondurulmuş bakiye |
| news | `get_by_coin` `get_coin_sentiment` `get_latest` | Haber vetosu, duygu skoru, saat başı piyasa notu |
| smartmoney | `get_signal_overview_by_filter` | Lider trader long oranı, kalabalık uyarısı |

Panel her aracın çağrı sayısını canlı gösterir. Ajan Claude Code'a da MCP sunucusu olarak kayıtlıdır; aynı araçlar sohbette elle çağrılabilir.

## 7. Güvenilirlik ve güvenlik

- **Durum diske:** her adımda `state/state.json`; yeniden başlatmada bakiye ve pozisyonlar borsadan okunup uzlaştırılır.
- **Bozulma modları:** LLM düşerse kural motoru sürer ve günlüğe "LLM çevrimdışı" düşer. MCP düşerse yeni emir yok, borsadaki stoplar korur. Telegram düşerse ajan durmaz.
- **Kill switch:** Telegram `/dur` her şeyi satar ve günü kapatır; `/devam` açar.
- **Kanıtlanmış emir yolu:** canlı alt hesapta alış, ekli stop, stop iptali, satış, zaman aşımı iptali uçtan uca test edildi (`scripts/smoke.ts`).
- **Yetki:** API anahtarı yalnızca okuma ve al-sat; çekim ve transfer kapalı. Anahtarlar `~/.okx/config.toml`'da, repoda değil.
- **Test:** `bun test`, sinyal ve risk motoru için 19 birim testi; `tsc --noEmit` sıfır hata.

## 8. Etkileşim

**Telegram** (yalnız sahibinin sohbeti):
`/durum` · `/pozisyon` anlık kâr/zarar · `/adaylar` son tarama ve Seçici'nin gerekçeleri · `/neden COIN` · `/kurallar` · `/rapor` · `/dur` · `/devam` · `/zincir`.
Komut olmayan her mesaj Seçici'ye sorudur: "sabahtan beri neden işlem açmadın" gibi. Cevap günlük bağlamından gelir, uydurma yoktur.

**Panel** (`bun run dashboard`, http://localhost:8787): özkaynak ve gün içi eğri, kapı durumu, sayaçlar, risk kafesi, rol etiketli karar akışı, Seçici'nin son kararı, pozisyonlar, kapanan işlemler, MCP araç defteri, X Layer kayıtları. 4 saniyede bir yenilenir.

## 9. Denetim izi

Her 15 dakikada karar günlüğü batch'i SHA-256 ile hash'lenir ve X Layer testnet'e (chain 1952) sıfır değerli bir işlemin data alanına yazılır. `state/anchors.jsonl` batch dosyasını ve tx hash'ini tutar. Günlük sonradan değiştirilemez; jüri zincirdeki hash ile dosyadaki batch'i karşılaştırabilir. Gaz biterse modül kendini kapatır, ajan etkilenmez.

## 10. Çalıştırma

```
bun install
cp .env.example .env            # TG_BOT_TOKEN, TG_CHAT_ID, LLM_PROVIDER, ANCHOR_*
okx config init                 # ~/.okx/config.toml → [profiles.live] site = "tr"
bun test                        # sinyal + risk testleri
bun run dry                     # emir göndermeden tam döngü
bun run agent                   # canlı (basla.bat)
bun run dashboard               # panel (panel.bat)
bun run report                  # performans dökümü
```

Gereksinimler: Bun ≥ 1.3, Node ≥ 18 (ATK için), `@okx_ai/okx-trade-mcp` ve `@okx_ai/okx-trade-cli` global kurulu, Claude Code veya Gemini API anahtarı.

## 11. Sınırlar ve yol haritası

- 26 haftalık kanıt, hafta sonu spot rejimine özgüdür; hafta içi aynı sinyal negatiftir. Ajan gün tipini bilir, kural setini buna göre taşımaz.
- Sermaye 30 USDT; boyutlama yüzdeyle çalışır, büyüdükçe aynı kurallar geçerlidir.
- Sırada: kırılım kovalayan gölge botla canlı karşılaştırma, insan-döngüde onaylı mod, OKX Global ve Bitget adaptörleri, gün sonu LLM post-mortem'i.

## 12. Dizin

```
src/        agent · market · signals · risk · llm · exchange · journal · anchor · commands · dashboard · report
tests/      signals.test.ts · risk.test.ts
scripts/    smoke.ts (canlı emir yolu testi) · anchor_test.ts
docs/       spec.md (tasarım kararları)
state/      günlük, durum, rapor, zincir kayıtları (git dışı)
```

Geliştirici: Bekir Erdem · github.com/Bekirerdem · Lisans: MIT
