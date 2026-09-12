# OKX TR Agentic Trading Hackathon — Ajan Spesifikasyonu (12 Eylül 2026)

## Tez

Cumartesi spot piyasası geri dönüş piyasasıdır. 26 haftalık OKX TR 15 dakikalık veride 16 giriş sinyali test edildi;
hiçbiri komisyonu (gidiş-dönüş %0,2) güvenilir şekilde yenmedi, kırılım ve göreli güç kovalayan sinyaller eksi.
Bu yüzden ajan kâr kovalamaz, **kaybetmemeyi** kovalar: stopları avlanmış (dip avı) coini alır, 3 saatlik aralığın
ortasına dönünce çıkar, BTC bozulunca nakitte bekler. LLM karar verir ama **risk kurallarınin içinde**; kurallar koddur.

## Kurallar (etkinlik)

Spot, long-only, otonom emir. Pencere 09:00–19:30 TR; 19:15 zorunlu nakit; 19:30 dosya kilidi.
Sermaye: 30 USDT (alt hesap). Puan: performans %35 (getiri, risk-ayarlı getiri, max DD) · mimari %25 · risk %20 · özgünlük %10 · sunum %10.

## Karar döngüsü

Her 60 s **tick**: açık pozisyonları yönet (hedef, gün sonu, borsa SL takibi). Her 15 dk **mum kapanışı**:

1. **BTC filtresi** — BTC 4 saatlik getiri < −1 % ise risk bütçesi 0 (yeni giriş yok). Gerekçe günlüğe.
2. **İzleme listesi** — USDT pariteleri, 24 s hacim ≥ 1 M USD, stablecoin/altın hariç, en fazla 80.
3. **Aday** — son 15 dk mumu: düşük < son 12 mumun en düşüğü (derinlik ≥ %0,3), kapanış o seviyenin üstüne dönmüş, yeşil mum.
   Elenir: 4 saatlik göreli güç > +%2 (kovalama), cooldown (2 saat), zaten açık pozisyon.
4. **Zenginleştirme** — emir defteri alış/satış derinlik oranı (±%1 bant), smart money long oranı (varsa), coin haberleri (son 6 saat).
5. **LLM seçici** — adayları ve bağlamı görür; en fazla boş slot kadar aday seçer ya da hepsini reddeder; her seçim ve ret için gerekçe yazar.
   Yetkisi yok: boyut, stop, BTC filtresi, fren. LLM cevapsızsa (60 s) kural motoru derinliğe göre seçer, günlüğe "LLM çevrimdışı".
6. **Risk motoru** — pozisyon = min(kasa × %0,5 / %4, kasa × %12,5); aynı anda ≤ 3 pozisyon; günde ≤ 10 işlem;
   gün eksi %2'ye gelirse **fren**: tüm pozisyonlar kapanır, gün biter.
7. **Emir** — limit alış, mum kapanış fiyatı, ekli SL (%4 altı, piyasa). 120 s dolmadan dolmazsa iptal (kaçırılan işlem = işlem değil).
8. **Çıkış** — hedef: 12 mumluk aralığın ortası (en az giriş + %0,3) → piyasa satış. 19:15 → tüm pozisyonlar piyasa satış. SL borsa tarafında.
9. **Günlük** — her karar (giriş, ret, çıkış, BTC filtresi, fren, hata) JSONL + Markdown + Telegram.

## Güvenilirlik

- Durum `state/state.json`'a her adımda yazılır; yeniden başlatmada borsadan bakiye ve açık emirler okunup uzlaştırılır.
- ATK MCP çağrıları 3 deneme + zaman aşımı; piyasa verisi için REST yedek (anahtarsız). Emir sadece MCP üzerinden.
- LLM çevrimdışı → kural motoru sürer. MCP çevrimdışı → yeni emir yok, borsadaki SL'ler korur, günlüğe düşer.
- `--dry-run`: emir göndermeden tüm döngü.

## Modüller

`mcp.ts` (ATK istemcisi) · `market.ts` (izleme listesi, mumlar, BTC filtresi, REST yedek) · `signals.ts` (saf: dip avı, aralık, göreli güç) ·
`risk.ts` (saf: boyut, limitler, fren) · `llm.ts` (seçici; claude -p, yedek Gemini) · `exchange.ts` (emir/iptal/satış/uzlaştırma) ·
`journal.ts` (JSONL, MD, Telegram) · `agent.ts` (döngü) · `report.ts` (gün sonu performans). Testler: `signals`, `risk`.

## Teslim (19:30)

README · kısa gif · performans dökümü (`report.ts` çıktısı) · çalışır ajan (repo + `bun run agent`).
