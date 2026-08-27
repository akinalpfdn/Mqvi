<p align="center">
  <img src="icons/mqvi-icon-512x512.png" alt="mqvi" width="80" />
</p>

<h1 align="center">mqvi</h1>

<p align="center">
  <b>Açık kaynaklı bir iletişim platformu — ses, video ve metin — çağrılarda her zaman açık şifrelemeyle.</b><br/>
  <a href="https://mqvi.net">mqvi.net</a>'te hesap açıp konuşmaya başlayın, ya da tamamını kendi sunucunuzda çalıştırın.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="Lisans: AGPL-3.0" /></a>
  <a href="https://github.com/akinalpfdn/Mqvi/stargazers"><img src="https://img.shields.io/github/stars/akinalpfdn/Mqvi?style=flat" alt="Yıldız" /></a>
  <a href="https://github.com/akinalpfdn/Mqvi/releases/latest"><img src="https://img.shields.io/github/v/release/akinalpfdn/Mqvi" alt="Son sürüm" /></a>
  <a href="https://github.com/akinalpfdn/Mqvi/commits/main"><img src="https://img.shields.io/github/commit-activity/m/akinalpfdn/Mqvi" alt="Commit aktivitesi" /></a>
  <img src="https://img.shields.io/badge/platformlar-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20iOS%20%7C%20Android-lightgrey" alt="Platformlar" />
</p>

<p align="center">
  <a href="https://github.com/akinalpfdn/Mqvi/releases/latest/download/mqvi-setup.exe"><img src="icons/btn-windows.svg" alt="Windows İndir" height="48" /></a>&nbsp;&nbsp;
  <a href="https://github.com/akinalpfdn/Mqvi/releases/latest/download/mqvi-setup.dmg"><img src="icons/btn-macos.svg" alt="macOS İndir" height="48" /></a>&nbsp;&nbsp;
  <a href="https://github.com/akinalpfdn/Mqvi/releases/latest/download/mqvi-setup.AppImage"><img src="icons/btn-linux.svg" alt="Linux İndir" height="48" /></a>
</p>

<p align="center">
  <sub>iOS ve Android'de de var &middot; bine yakın kayıtlı hesap</sub>
</p>

<p align="center">
  <a href="https://mqvi.net">Web Sitesi</a> &middot;
  <a href="#özellikler">Özellikler</a> &middot;
  <a href="#gizlilik-neyi-tutuyoruz-neyi-asla-yapmıyoruz">Gizlilik</a> &middot;
  <a href="#kendi-sunucunuzda">Self-Host</a> &middot;
  <a href="ARCHITECTURE.md">Mimari</a> &middot;
  <a href="README.md">🇬🇧 English</a>
</p>

<p align="center">
  <img src="docs-assets/hero.webp" alt="mqvi" width="860" />
</p>

<p align="center">
  <img src="docs-assets/demo.gif" alt="mqvi kullanımda" width="860" />
</p>

---

## Özellikler

- ✅ **Ses ve video, her çağrıda uçtan uca şifreli** — açıp kapattığınız bir mod değil, ve sadece
  DM'lerde değil. Oda başına SFrame anahtarı, hem bizim sunucumuzda hem sizinkinde.
- ✅ **Signal protokolü tasarımı üzerine kurulu mesaj şifrelemesi** — DM'lerde X3DH ve Double
  Ratchet, kanallarda Sender Key, cihaz başına kimlik anahtarı, ve parolayla anahtar kurtarma
  (yeni bir cihaz çıkmaz sokak olmasın diye). Sunucu ya da DM bazında isteğe bağlı.
- ✅ **FPS'inize mal olmayan ekran paylaşımı** — Windows'ta yerel bir Rust hattı Windows Graphics
  Capture ile yakalayıp Media Foundation üzerinden GPU'da kodluyor ve doğrudan SFU'ya yayınlıyor;
  işi tarayıcıya yaptırmıyor.
- ✅ **Tek kod tabanından beş platform** — Windows, macOS, Linux, iOS ve Android; masaüstünde
  otomatik güncelleme ve fark tabanlı yama, mobilde yerel çağrı desteği.
- ✅ **Sunucular, kanallar ve roller** — kategoriler, kanal bazında yetki geçersiz kılmaları,
  davetler, katılım onayı, herkese açık keşif, sabitleme ve tam metin arama.
- ✅ **Düzgün çalışan ses** — bas-konuş ya da ses algılama, kullanıcı başına ses seviyesi, iki
  gürültü engelleme motoru, AFK'da düşürme, ve bir sonraki katılımda değil **çağrının ortasında**
  devreye giren yetki değişiklikleri.
- ✅ **Telefon ve kimlik asla istenmiyor** — e-posta bile isteğe bağlı.
- ✅ **Tek komutla self-host** — aynı platform, kendi makinenizde, kurulacak hiçbir runtime olmadan.
- 🚧 **Eklenti ve bot API'si** — planlanan.
- 🚧 **Sunucular arası federasyon** — planlanan.

<table>
  <tr>
    <td width="62%"><img src="docs-assets/voice.webp" alt="Ses kanalı ve ekran paylaşımı" /></td>
    <td width="38%"><img src="docs-assets/mobile.webp" alt="Mobil" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Ses kanalı, ekran paylaşımı açık</sub></td>
    <td align="center"><sub>Aynı sohbet, telefonda</sub></td>
  </tr>
</table>

---

## Gizlilik: neyi tutuyoruz, neyi asla yapmıyoruz

Bu konuda net olmak, slogandan daha değerli.

**Hiç toplanmayanlar** — telefon numarası, devlet kimliği, rehber, reklam veya davranış profili.
E-posta isteğe bağlı. Takip yok, analytics SDK'sı yok, hiçbir şey satılmıyor veya paylaşılmıyor.

**mqvi.net'te duranlar** — hesabınız, arkadaş listeniz, sunucu üyelikleriniz ve mesajlarınız. Bir
sunucu ya da DM için şifrelemeyi açtığınızda sunucu o mesajları **okuyamaz hale geliyor** — ve bunu
client'a güvenerek değil, kendisi zorlayarak yapıyor.

**Ses ve video** için asterisk gerekmiyor: her çağrıda, her sunucuda, kim çalıştırırsa çalıştırsın
uçtan uca şifreli.

Hiçbirinin bizim makinelerimize uğramasını istemiyorsanız o seçenek tek komut uzağınızda — ve bu
seçeneğin var olması, yukarıdakileri bir vaat olmaktan çıkarıp **kontrol edilebilir** yapan şey.

---

## Kendi sunucunuzda

Ne kadarını çalıştırmak istediğinize göre iki yol var.

**Sadece ses sunucusu sizin, hesaplar bizde.** mqvi.net'i normal kullanmaya devam edersiniz; yalnızca
ses ve video trafiği sizin makinenize taşınır. Tek satır, ve 1 GB RAM yeterli.

**Platformun tamamı.** Hesaplar, mesajlar, dosyalar, ses — hepsi sizde:

```bash
curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/install.sh | sudo bash
```

Tamamı bu. Kurulum betiği ayrı bir sistem kullanıcısı oluşturur, arayüzü gömülü hazır binary'yi
indirir, bir LiveKit SFU kurar, gizli anahtarlarınızı üretir, sıkılaştırılmış systemd birimlerini
yerleştirir ve Caddy'yi otomatik HTTPS ile yapılandırır. Go, Node.js veya Docker gerekmez. Alan adı
da gerekmez — yoksa ücretsiz bir `sslip.io` adresine düşer ve yine gerçek bir sertifika alır, çünkü
tarayıcılar HTTPS olmadan mikrofonu ve ekran paylaşımını engeller.

İki mod, yedekleme, portlar ve yapılandırmayla birlikte: **[SELF-HOSTING.md](SELF-HOSTING.md)**.

---

## Nasıl çalışır

```
   BARINDIRILAN  (olağan yol)                 TAMAMEN KENDİ SUNUCUNUZDA

   mqvi.net ── hesaplar, arkadaşlar, DM'ler   sizin sunucunuz
        │                                     ├── hesaplar
        ├── sunucularınız ve kanallarınız     ├── kanallar ve mesajlar
        │                                     ├── ses — sizin SFU'nuz
        └── ses ── bizimki, ya da sizin       └── dosyalar
                   kendi SFU'nuz
```

mqvi.net'teki tek hesabınız kimliğinizi, arkadaşlarınızı ve üyeliklerinizi taşır; kullanmaya
başlamak için kurulacak bir şey yok. Kanalların ve sesin yaşadığı **sunucular** ise ya bizde ya
sizde barınır — ikisini karıştırabilirsiniz de.

---

## Karşılaştırma

Ağustos 2026'da kontrol edildi. Rakip daha iyiyse tablo bunu da yazıyor.

|  | mqvi | Discord | Matrix / Element | Stoat |
|---|---|---|---|---|
| Açık kaynak | ✓ AGPL-3.0 | ✗ | ✓ | ✓ AGPL-3.0 |
| Self-host edilebilir | ✓ | ✗ | ✓ | ✓ |
| Kendi sunucunu kurmak | tek komut | — | zahmetli | Docker Compose |
| Ses ve video E2EE | ✓ her çağrıda | ✓ her çağrıda | ✓ (Element Call) | ✗ planlanan |
| Mesaj E2EE | ✓ isteğe bağlı | ✗ | ✓ DM'lerde varsayılan | ✗ planlanan |
| Kayıt için telefon/kimlik | asla | sıklıkla | asla | asla |
| **Federasyon** | **✗ planlanan** | ✗ | **✓** | ✗ |
| **Bot ve üçüncü parti uygulamalar** | **✗ planlanan** | **✓ devasa ekosistem** | **✓** | — |
| **Bağımsız kripto denetimi** | **✗** | **✓** | **✓** | — |

Kalın satırlar mqvi'nin kaybettikleri, ve başka bir şey seçmek için dürüst sebepler:

- **Federasyon yok.** Matrix'in bütün varlık sebebi sunucuların birbiriyle konuşması. mqvi'ninkiler
  henüz konuşmuyor.
- **Bot veya uygulama ekosistemi yok.** Discord'unki devasa ve on yıllık. mqvi'de hiç yok.
- **Şifreleme bağımsız denetimden geçmedi.** Primitifler `@noble/curves`'ten geliyor ve o kütüphaneyi
  Cure53 ile Trail of Bits denetledi — ama bu projenin kendi X3DH, Double Ratchet ve Sender Key
  implementasyonunu dışarıdan kimse incelemedi. Discord'un DAVE protokolünü Trail of Bits denetledi;
  Matrix'in vodozemac'ı da denetlendi. Tehdit modeliniz ciddiyse bu fark önemlidir ve buna
  güvenmeden önce bilmeniz gerekir.

mqvi'nin diğerlerinde olmayanı: platformun **tamamının** gerçekten tek komutla kurulması, ve baştan
sona okuyabileceğiniz bir yığın üzerinde her zaman açık çağrı şifrelemesi.

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
| Yerel kod | GPU ekran yakalama için Rust + Media Foundation + Windows Graphics Capture |
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
disiplini. Alt sistem bazında daha derin notlar — tuhaf görünen kararların gerekçeleri dahil —
[`architecture/`](architecture/) altında.

---

## Katkı

Katkılar memnuniyetle karşılanır. Issue açmadan veya pull request göndermeden önce
[Katkı Rehberi](CONTRIBUTING.md)'ni, ilk değişikliğinizden önce de
[ARCHITECTURE.md](ARCHITECTURE.md)'yi okuyun. Güvenlik bildirimleri
[SECURITY.md](SECURITY.md) üzerinden yapılır, asla herkese açık bir issue ile değil.

---

## Lisans

[AGPL-3.0](LICENSE) — kurumunuz içinde dahil olmak üzere kullanmakta, değiştirmekte ve kendi
sunucunuzda çalıştırmakta özgürsünüz. Değiştirilmiş bir sürümü dağıtır ya da ağ üzerinden başkalarına
sunarsanız, kaynağınızı aynı lisansla yayınlamanız gerekir. Bu şartların dışındaki ticari kullanım
[ayrı bir lisans](COMMERCIAL-LICENSE.md) gerektirir. Katkı şartları [CLA.md](CLA.md)'de.
