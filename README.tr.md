<p align="center">
  <img src="icons/mqvi-icon-512x512.png" alt="mqvi" width="80" />
</p>

<h1 align="center">mqvi</h1>

<p align="center">
  Ses, video ve metin destekli acik kaynakli iletisim platformu.<br/>
  Kimlik dogrulama yok. Veri toplama yok. Self-host destegi.
</p>

<p align="center">
  <a href="https://github.com/akinalpfdn/Mqvi/releases/latest/download/mqvi-setup.exe"><img src="icons/btn-windows.svg" alt="Windows İndir" height="48" /></a>&nbsp;&nbsp;
  <a href="https://github.com/akinalpfdn/Mqvi/releases/latest/download/mqvi-setup.dmg"><img src="icons/btn-macos.svg" alt="macOS İndir" height="48" /></a>&nbsp;&nbsp;
  <a href="https://github.com/akinalpfdn/Mqvi/releases/latest/download/mqvi-setup.AppImage"><img src="icons/btn-linux.svg" alt="Linux İndir" height="48" /></a>
</p>

<p align="center">
  <a href="https://mqvi.net">Web Sitesi</a> &middot;
  <a href="#ozellikler">Ozellikler</a> &middot;
  <a href="#self-host-sadece-ses-sunucusu">Self-Host</a> &middot;
  <a href="#gelistirme">Gelistirme</a> &middot;
  <a href="#yol-haritasi">Yol Haritasi</a>
</p>

<p align="center">
  <a href="README.md">🇬🇧 English</a>
</p>

---

## Neden mqvi?

Populer iletisim platformlari kullanicilarindan giderek daha fazla resmi kimlik belgesi talep ediyor. Defalarca veri ihlali yasanmis platformlara pasaportunuzu veya kimliginizi guvenebilir misiniz?

**mqvi** basit bir ilke uzerine insa edildi: konusmalariniz sizden baska kimsenin olmamali.

- Telefon numarasi veya kimlik belgesi gerekmiyor
- Sifir veri toplama
- Tum kaynak kodu acik — guvenme, dogrula
- Tam kontrol icin kendi sunucunda barindir

---

## Ozellikler

### Iletisim
- **Metin Kanallari** — Dosya/gorsel paylasimi, yazma gostergesi ve mesaj duzenleme ile anlik mesajlasma
- **Ses & Video** — [LiveKit](https://livekit.io) SFU ile dusuk gecikmeli ses ve video
- **Ekran Paylasimi** — VP9 codec ve uyarlanabilir bitrate ile 1080p/30fps
- **Direkt Mesajlar** — Arkadas sistemi ile bire bir ozel konusmalar, tanimadigin kullanicilardan DM istegi kabul/red
- **Emoji Tepkileri** — Mesajlara emoji ile tepki ver
- **Soundboard** — Ses kanallarinda paylasilan ses kliplerini yukle ve oynat

### Gizlilik & Sifreleme
- **Uctan uca sesli sifreleme** — Her zaman acik. Sunucu tarafindan her oda icin uretilen parola ile LiveKit SFrame — ses ve video makinenden cikmadan once sifrelenir.
- **Opsiyonel mesaj E2EE'si** — DM bazinda veya sunucu bazinda ac. DM'ler icin Signal Protokolu (X3DH + Double Ratchet), kanallar icin Sender Key Protokolu.
- **Sifreli dosya paylasimi** — E2EE konusmalarinda AES-256-GCM dosya sifrelemesi.
- **Cihaz kimligi & anahtar kurtarma** — Cihaz basi kimlik anahtarlari ve cihazlar arasi geri yukleme icin kurtarma parolasi.

### Organizasyon
- **Coklu Sunucu** — Tek hesapla birden fazla sunucuya katil ve yonet (Discord tarzi)
- **Kanallar & Kategoriler** — Konusmalari metin ve ses kanallarina ayir
- **Roller & Izinler** — Kanal seviyesinde override'lar ile detayli izin sistemi
- **Davet Sistemi** — Davet kodlari ile sunucuya katilimi kontrol et
- **Mesaj Sabitleme** — Onemli mesajlari kanala sabitle
- **Tam Metin Arama** — Mesaj gecmisinde arama (FTS5 trigram tokenizer)

### Ses Ozellikleri
- **Bas-Konus & Ses Aktivitesi Algilama**
- **Kullanici Basi Ses Kontrolu** — Bireysel kullanici ses seviyelerini ayarla (%0–200)
- **Mikrofon Hassasiyeti** — Ayarlanabilir VAD esigi
- **Gurultu Bastirma** — LiveKit uzerinden dahili
- **Yerel WASAPI loopback capture** (Windows) — Echo'suz process-exclusive ekran paylasimi sesi
- **Giris/Cikis Sesleri**
- **AFK Otomatik Cikis** — Bosta kullanicilari ses kanalindan ayarlanabilir sure sonra at

### Kullanici Deneyimi
- **Masaustu Uygulamasi** — Windows, macOS ve Linux icin otomatik guncellemeli Electron uygulamasi
- **Frosted Glass Arayuz** — Ozel duvar kagitlari (hizli yeniden yukleme icin IndexedDB'de yerel olarak cache'lenir) ile modern seffaf arayuz
- **Durum Sistemi** — Cevrimici, bosta, rahatsiz etme, gorunmez durumu ve otomatik bosta algilama
- **Okunmamis Takibi** — Kanal basi okunmamis sayilari ve @bahsetme rozetleri
- **Klavye Kisayollari** — Fareye dokunmadan gezin
- **Sag Tik Menuleri** — Her yerde sag tik islemleri
- **Ozel Temalar** — Birden fazla renk temasi
- **Uygulama Ici Geri Bildirim** — Ekran goruntusu ekleyerek hata bildirimi ve ozellik onerisi gonder
- **Coklu Dil** — Turkce ve Ingilizce, daha fazla dil icin altyapi hazir

---

## Teknoloji

| Katman | Teknoloji |
|--------|-----------|
| Backend | Go (net/http + gorilla/websocket) |
| Frontend | React + TypeScript + Vite + Tailwind CSS |
| Masaustu | Electron (Windows, macOS, Linux) |
| State | Zustand |
| Ses/Video | LiveKit (self-hosted SFU), SFrame E2EE ile |
| Veritabani | SQLite (modernc.org/sqlite, saf Go), FTS5 trigram arama |
| Kimlik Dogrulama | JWT (access + refresh token) |
| E2EE | Signal Protokolu (X3DH + Double Ratchet), Sender Key, `@noble/curves` |

---

## Nasil Calisiyor?

```
                    mqvi.net (merkezi)
                    ├── Kullanici hesaplari
                    ├── Arkadas listeleri
                    ├── Sifreli DM'ler
                    └── Sunucu dizini
                         /          \
              ┌─────────┘            └──────────┐
              ▼                                  ▼
    Genel Barindirma                      Self-Hosted Sunucu
    (mqvi tarafindan yonetilir)           (senin altyapin)
    ├── Metin & ses kanallari             ├── Metin & ses kanallari
    ├── Mesajlar & dosyalar               ├── Mesajlar & dosyalar
    └── Roller & izinler                  └── Roller & izinler
```

Tum kullanicilarin **mqvi.net** uzerinde tek bir hesabi vardir. Hesabin, arkadaslarin, DM'lerin ve sunucu uyelikerin merkezi olarak tutulur. mqvi'yi kullanmaya baslamak icin ekstra alan adi veya kurulum gerekmez. (Projeyi forklayip her seyi kendi basina da yonetebilirsin — asagida [Tam Sunucu](#self-host-tam-sunucu) bolumune bak.)

**Sunucular** (kanallarin ve ses sohbetinin yasadigi yer) iki sekilde barindirabilir:

### Genel Barindirma
Uygulamadan dogrudan bir sunucu olustur. Altyapiyi biz yonetiyoruz — teknik bilgi gerekmez.

### Kendi Sunucunu Getir
Tam kontrol icin kendi ses/video sunucunu calistir. Asagidaki [Self-Host: Sadece Ses Sunucusu](#self-host-sadece-ses-sunucusu) bolumune bak.

---

## Self-Host: Sadece Ses Sunucusu

mqvi.net hesabini normal kullan — sunucu olustur, arkadas ekle, sohbet et. Tek fark: ses ve video trafigi bizim altyapimiz yerine **senin kendi LiveKit sunucundan** gecer. Konusmalarin bizim altyapimiza asla dokunmaz.

### Linux

Sunucuna SSH ile baglan ve calistir:

```bash
curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.sh | sudo bash
```

Script otomatik olarak:
1. LiveKit binary'sini indirir
2. Firewall portlarini acar (UFW / firewalld)
3. Guvenli API kimlik bilgileri uretir
4. `livekit.yaml` yapilandirma dosyasi olusturur
5. LiveKit'i systemd servisi olarak baslatir

**Gereksinimler:** Herhangi bir Linux sunucu (Ubuntu 22.04+ / Debian 12+ onerilir), 1 GB RAM, 1 CPU cekirdegi. Hetzner, DigitalOcean veya Contabo gibi saglayicilar aylik 3–5$'a sunar.

### Windows

**PowerShell'i Yonetici olarak** ac ve calistir:

```powershell
irm https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.ps1 | iex
```

Script otomatik olarak:
1. LiveKit binary'sini indirir
2. Windows Firewall portlarini acar
3. UPnP ile router port yonlendirmesi dener
4. Guvenli API kimlik bilgileri uretir
5. `livekit.yaml` yapilandirma dosyasi olusturur
6. LiveKit'i baslangicta otomatik calisacak sekilde ayarlar (Gorev Zamanlayici)

**Gereksinimler:** Windows 10/11. Kendi bilgisayarini kullaniyorsan, surekli acik ve internete bagli olmali.

### Kurulumdan Sonra

Script tamamlandiginda 3 deger goreceksin:

| Deger | Ornek |
|-------|-------|
| **URL** | `ws://203.0.113.10:7880` |
| **API Key** | `LiveKitKeyf3a1b2c4` |
| **API Secret** | `aBcDeFgHiJkLmNoPqRsTuVwXyZ012345` |

mqvi'ye git, yeni sunucu olustur, **"Self-Hosted"** sec ve bu 3 degeri gir. Bu kadar.

### Sorun Giderme

| Sorun | Cozum |
|-------|-------|
| Ses hic baglanmiyor | Portlar muhtemelen kapali. `sudo ufw status` (Linux) calistir veya Windows Firewall'u kontrol et. Bulut saglayicinin web firewall'unu da kontrol et. |
| Baglaniyorum ama ses gelmiyor | 50000–60000 UDP portlari engellenmiyor olabilir. Saglayicinin bu portlarda UDP trafikine izin verdiginden emin ol. |
| "Connection refused" hatasi | LiveKit calismıyor olabilir. `systemctl status livekit` (Linux) calistir veya Gorev Yoneticisi'nde `livekit-server` ara (Windows). |
| Yerel agda calisiyor ama disaridan calismiyor | `livekit.yaml` dosyanda `use_external_ip: true` ayarinin oldugundan emin ol. Windows'ta ayrica router'inin 7880, 7881, 7882 ve 50000–60000 portlarini yonlendirdiginden emin ol. |

---

## Self-Host: Tam Sunucu

mqvi platformunun tamamini kendi altyapinda calistir. mqvi.net'ten tamamen bagimsiz — her seyi sen kontrol edersin: hesaplar, mesajlar, dosyalar, ses.

### Gereksinimler

- Linux sunucu (Ubuntu 22.04+ / Debian 12+ onerilir), x86_64 veya arm64
- Minimum 2 vCPU, 4 GB RAM
- Alan adi opsiyonel — yoksa kurulum otomatik olarak ucretsiz `sslip.io` hostname'ine duser ve yine HTTPS calisir (tarayicilar duz HTTP'de ses/video'yu engeller).

### Tek Komutla Kurulum

Sunucuna SSH ile baglan ve calistir:

```bash
curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/install.sh | sudo bash
```

Script sana mqvi'nin nasil yayinlanacagini sorar:

1. **Kendi alan adinla HTTPS** (onerilir) — Caddy ve Let's Encrypt'i otomatik kurar.
2. **sslip.io ile HTTPS** — alan adi gerekmez. Public IP'nden `1-2-3-4.sslip.io` gibi bir hostname uretir ve buna gercek Let's Encrypt sertifikasi alir. Ses/video kutudan cikar cikmaz calisir.
3. **Sadece HTTP** — test amacli. Tarayici mikrofon, kamera ve ekran paylasimini engeller.

Interaktif olmayan kurulum istiyorsan flag'lerle:

```bash
# Kendi alan adin, ozel internal port
sudo bash install.sh --domain demo.example.com --port 9092 -y

# sslip.io ile her sey default
sudo bash install.sh -y

# Sunucunda zaten Caddy var ve baska siteleri sunuyor — script bunu otomatik
# algilar, kendi Caddy'sini kurmaz, yapistirmak icin Caddyfile snippet'i basar
sudo bash install.sh --domain demo.example.com --port 9092 -y

# Ozel portta sadece HTTP
sudo bash install.sh --no-tls --port 8080 -y
```

Script ne yapar:

1. `mqvi` adinda ozel bir sistem kullanicisi ve `/opt/mqvi` dizini olusturur
2. Mimarin icin hazir `mqvi-server` binary'sini indirir (~40 MB, frontend + migration'lar + i18n hepsi gomulu — Go, Node.js veya Docker gerekmez)
3. LiveKit SFU binary'sini indirir
4. Rastgele sirlarla `.env` ve `livekit.yaml` uretir
5. Her iki servis icin systemd unit'lerini sertlestirilmis ayarlarla kurar (`ProtectSystem=strict`, `NoNewPrivileges`, ozel kullanici)
6. (TLS modlarinda) Caddy'i kurar ve yapilandirir, ya da Caddy zaten varsa dokunmaz ve snippet basar
7. Firewall portlarini acar (UFW / firewalld varsa)
8. Her seyi baslatir, acilista otomatik calisacak sekilde ayarlar

Scripti tekrar calistirmak guvenli — mevcut `.env` ve `livekit.yaml` korunur, sirlarin degismez. Flag'ler mevcut `.env`'i ezmez.

Kurulum bittiginde script public URL'i basar — `https://alanadin` veya `https://1-2-3-4.sslip.io`. Kayit olan ilk kullanici sunucu sahibi olur.

### Servisleri yonetmek

```bash
# Loglar
journalctl -u mqvi-server -f
journalctl -u mqvi-livekit -f

# Yeniden baslat / durdur
systemctl restart mqvi-server
systemctl stop mqvi-server mqvi-livekit

# Yeni bir surume guncelle
curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/install.sh | sudo bash
systemctl restart mqvi-server
```

Verilerin `/opt/mqvi/data/` altinda tutulur (SQLite veritabani + yuklenen dosyalar). Yedegini al.

### Manuel Caddy snippet (existing-Caddy modu)

Sunucunda baska siteler icin zaten Caddy calisiyorsa, kurulum bunu algilar ve kendi kopyasini kurmaz. Script ciktisinda asagidaki gibi bir snippet gorursun — `Caddyfile`'ina yapistir:

```
demo.example.com {
    reverse_proxy 127.0.0.1:9092
    encode zstd gzip
    request_body {
        max_size 30MB
    }
}
```

Sonra `sudo systemctl reload caddy`.

### Firewall portlari

Install scripti UFW veya firewalld aktifse bunlari otomatik acar. Bulut saglayici firewall'u kullaniyorsan (AWS Security Group, Hetzner Cloud Firewall gibi), orada da ac:

| Port | Protokol | Amac |
|------|----------|------|
| `80` | TCP | HTTP (Let's Encrypt challenge, HTTPS yonlendirme) — sadece TLS modlarinda |
| `443` | TCP | HTTPS — sadece TLS modlarinda |
| `<--port degerin>` | TCP | Web Arayuzu + API — yalnizca `--no-tls` modunda public; TLS modlarinda Caddy arkasinda localhost-only |
| `7880` | TCP | LiveKit sinyal |
| `7881` | TCP | LiveKit TURN aktarma |
| `7882` | UDP | LiveKit medya |
| `50000–50200` | UDP | LiveKit ICE adaylari |

### Ortam degiskenleri

Install scripti makul varsayilanlar uretir. Degistirmek istersen `/opt/mqvi/.env` dosyasini duzenle ve `systemctl restart mqvi-server`. Tum secenekler icin [`.env.example`](deploy/.env.example) dosyasina bak:

| Degisken | Varsayilan | Aciklama |
|----------|-----------|----------|
| `SERVER_HOST` | `127.0.0.1` (TLS) / `0.0.0.0` (TLS yok) | Bind adresi — Caddy on tarafsa localhost, degilse public |
| `SERVER_PORT` | `9090` | Internal HTTP portu (kurulumda `--port` ile degistirilebilir) |
| `CORS_ORIGINS` | *uretilir* | Public URL'ine otomatik atanir (`https://alanadin` veya `https://<ip>.sslip.io`) |
| `JWT_SECRET` | *uretilir* | Token imzalama icin rastgele string |
| `ENCRYPTION_KEY` | *uretilir* | Saklanan LiveKit kimlik bilgilerini sifrelemek icin AES-256 anahtar |
| `DATABASE_PATH` | `/opt/mqvi/data/mqvi.db` | SQLite veritabani yolu |
| `UPLOAD_DIR` | `/opt/mqvi/data/uploads` | Dosya yukleme dizini |
| `UPLOAD_MAX_SIZE` | `26214400` | Maksimum yukleme boyutu (25 MB) |
| `LIVEKIT_URL` | `ws://127.0.0.1:7880` | Otomatik olusturulan yerel LiveKit instance |
| `LIVEKIT_API_KEY` | *uretilir* | `livekit.yaml` ile eslesir |
| `LIVEKIT_API_SECRET` | *uretilir* | `livekit.yaml` ile eslesir |

---

## Gelistirme

### Onkokullar

- Go 1.22+
- Node.js 22+
- npm
- LiveKit Server (ses/video icin — asagiya bak)

### Kurulum

```bash
# Klonla
git clone https://github.com/akinalpfdn/Mqvi.git
cd Mqvi

# Backend
cd server
cp ../deploy/.env.example .env   # .env dosyasini kopyala ve duzenle (JWT_SECRET, ENCRYPTION_KEY ayarla)
go mod download
go run .

# Frontend (ayri terminal)
cd client
npm install
npm run dev
```

Vite dev sunucusu `/api` ve `/ws` isteklerini `localhost:9090`'a yonlendirir.

### LiveKit (Ses/Video)

Ses ve video icin calisan bir [LiveKit](https://livekit.io) sunucusu gerekir. LiveKit olmadan metin sohbeti calisiyor ama ses kanallarina baglanamezsiniz.

```bash
# Hizli kurulum — projenin scriptini kullan:
# Linux:
sudo bash deploy/livekit-setup.sh
# Windows (Yonetici olarak PowerShell):
irm https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.ps1 | iex

# Veya manuel kur: https://docs.livekit.io/home/self-hosting/local/
livekit-server --config deploy/livekit.yaml --dev
```

`.env` dosyandaki `LIVEKIT_URL`, `LIVEKIT_API_KEY` ve `LIVEKIT_API_SECRET` degerlerini LiveKit yapilandirmana gore ayarla.

### Kaynaktan Derleme

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File deploy\build.ps1
```

**Linux / macOS:**
```bash
# Frontend
cd client && npm install && npm run build && cd ..

# Frontend'i sunucuya kopyala (gomme icin)
rm -rf server/static/dist && cp -r client/dist server/static/dist

# Backend (gomulu frontend ile tek binary)
cd server
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ../deploy/package/mqvi-server .
cd ..
```

### Proje Yapisi

```
mqvi/
├── server/               # Go backend
│   ├── main.go           # Giris noktasi + baglanti
│   ├── config/           # Ortam tabanli yapilandirma
│   ├── models/           # Alan struct'lari
│   ├── repository/       # Veri erisimi (ham SQL)
│   ├── services/         # Is mantigi
│   ├── handlers/         # HTTP/WS istek isleme
│   ├── middleware/        # Auth, izinler, rate limiting
│   ├── ws/               # WebSocket hub + olaylar
│   ├── database/         # SQLite + gomulu migration'lar
│   ├── static/           # Gomulu frontend (derlemede doldurulur)
│   └── pkg/              # Paylasilan araclar
│       ├── i18n/         # Backend i18n + gomulu ceviriler
│       └── crypto/       # AES-256-GCM sifreleme
├── client/               # React frontend
│   └── src/
│       ├── api/          # API istemci fonksiyonlari
│       ├── stores/       # Zustand durum yonetimi
│       ├── hooks/        # Ozel React hook'lar
│       ├── components/   # UI bileşenleri
│       ├── styles/       # Tema + genel stiller
│       ├── i18n/         # Frontend cevirileri (EN + TR)
│       └── types/        # TypeScript tipleri
├── electron/             # Electron masaustu sarmalayici
│   ├── main.ts           # Ana islem
│   └── preload.ts        # Onyukleme scripti (guvenli IPC)
├── deploy/               # Derleme & dagitim scriptleri
│   ├── build.ps1         # Windows derleme scripti
│   ├── start.sh          # Sunucu baslama scripti
│   ├── livekit-setup.sh  # LiveKit otomatik kurulum (Linux)
│   ├── livekit-setup.ps1 # LiveKit otomatik kurulum (Windows)
│   ├── livekit.yaml      # LiveKit yapilandirma sablonu
│   └── .env.example      # Ortam yapilandirma sablonu
└── docker-compose.yml    # Docker gelistirme ortami
```

### Mimari

```
handlers/ → services/ → repository/ → SQLite
    ↕            ↕
middleware    ws/hub (WebSocket broadcast)
```

- **Katmanli mimari**: handler'lar HTTP'yi parse eder, servisler is mantigi icerir, repository'ler veri erisimini yonetir
- **Constructor dependency injection**: global state yok, tum bagimliliklar constructor uzerinden enjekte edilir
- **Interface segregation**: tuketiciler concrete tiplere degil minimal interface'lere bagimlidir
- **WebSocket hub**: anlik olay yayinlama icin fan-out deseni

---

## Yol Haritasi

### Tamamlandi
- Anlik mesajlasma ile metin kanallari
- Her zaman acik SFrame E2EE ile ses & goruntulu gorusmeler (LiveKit)
- Windows'ta yerel WASAPI loopback capture ile ekran paylasimi (1080p/30fps)
- Kanal bazli override'lar ile rol & izin sistemi
- Emoji tepkileri & soundboard
- Direkt mesajlar, arkadas sistemi, DM istekleri
- Mesaj sabitleme & tam metin arama (FTS5 trigram)
- Davet sistemi
- Durum, otomatik bosta algilama, AFK otomatik cikis
- Klavye kisayollari & sag tik menuleri
- Ozel temalar, duvar kagitlari, frosted glass arayuz
- Coklu dil destegi (EN + TR)
- Windows, macOS ve Linux icin masaustu uygulamasi (Electron, otomatik guncelleme)
- Coklu sunucu mimarisi
- Tek komutla self-host kurulumu (tam sunucu)
- Uctan uca sifreleme: DM (Signal Protokolu), kanal (Sender Key), ses (SFrame), dosya sifreleme, anahtar yedekleme & kurtarma
- Ekran goruntulu uygulama ici geri bildirim

### Planlanan
- Mobil uygulamalar (iOS & Android)
- Plugin / bot API
- Sunucular arasi federasyon

---

## Katkida Bulunma

Katkilar memnuniyetle karsilanir! Issue acmadan veya PR gondermeden once [Katki Kilavuzu](CONTRIBUTING.md)'nu okumanizi rica ederiz.

---

## Lisans

[AGPL-3.0](LICENSE) — kisisel ve ticari olmayan kullanim serbesttir. Ticari kullanim icin [ayri bir lisans](COMMERCIAL-LICENSE.md) gereklidir. Katki sartlari icin [CLA.md](CLA.md) dosyasina bakin.
