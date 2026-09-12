# okx-agent

OKX Agent Trade Kit (ATK MCP) üzerinde çalışan, OKX TR spot piyasasında canlı işlem yapan otonom trading ajanı. Aday seçimi LLM'dedir; pozisyon büyüklüğü, stop, fren ve işlem limitleri koddadır; hedef ve stop emirleri borsa tarafında durur; her karar gerekçesiyle günlüğe, Telegram'a, panele ve X Layer'a yazılır.

> *Autonomous spot-trading agent for OKX TR on the OKX Agent Trade Kit. The LLM only selects candidates; sizing, stops and circuit breakers are code; exits are exchange-side OCO orders; every decision, including rejections, is journaled, pushed to Telegram, rendered on a live panel and hash-anchored to X Layer.*

![Bun](https://img.shields.io/badge/Bun-1.3-000000?logo=bun&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white) ![OKX ATK](https://img.shields.io/badge/OKX_ATK-MCP_1.4-000000) ![X Layer](https://img.shields.io/badge/X_Layer-testnet_1952-4B5563) ![Tests](https://img.shields.io/badge/tests-27_passing-15803d) ![License](https://img.shields.io/badge/license-MIT-c2410c)

![okx-agent paneli](docs/sunum/panel.png)

OKX TR Agentic Trading Hackathon (12 Eylül 2026) için geliştirildi; etkinlik günü canlı alt hesapta 09:00–19:15 arasında çalıştı.

---

## İçindekiler

1. [Özellikler](#1-özellikler)
2. [Mimari ve karar mekanizması](#2-mimari-ve-karar-mekanizması)
3. [Risk modeli](#3-risk-modeli)
4. [OKX Agent Trade Kit entegrasyonu](#4-okx-agent-trade-kit-entegrasyonu)
5. [Arayüzler: Telegram ve panel](#5-arayüzler-telegram-ve-panel)
6. [Denetim izi: X Layer](#6-denetim-izi-x-layer)
7. [Güvenilirlik ve güvenlik](#7-güvenilirlik-ve-güvenlik)
8. [Strateji araştırması](#8-strateji-araştırması)
9. [Etkinlik günü sonuçları](#9-etkinlik-günü-sonuçları)
10. [Kurulum ve çalıştırma](#10-kurulum-ve-çalıştırma)
11. [Proje yapısı](#11-proje-yapısı)
12. [Sınırlar ve yol haritası](#12-sınırlar-ve-yol-haritası)

---

## 1. Özellikler

| | |
|---|---|
| **Canlı işlem** | OKX TR alt hesabında gerçek emir. Alış, ekli hedef/stop, iptal ve satış yolu uçtan uca doğrulandı. |
| **Sınırlı LLM yetkisi** | LLM aday listesinden seçer ya da tümünü reddeder; her karar gerekçelidir. Pozisyon büyüklüğü, stop, fren ve işlem limitleri koddadır, prompt'ta yer almaz. |
| **Borsa tarafında çıkış** | Hedef ve stop OCO olarak OKX'te durur. Ajan, bilgisayar ya da bağlantı düşse de pozisyon korumalı kalır. |
| **Tam kayıt** | Seçim, ret, alış, satış, stop ve fren gerekçesiyle günlüğe yazılır, Telegram'a kart olarak düşer, 15 dakikada bir SHA-256 özeti X Layer'a yazılır. |
| **Telegram ile kontrol** | Durum, pozisyon, aday ve gerekçe sorguları; acil fren; onaylı mod (her girişten önce insan onayı); günlük bağlamıyla serbest soru. |
| **Kıyas simülasyonu** | Aynı veride kırılım kovalayan naif bir strateji paralel simüle edilir; panel iki sonucu yan yana gösterir. |
| **Veriye dayalı strateji** | 26 haftalık OKX TR verisiyle 16 giriş sinyali test edildi; kullanılan kurulum bu ölçümden çıktı. |

## 2. Mimari ve karar mekanizması

Beş rol, iki ritim. Her günlük satırı hangi rolün yazdığını belirtir.

```
her 5 dk    Tarayıcı   izleme listesi → BTC filtresi → dip avı sinyali → bağlam (defter, haber, smart money, RSI/EMA/ATR/VWAP/hacim)
(mum kapanışı)  Karar   [LLM]  adayları gerekçesiyle seç / reddet · Claude → Gemini → kural motoru
                Risk    [kod]  boyut · limitler · fren · defter eşiği
                Emir           limit alış + OCO (hedef + stop) borsada · zaman aşımı iptali
her 60 sn   Emir           dolum takibi · kâr kilidi · borsa tarafı kapanış tespiti · 19:15 nakit
            Risk           kasa ölçümü · gün freni
            Günlük         JSONL · Telegram · panel · X Layer
```

Bir coinin işleme dönüşmesi için sırayla geçmesi gereken adımlar:

| # | Adım | Kural | Uygulayan |
|---|---|---|---|
| 1 | İzleme listesi | USDT pariteleri, 24 saatlik hacim ≥ 1M USD, en çok 80 coin; stablecoin ve BTC hariç | kod |
| 2 | BTC filtresi | BTC'nin 4 saatlik getirisi < −%1 ise tarama yok, nakitte bekle | kod |
| 3 | Dip avı sinyali | Son 5 dakikalık mumun dibi önceki 3 saatin dibini ≥ %0,10 delmiş **ve** mum o dibin üstünde **ve** yeşil kapanmış | kod |
| 4 | Kovalama filtresi | Coinin 4 saatlik getirisi BTC'ninkinden en fazla +%2 iyi | kod |
| 5 | Bekleme | Aynı coinde kapanan işlemden sonra 2 saat giriş yok; aynı mum ikinci kez değerlendirilmez | kod |
| 6 | Bağlam | Emir defteri alış/satış oranı (±%1), smart money long oranı, 6 saatlik haber ve duygu skoru, RSI 14, EMA 20/50 trendi, ATR, VWAP uzaklığı, hacim oranı. Defter < 0,7 ise aday LLM'e gitmez | kod |
| 7 | Karar | Boş slot kadar seç ya da reddet; haber vetosu; gerekçe zorunlu. Çıktı kodda doğrulanır (yalnız aday listesindeki coinler, slot sayısını aşmaz) | LLM |
| 8 | Emir | Son kapanıştan limit alış, ekli hedef ve stop; 120 saniyede dolmazsa iptal; dolum limitten %0,2'den fazla saparsa hedef ve stop gerçek giriş fiyatına göre yenilenir | kod + borsa |

**Haber adayı:** son 45 dakikada izleme listesindeki bir coin hakkında somut bir olay haberi (listeleme, ortaklık, mainnet, geri alım, onay) çıkarsa, teknik kurulum olmasa da Karar katmanına "haber" etiketiyle gider. Fiyat zaten yükselmişse kovalama sayılır. Günde en fazla 1 haber işlemi; aynı risk kuralları geçerlidir.

## 3. Risk modeli

Risk kuralları `src/config.ts` içinde sabittir; LLM prompt'unda yer almaz ve LLM tarafından değiştirilemez.

| Kural | Değer | Uygulayan |
|---|---|---|
| İşlem başına azami kayıp | kasanın %0,5'i | kod |
| Pozisyon büyüklüğü | kasanın %12,5'i (tek pozisyon tavanı) | kod |
| Felaket stopu | alış emrine ekli, borsa tarafında; ajan kapalıyken de çalışır | borsa |
| Hedef | 3 saatlik aralığın ortası; borsa tarafında (OCO) | borsa |
| Kâr kilidi | fiyat hedefe yaklaşınca stop girişin üstüne çekilir (`spot_amend_algo_order`) | borsa |
| Eş zamanlı pozisyon | en çok 3 | kod |
| Günlük işlem | en çok 10 | kod |
| Gün freni | kasa gün başına göre −%2 → tüm pozisyonlar kapanır, gün biter | kod |
| Seans | 09:00 açılış · 18:50 son giriş · 19:15 zorunlu nakit | kod |
| Emir defteri eşiği | alış/satış oranı < 0,7 → kod reddeder; 0,7–0,9 → LLM'e "ret eğilimli" talimatı | kod + LLM |

Etkinlik günü en kötü işlem kasanın %0,49'unu kaybettirdi; işlem başına bütçe aşılmadı.

## 4. OKX Agent Trade Kit entegrasyonu

Emir ve hesap işlemleri yalnızca ATK MCP sunucusu üzerinden gider (`@okx_ai/okx-trade-mcp`, stdio JSON-RPC). Piyasa verisi için anahtarsız REST yedeği vardır; yedek emir göndermez. `site = "tr"` ile OKX TR'ye bağlanır; aynı yapılandırma `site = "global"` ile OKX Global'e bağlanır. 5 modül, 18 araç:

| Modül | Araçlar | Kullanım |
|---|---|---|
| `market` | `get_tickers` `get_instruments` `get_candles` `get_ticker` `get_orderbook` | izleme listesi, lot kuralları, 5 dakikalık mumlar, son fiyat, ±%1 defter dengesi |
| `spot` | `place_order` (ekli TP/SL) `get_order` `cancel_order` `place_algo_order` (OCO) `amend_algo_order` `get_algo_orders` `cancel_algo_order` `get_fills` | giriş, takip, iptal, borsa tarafı hedef/stop, kâr kilidi, gerçekleşen işlemler |
| `account` | `get_balance` | kasa, kullanılabilir ve dondurulmuş bakiye |
| `news` | `get_by_coin` `get_coin_sentiment` `get_latest` | haber vetosu, duygu skoru, haber adayı, saat başı piyasa notu |
| `smartmoney` | `get_signal_overview_by_filter` | lider trader long oranı, kalabalık uyarısı |

Panel her aracın çağrı sayısını canlı gösterir. Ajan Claude Code'a da MCP sunucusu olarak kayıtlıdır; aynı araçlar sohbetten elle çağrılabilir.

## 5. Arayüzler: Telegram ve panel

**Telegram** (yalnızca sahibinin sohbeti; başka bir sohbetten gelen komut işlenmez)

| Komut | Ne yapar |
|---|---|
| `/durum` | kasa, BTC filtresi, pozisyon, işlem sayısı, nabız |
| `/pozisyon` | açık pozisyonlar ve anlık kâr/zarar |
| `/adaylar` | son taramanın adayları ve Karar katmanının gerekçesi |
| `/neden COIN` | o coin hakkındaki son gerekçeler |
| `/kurallar` | risk kuralları |
| `/rapor` | anlık performans dökümü |
| `/zincir` | X Layer denetim izi durumu |
| `/dur` · `/devam` | acil fren: tüm pozisyonlar kapanır, yeni işlem açılmaz · freni kaldırır |
| `/mod onaylı` · `/mod otonom` | her girişten önce onay ister, 60 saniyede onay gelmezse işlem açılmaz · kurallar içinde kendi kararıyla girer |
| serbest metin | Karar katmanına soru; cevap günlük kayıtlarından üretilir, kayıt yoksa "günlükte yok" der |

Her olay (alış doldu, hedef, stop, fren, 15 dakikalık durum, saat başı piyasa notu, zincire yazıldı) HTML kart olarak düşer.

**Panel** (`bun run dashboard`, http://localhost:8787) üç soruya cevap verir: *Param ne durumda* (kasa, canlı fiyatla açık pozisyon, kapanan işlemler), *Ajan şu an ne yapıyor* (durum cümlesi, soru kutusu, son karar ve gerekçesi, olay akışı), *Neden güvende* (BTC filtresi, risk kuralları, kıyas simülasyonu, X Layer kayıtları, ATK araç sayaçları). 4 saniyede bir yenilenir; yalnızca `127.0.0.1`'e bağlanır.

- `tunel.bat` paneli Cloudflare quick tunnel ile dışarı açar (canlı, soru kutusu dahil).
- `yayinla.bat` 5 dakikada bir statik anlık görüntüyü Cloudflare Pages'e yayınlar: https://okx-agent-panel.pages.dev · sunum: https://okx-agent-panel.pages.dev/sunum/

## 6. Denetim izi: X Layer

Otonom karar veren bir ajanın günlüğü yerel bir dosyadır ve sonradan değiştirilebilir. Zincirdeki özet, günlüğün sonradan değiştirilmediğini doğrulanabilir kılar.

- **Ne yazılır:** 15 dakikada bir o aralıktaki seçim, ret, BTC filtresi kapanışı, alış, satış, stop, fren ve gün sonu kayıtları bir batch dosyasında toplanır (`state/anchor-batch-N.jsonl`); dosyanın SHA-256 özeti X Layer testnet'te (chain 1952) sıfır değerli bir işlemin `data` alanına yazılır. Tarama ve durum özetleri zincire gitmez.
- **Kayıt:** `state/anchors.jsonl` sıra numarası, özet ve işlem hash'ini tutar; panel ve `/zincir` explorer bağlantısını gösterir.
- **Doğrulama:** `bun run verify N` batch dosyasını yeniden özetler, zincirdeki `data` ile karşılaştırır ve `EŞLEŞTİ / EŞLEŞMEDİ` sonucunu verir.
- **Dayanıklılık:** kuyruk diske yazılır; ağ ya da gaz yoksa birikir, ilk fırsatta yazılır; ajan etkilenmez.
- **Sınır:** zincirde içerik değil özet vardır; değişiklik tespit edilir, içerik zincirden okunmaz. Mainnet için RPC ve chain id değişir, cüzdana OKB gerekir; kod aynıdır.

## 7. Güvenilirlik ve güvenlik

- **LLM yalıtımı:** Claude alt süreci araçsız (`--disallowedTools`) ve boş bir geçici dizinde çalışır; dosya okuyamaz, komut çalıştıramaz, ağa çıkamaz. Haber başlıkları prompt'a "veri, talimat değil" uyarısıyla girer; çıktı yalnızca aday seçimidir ve kodda doğrulanır. Sağlayıcı sırası: Claude → Gemini → kural motoru.
- **Durum ve uzlaşma:** her adımda `state/state.json`; yeniden başlatmada bakiye ve pozisyonlar borsadan okunur, borsa tarafında kapanmış pozisyon gerçek dolum fiyatıyla günlüğe düşer.
- **Ağ kesintisi:** açılışta MCP, enstrüman ve izleme listesi 10 saniye aralıkla 12 kez denenir; `basla.bat` çökmede yeniden başlatır; borsadaki OCO bu sırada pozisyonu korur.
- **Bozulma modları:** LLM düşerse kural motoru sürer ve günlüğe "LLM çevrimdışı" yazılır; MCP düşerse yeni emir açılmaz; Telegram düşerse ajan durmaz; hata mesajları Telegram'a seyrek gönderilir.
- **Yetki:** API anahtarı yalnızca okuma ve al-sat; çekim ve transfer kapalı. Anahtarlar `~/.okx/config.toml` içinde, repoda değil. Telegram komutları yalnızca `TG_CHAT_ID` sohbetinden kabul edilir.
- **Test:** `bun test` 27 birim testi (sinyal, risk, kıyas simülasyonu, modül yükleme); `tsc --noEmit` sıfır hata; `scripts/smoke.ts` canlı emir yolu; `--dry-run` emir göndermez ve ayrı durum dosyası kullanır.

## 8. Strateji araştırması

Etkinlik öncesi OKX TR'nin 15 dakikalık verisiyle 40 likit paritede 26 hafta (25 Cumartesi) test edildi, komisyon düşülmüş:

| Bulgu | Sonuç |
|---|---|
| 16 giriş sinyali (RSI, EMA, Bollinger, VWAP, hacim, kırılım, geri test, funding…) | Hiçbiri 1–2 saatlik ufukta komisyonu güvenilir şekilde yenmedi |
| Kırılım kovalama, hacimli 15 dakikalık mum | Cumartesi başabaş, hafta içi işlem başına −%0,16 |
| Göreli güç kovalama, en güçlü 3 coini tut | Cumartesi günde ortalama −%1,36 |
| **Dip avı + içeri kapanış, aralık ortası hedef** | **İşlem başına +%0,26, işlemlerin %70'i pozitif** |
| Gün sonucu ↔ BTC'nin günü | Korelasyon 0,43; BTC yeşilken +%0,81, kırmızıyken −%0,43 |
| Tam risk motoruyla gün simülasyonu | 25 Cumartesi'nin 15'i pozitif, en kötü gün −%0,34, ortalama maksimum düşüş −%0,24 |

Çıkarım: hafta sonu spot piyasasında kenar giriş sinyalinde değil, seçicilikte ve BTC filtresindedir. Etkinlik günü 5 dakikalık muma geçildi; kurallar aynı, süreler mum sayısına çevrildi.

## 9. Etkinlik günü sonuçları

12 Eylül 2026, canlı alt hesap, 10:39–19:15.

| Ölçüm | Değer |
|---|---|
| Çalışma süresi | 8 saat 36 dakika, 11 otomatik yeniden başlatma (bağlantı kesintileri) |
| Tarama | 65 tarama, 70 parite |
| Karar turu | 5 (2 seçim, 3 gerekçeli ret) |
| Gerçek işlem | 2 (RAY, STORJ); ikisi de borsa tarafındaki stopla kapandı |
| Kasa | −%0,87; en kötü işlem kasanın %0,49'u, işlem başına bütçe aşılmadı |
| Kıyas simülasyonu | kırılım kovalayan naif strateji 14 işlem, −%0,39 |
| X Layer | 13 kayıt |
| ATK MCP | 1.719 çağrı, 14 farklı araç |

Gün içinde tespit edilen ve aynı gün düzeltilen üç durum:

1. **Hedef yalnızca ajanda tutuluyordu.** RAY hedef fiyatı bir fitille gördü; ajan 60 saniyelik tick'te son fiyata baktığı ve o dakika bağlantı koptuğu için çıkışı kaçırdı. Hedef de borsa tarafına taşındı (alışa ekli OCO); mevcut pozisyonlar yeniden başlatmada OCO'ya geçirildi.
2. **Stop, limit fiyatına göre hesaplanıyordu.** STORJ limit emri daha düşük fiyattan doldu; stop mesafesi daraldı ve tetiklendi. Dolum limitten saparsa hedef ve stop gerçek giriş fiyatına göre yenileniyor.
3. **Bağlantı kesintileri.** Mobil bağlantı gün boyu koptu; ajan açılışta REST hatasıyla çöktü. Açılışa 10 saniye aralıkla 12 deneme eklendi; `basla.bat` çökmede yeniden başlatır. Hiçbir pozisyon korumasız kalmadı.

## 10. Kurulum ve çalıştırma

Gereksinimler: Bun ≥ 1.3, Node ≥ 18 (ATK için), `@okx_ai/okx-trade-mcp` ve `@okx_ai/okx-trade-cli` global kurulu, Claude Code (`claude -p`) veya Gemini API anahtarı.

```bash
bun install
cp .env.example .env            # Telegram, LLM sağlayıcı, X Layer ayarları
okx config init                 # ~/.okx/config.toml → [profiles.live] site = "tr"
bun test && bun run typecheck
bun run dry                     # emir göndermeden tam döngü
bun run agent                   # canlı (basla.bat: çökmede yeniden başlatır)
bun run dashboard               # panel (panel.bat)
bun run report                  # gün sonu performans dökümü
bun run verify 10               # X Layer kaydını doğrula
```

| Değişken | Açıklama |
|---|---|
| `OKX_PROFILE` | `~/.okx/config.toml` profili (`live`) |
| `LLM_PROVIDER` | `claude` (varsayılan) ya da `gemini` |
| `TG_BOT_TOKEN` · `TG_CHAT_ID` | Telegram botu ve komut kabul edilen tek sohbet |
| `ANCHOR_PK` · `ANCHOR_ADDRESS` | X Layer cüzdanı (testnet OKB ile fonlanmış) |
| `ANCHOR_CHAIN_ID` · `ANCHOR_RPC` · `ANCHOR_EXPLORER` | `1952` · `https://testrpc.xlayer.tech` · `https://www.oklink.com/xlayer-test` |
| `DASH_PORT` | panel portu (varsayılan 8787) |

## 11. Proje yapısı

```
src/
  agent.ts        iki ritim, durum, borsayla uzlaşma, gün sonu
  market.ts       izleme listesi, mumlar, defter, haber, smart money (ATK + REST yedeği)
  signals.ts      dip avı, BTC filtresi, göreli güç, hedef, teknik bağlam
  risk.ts         boyut, limitler, fren, yuvarlama (saf fonksiyonlar)
  llm.ts          Karar katmanı: prompt, yalıtım, doğrulama, serbest soru
  exchange.ts     limit alış + ekli TP/SL, OCO, stop taşıma, satış, dolum okuma
  journal.ts      günlük (JSONL, Markdown), Telegram kartları, X Layer kuyruğu
  anchor.ts       batch özeti → X Layer, disk kuyruğu
  commands.ts     Telegram komutları, onaylı mod
  shadow.ts       kıyas simülasyonu (kırılım kovalayan strateji)
  dashboard.ts    panel sunucusu · panel_data.ts veri · dashboard.html arayüz
  report.ts       performans dökümü
scripts/          smoke.ts (canlı emir yolu) · verify.ts (zincir doğrulama) · export_panel.ts (statik panel) · anchor_smoke.ts
tests/            signals · risk · shadow · modules
docs/             spec.md (tasarım kararları) · sunum/ (slaytlar + panel.png)
state/            günlük, durum, batch ve zincir kayıtları (git dışı)
```

## 12. Sınırlar ve yol haritası

- Strateji kanıtı hafta sonu spot rejimine aittir; hafta içi aynı sinyal negatif ölçüldü. Ajan gün tipini bilir, kural setini buna göre taşımaz.
- Boyutlama yüzdeyle çalışır; sermaye büyüdükçe aynı kurallar geçerlidir.
- 19:15'te Karar katmanı günün değerlendirmesini yazar: kaç tarama, kaç aday, neden girildi ya da girilmedi, kurallar ne zaman devreye girdi.
- Sırada: stop mesafesinin volatiliteye (ATR) göre belirlenmesi · X Layer mainnet · OKX Global adaptörü (aynı sinyal ve kurallar, farklı emir katmanı) · çok günlük istatistik · onaylı modda panelden onay.

---

Bekir Erdem · [github.com/Bekirerdem](https://github.com/Bekirerdem) · MIT
