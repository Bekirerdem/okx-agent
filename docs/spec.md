# okx-agent — Tasarım Spesifikasyonu (12 Eylül 2026, etkinlik günü nihai hali)

## Tez

Cumartesi spot piyasası geri dönüş piyasasıdır. 26 haftalık OKX TR 15 dakikalık veride (40 likit parite, 25 Cumartesi) 16 giriş sinyali
test edildi; hiçbiri komisyonu (gidiş-dönüş %0,2) güvenilir şekilde yenmedi, kırılım ve göreli güç kovalayan sinyaller eksi. Momentum
ikinci giriş türü de 26 haftada çürüdü (sabah güçlü → akşam: −%0,03). Ajan kâr hedefler ama hareket kovalamaz: stopları avlanmış
(dip avı) coini alır, 3 saatlik aralığın ortasına dönünce çıkar, BTC bozulunca nakitte bekler. **LLM karar verir, kurallar koddur.**

## Etkinlik kuralları ve puanlama

Spot, long-only, otonom emir. Pencere 09:00–19:30 TR; 19:15 zorunlu nakit; 19:30 dosya kilidi. Sermaye 30 USDT (alt hesap, gerçek).
Puan (etkinlik günü açıklanan): işlevsel değer %30 · kullanıcı deneyimi ve etkileşim %30 · ATK MCP entegrasyon derinliği %20 ·
güvenilirlik ve güvenlik %10 · yenilik %10. Hesap performansı puanlanmıyor.

## Çözünürlük

Sabah 15 dk mum (araştırmayla birebir). 14:45'te ölü piyasada (17 taramada 1 aday, BTC 4 saatte ±%0,1) **5 dk muma** geçildi;
kurallar aynı, süreler mum sayısına çevrildi: dip 3 saat = 36 mum, göreli güç 4 saat = 48, BTC filtresi 4 saat = 48, cooldown 2 saat = 24,
derinlik eşiği %0,15. Tarama ritmi = mum çözünürlüğü.

## Karar döngüsü

Her 60 s **tick** (yeniden giriş kilitli): bakiye, bekleyen emirler (dolum/iptal), açık pozisyonlar (hedef, borsa stopu tespiti), gün sonu,
gün freni, 15 dk'da bir durum kartı ve X Layer batch'i. Her mum kapanışı **tarama**:

1. **BTC filtresi** — BTC 4 saatlik getiri < −%1 → yeni giriş yok, gerekçe günlüğe.
2. **İzleme listesi** — USDT pariteleri, 24 s hacim ≥ 1 M USD, stablecoin/altın/BTC hariç, en fazla 80; saatte bir yenilenir.
3. **Dip avı adayı** — son kapanmış mum: düşük < önceki 36 mumun en düşüğü (derinlik ≥ %0,15), kapanış o seviyenin üstünde, yeşil mum.
   Elenir: 4 saatlik göreli güç > +%2 (kovalama), cooldown, açık/bekleyen pozisyon, aynı sinyal mumu ikinci kez.
4. **Haber adayı** — son 45 dk içinde izleme listesindeki bir coin hakkında somut olay haberi (listeleme, ortaklık, mainnet, geri alım,
   onay…; yorum/fiyat haberleri elenir). Teknik kurulum şartı yok; göreli güç > +%3 ise kovalama sayılır. Günde ≤ 1 haber işlemi. Hedef giriş +%1,5.
5. **Zenginleştirme** — emir defteri alış/satış derinlik oranı (±%1), smart money long oranı, OKX duygu skoru (24 s), son 6 saat haberler,
   teknik bağlam (RSI 14, EMA 20/50 trendi, ATR %, VWAP uzaklığı, hacim oranı). Teknik göstergeler tetik değil, bağlamdır.
6. **Karar (LLM)** — adayları ve bağlamı görür; boş slot kadar seçer ya da hepsini reddeder; gerekçe yazar. Delist/hack/exploit vetosu.
   Dış metinler veri olarak işaretlenir; manipülasyon ifadesi içeren aday reddedilir. Yetkisi yok: boyut, stop, filtre, fren.
   `claude -p` (araçsız, boş dizin) → Gemini → kural motoru (derinliğe göre). Çıktı kodda doğrulanır: yalnız aday listesinden, ≤ boş slot.
7. **Risk** — pozisyon = min(kasa × %0,5 / %4, kasa × %12,5) = kasa × %12,5; aynı anda ≤ 3; günde ≤ 10; gün −%2 → fren (hepsini sat, dur).
8. **Emir** — limit alış, sinyal mumu kapanışı, ekli stop %4 altı (piyasa, borsa tarafında). 120 s'de dolmazsa iptal.
   Onaylı modda giriş öncesi Telegram onayı (60 s, cevap yoksa red).
9. **Çıkış** — hedef: 36 mumluk aralığın ortası (≥ giriş + %0,3) → piyasa satış (önce ekli stop iptali). 19:15 → hepsi nakit. Stop borsada.
10. **Günlük** — her karar rol etiketiyle (Tarayıcı / Karar / Risk / Emir / Günlük) JSONL + Markdown + Telegram (yapılı HTML, hata seyreltme).

## Karşılaştırma ve denetim

- **Kovalayan bot** — aynı veride hacimli kırılım kovalayan naif strateji (TP +2 / SL −1 / 2 saat) emir göndermeden simüle edilir; panel ve
  `/durum` "kovalayan vs ben" gösterir.
- **X Layer denetim izi** — 15 dk'da bir karar batch'i SHA-256 → X Layer testnet (chain 1952) tx datası. `scripts/verify.ts` dosya ile zinciri karşılaştırır.
- **Gün sonu anlatı** — 19:15'te Karar katmanı günün post-mortem'ini yazar.

## Etkileşim

Telegram (yalnız sahibinin sohbeti): `/durum` `/pozisyon` `/adaylar` `/neden COIN` `/kurallar` `/rapor` `/dur` `/devam` `/zincir` `/mod`;
komut olmayan mesaj Karar katmanına sorudur. Panel (127.0.0.1:8787): kasa ve eğri, BTC filtresi, kovalayan vs ben, sayaçlar, risk kuralları,
MCP araç defteri, zincir kayıtları, Karar'a sor kutusu, aday tablosu (teknik bağlam dahil), karar akışı, pozisyonlar.

## Güvenilirlik ve güvenlik

- Durum her adımda diske; yeniden başlatmada bakiye/pozisyon borsadan uzlaştırılır, son tarama/karar metrics.json'dan geri yüklenir.
- LLM düşerse kurallar sürer; MCP/ağ düşerse yeni emir yok, borsadaki stoplar korur, hata günlüğe (Telegram'a seyrek); Telegram düşerse ajan durmaz.
- basla.bat çökmede 5 s sonra yeniden başlatır. `/dur` acil fren.
- API anahtarı yalnız okuma + al-sat. Panel yalnız localhost. LLM alt süreci araçsız ve boş dizinde. Dış metinler temizlenir ve veri olarak işaretlenir.
- Testler: signals, risk, shadow, modül yükleme (`bun test`, 27). `tsc --noEmit` sıfır hata. Canlı emir yolu smoke testle doğrulandı.

## Bilinen sınırlar

- Kanıt 15 dk Cumartesi rejimine özgü; 5 dk çözünürlük ve haber adayı bugünkü koşullar için eklenen, ayrıca test edilmemiş uzantılar; kayıp tavanı kodda.
- Kapanış kâr-zararı borsanın gerçekleşme kaydından okunur; kovalayan bot ajanın elindeki coini atlar (küçük sapma).
- Gün freni gerçekleşmemiş zararı da sayar (tasarım gereği).
