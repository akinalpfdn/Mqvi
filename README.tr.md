<p align="center">
  <img src="icons/mqvi-icon-512x512.png" alt="mqvi" width="80" />
</p>

<h1 align="center">mqvi</h1>

<p align="center">
  Ses, video ve metin destekli açık kaynaklı iletişim platformu.<br/>
  Kimlik doğrulama yok. Veri toplama yok. Self-host desteği.
</p>

<p align="center">
  <a href="https://github.com/akinalpfdn/Mqvi/releases/latest/download/mqvi-setup.exe"><img src="icons/btn-windows.svg" alt="Windows İndir" height="48" /></a>&nbsp;&nbsp;
  <a href="https://github.com/akinalpfdn/Mqvi/releases/latest/download/mqvi-setup.dmg"><img src="icons/btn-macos.svg" alt="macOS İndir" height="48" /></a>&nbsp;&nbsp;
  <a href="https://github.com/akinalpfdn/Mqvi/releases/latest/download/mqvi-setup.AppImage"><img src="icons/btn-linux.svg" alt="Linux İndir" height="48" /></a>
</p>

<p align="center">
  <a href="https://mqvi.net">Web Sitesi</a> &middot;
  <a href="#özellikler">Özellikler</a> &middot;
  <a href="SELF-HOSTING.md">Self-Host</a> &middot;
  <a href="ARCHITECTURE.md">Mimari</a> &middot;
  <a href="#yol-haritası">Yol Haritası</a>
</p>

<p align="center">
  <a href="README.md">🇬🇧 English</a>
</p>

<!--
  Ekran görüntüleri buraya. Önerilen set, bu sırayla:
    docs-assets/hero.png      — sunucu + kanal listesi + dolu bir sohbet, güncel tema
    docs-assets/voice.png     — ses kanalı, katılımcılar, biri ekran paylaşıyor
    docs-assets/mobile.png    — aynı sohbet telefonda
    docs-assets/demo.gif      — sese katıl → konuşma göstergesi → ekran paylaşımını başlat (10-15 sn)
-->

---

## Neden mqvi?

Popüler iletişim platformları kullanıcılarından giderek daha çok devlet kimliği istiyor. Yaşanan
onca veri ihlalinden sonra, pasaportunuzu ya da kimliğinizi onlara emanet etmek çoğu insanın
almak zorunda olmadığı bir risk.

**mqvi basit bir ilke üzerine kurulu: konuşmalarınız sizden başka kimsenin olmamalı.**

- Telefon numarası ya da kimlik gerekmez
- Sıfır veri toplama
- Kaynak kodun tamamı açık — güvenmeyin, doğrulayın
- Tam kontrol için kendi sunucunuzda çalıştırın

---

## Tek komutla kendi sunucunuz

```bash
curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/install.sh | sudo bash
```

Tamamı bu. Kurulum betiği ayrı bir sistem kullanıcısı oluşturur, arayüzü gömülü hazır binary'yi
indirir, ses ve video için bir LiveKit SFU kurar, gizli anahtarlarınızı üretir, sıkılaştırılmış
systemd birimlerini yerleştirir ve Caddy'yi otomatik HTTPS ile yapılandırır. Go, Node.js veya
Docker gerekmez. Alan adı da gerekmez — yoksa ücretsiz bir `sslip.io` adresine düşer ve yine gerçek
bir sertifika alır, çünkü tarayıcılar HTTPS olmadan mikrofonu ve ekran paylaşımını engeller.

Kayıt olan **ilk hesap sunucunun sahibi** olur.

Hesabınız mqvi.net'te kalsın, sadece **ses trafiği** kendi makinenizden geçsin ister misiniz? O da
tek satır. İkisi de burada: **[SELF-HOSTING.md](SELF-HOSTING.md)**.

---

## Özellikler

**İletişim** — dosya paylaşımı, düzenleme ve yazıyor göstergesiyle metin kanalları; kendi
barındırdığınız [LiveKit](https://livekit.io) SFU üzerinden düşük gecikmeli ses ve video; 1080p'ye
kadar ekran paylaşımı; arkadaş sistemi ve yabancılardan gelen isteklerin onaya bağlı olduğu direkt
mesajlar; emoji tepkileri; sesli mesajlar; ortak soundboard.

**Gizlilik** — ses ve video **her zaman** uçtan uca şifreli, oda başına SFrame anahtarıyla. Mesaj
şifrelemesi sunucu ya da DM bazında isteğe bağlı: direkt mesajlarda Signal Protokolü (X3DH + Double
Ratchet), kanallarda Sender Key, dosyalarda AES-256-GCM. Cihaz başına kimlik anahtarı ve parolayla
kurtarma.

**Organizasyon** — tek hesapla birden çok sunucu, kanallar ve kategoriler, kanal bazında geçersiz
kılmalarla ayrıntılı rol ve yetki sistemi, davetler, katılım onayı, herkese açık sunucu keşfi, mesaj
sabitleme ve tam metin arama.

**Ses** — bas-konuş ya da ses algılama, kullanıcı başına ses seviyesi, iki gürültü engelleme motoru
(RNNoise ve sinir ağı tabanlı GTCRN), AFK'da otomatik düşürme, ve Windows'ta ekran görüntüsünü GPU'da
kodlayan yerel bir yakalama yolu — oyun paylaşmak size FPS'e mal olmuyor.

**Her yerde** — Windows, macOS ve Linux için otomatik güncellenen masaüstü uygulamaları (fark tabanlı
güncelleme ile), push bildirimleri ve yerel çağrı desteği olan iOS ve Android uygulamaları, ve web.

**Ayrıntılar** — boşta algılamalı durum sistemi, kanal bazında okunmamış ve bahsedilme rozetleri,
klavye kısayolları, sağ tık menüleri, özel temalar ve duvar kâğıtları, uygulama içi yardım merkezi,
ekran görüntüsü ekleyebildiğiniz geri bildirim, ve baştan sona İngilizce + Türkçe.

---

## Nasıl çalışır

```
                    mqvi.net (merkezi)
                    ├── Kullanıcı hesapları
                    ├── Arkadaş listeleri
                    ├── Şifreli DM'ler
                    └── Sunucu dizini
                         /          \
              ┌─────────┘            └──────────┐
              ▼                                  ▼
    Genel Barındırma                      Kendi Sunucunuz
    (mqvi tarafından)                     (sizin altyapınız)
    ├── Metin ve ses kanalları            ├── Metin ve ses kanalları
    ├── Mesajlar ve dosyalar              ├── Mesajlar ve dosyalar
    └── Roller ve yetkiler                └── Roller ve yetkiler
```

mqvi.net'teki tek hesabınız kimliğinizi, arkadaşlarınızı, DM'lerinizi ve üyeliklerinizi taşır —
kullanmaya başlamak için kurulacak bir şey yok. Kanalların ve sesin yaşadığı **sunucular** ise ya
bizde ya sizde barınır. Ya da platformun tamamını kendiniz çalıştırıp kimseye bağlı kalmazsınız.

---

## Teknoloji

| Katman | Teknoloji |
|---|---|
| Backend | Go — `net/http` + `gorilla/websocket` |
| Veritabanı | SQLite (`modernc.org/sqlite`, saf Go), FTS5 trigram arama |
| Frontend | React + TypeScript + Vite, Zustand, tema token'lı elle yazılmış CSS |
| Masaüstü | Electron |
| Mobil | Capacitor (iOS + Android) |
| Ses/Video | LiveKit, kendi barındırdığınız, SFrame E2EE ile |
| Mesaj E2EE | Signal Protokolü (X3DH + Double Ratchet), Sender Key, `@noble/curves` |
| Kimlik | JWT access + refresh |

Sunucu, arayüzü gömülü **tek bir statik binary** olarak derleniyor — tek komutluk kurulumun hiçbir
runtime istememesinin sebebi bu.

---

## Geliştirme

```bash
git clone https://github.com/akinalpfdn/Mqvi.git && cd Mqvi

cd server && go run .                      # backend
cd client && npm install && npm run dev     # frontend, ayrı terminal
npm run electron:dev                        # masaüstü kabuğu, kök dizinden
```

Go 1.22+, Node 22+ ve ses için bir LiveKit sunucusu gerekiyor — `deploy/livekit-setup.sh` yerelde
saniyeler içinde bir tane kuruyor.

**[ARCHITECTURE.md](ARCHITECTURE.md)** parçaların nasıl birleştiğini anlatıyor: katmanlar, WebSocket
hub'ı, ses kanallarının LiveKit instance'larına nasıl bağlandığı, şifreleme modeli ve test
disiplini. Alt sistem bazında daha derin notlar [`architecture/`](architecture/) altında,
[`DECISIONS.md`](DECISIONS.md) ise işlerin neden böyle olduğunu kaydediyor.

---

## Yol Haritası

**Çıkanlar** — metin kanalları, her zaman açık E2EE ile ses ve video, Windows'ta yerel GPU
yakalamayla ekran paylaşımı, roller ve yetkiler, tepkiler, soundboard, sesli mesajlar, DM'ler ve
arkadaşlar, sabitleme, tam metin arama, davetler ve katılım onayı, sunucu keşfi, durum ve AFK
yönetimi, temalar ve duvar kâğıtları, yardım merkezi, otomatik güncellenen masaüstü uygulamaları,
push bildirimleri ve yerel çağrı desteğiyle **iOS ve Android uygulamaları**, çok sunuculu mimari,
tek komutla self-host, DM / kanal / dosya / ses için uçtan uca şifreleme ve anahtar yedekleme, ve
birden çok SFU arasında bölge farkındalıklı ses yönlendirme.

**Planlanan** — eklenti ve bot API'si, sunucular arası federasyon.

---

## Katkı

Katkılar memnuniyetle karşılanır. Issue açmadan veya pull request göndermeden önce lütfen
[Katkı Rehberi](CONTRIBUTING.md)'ni, ilk değişikliğinizden önce de
[ARCHITECTURE.md](ARCHITECTURE.md)'yi okuyun.

---

## Lisans

[AGPL-3.0](LICENSE) — kurumunuz içinde dahil olmak üzere kullanmakta, değiştirmekte ve kendi
sunucunuzda çalıştırmakta özgürsünüz. Değiştirilmiş bir sürümü dağıtır ya da ağ üzerinden başkalarına
sunarsanız, kaynağınızı aynı lisansla yayınlamanız gerekir. Bu şartların dışındaki ticari kullanım
[ayrı bir lisans](COMMERCIAL-LICENSE.md) gerektirir. Katkı şartları [CLA.md](CLA.md)'de.
