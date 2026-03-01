<p align="center">
  <img src="icons/mqvi-icon-512x512.png" alt="mqvi" width="80" />
</p>

<h1 align="center">mqvi</h1>

<p align="center">
  Ses, video ve metin destekli acik kaynakli iletisim platformu.<br/>
  Kimlik dogrulama yok. Veri toplama yok. Self-host destegi.
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
- **Direkt Mesajlar** — Arkadas sistemi ile bire bir ozel konusmalar
- **Emoji Tepkileri** — Mesajlara emoji ile tepki ver

### Organizasyon
- **Coklu Sunucu** — Tek hesapla birden fazla sunucuya katil ve yonet (Discord tarzi)
- **Kanallar & Kategoriler** — Konusmalari metin ve ses kanallarina ayir
- **Roller & Izinler** — Kanal seviyesinde override'lar ile detayli izin sistemi
- **Davet Sistemi** — Davet kodlari ile sunucuya katilimi kontrol et
- **Mesaj Sabitleme** — Onemli mesajlari kanala sabitle
- **Tam Metin Arama** — Mesaj gecmisinde arama (FTS5)

### Ses Ozellikleri
- **Bas-Konus & Ses Aktivitesi Algilama**
- **Kullanici Basi Ses Kontrolu** — Bireysel kullanici ses seviyelerini ayarla (%0–200)
- **Mikrofon Hassasiyeti** — Ayarlanabilir VAD esigi
- **Gurultu Bastirma** — LiveKit uzerinden dahili
- **Giris/Cikis Sesleri**

### Kullanici Deneyimi
- **Masaustu Uygulamasi** — Otomatik guncelleme ile Electron uygulamasi
- **Durum Sistemi** — Cevrimici, bosta, rahatsiz etme durumu ve otomatik bosta algilama
- **Okunmamis Takibi** — Kanal basi okunmamis mesaj sayilari ve @bahsetme rozetleri
- **Klavye Kisayollari** — Fareye dokunmadan gezin
- **Sag Tik Menuleri** — Her yerde sag tik islemleri
- **Ozel Temalar** — Birden fazla renk temasi
- **Coklu Dil** — Turkce ve Ingilizce, daha fazla dil icin altyapi hazir

---

## Teknoloji

| Katman | Teknoloji |
|--------|-----------|
| Backend | Go (net/http + gorilla/websocket) |
| Frontend | React + TypeScript + Vite + Tailwind CSS |
| Masaustu | Electron |
| State | Zustand |
| Ses/Video | LiveKit (self-hosted SFU) |
| Veritabani | SQLite (modernc.org/sqlite, saf Go) |
| Kimlik Dogrulama | JWT (access + refresh token) |

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

- Linux sunucu (Ubuntu 22.04+ onerilir)
- Minimum 2 vCPU, 4 GB RAM
- Alan adi (opsiyonel — IP adresi de calisiyor)

### Hizli Baslangic

```bash
mkdir -p ~/mqvi && cd ~/mqvi

# En son surumu indir
curl -fsSL https://github.com/akinalpfdn/Mqvi/releases/latest/download/mqvi-server -o mqvi-server
curl -fsSL https://github.com/akinalpfdn/Mqvi/releases/latest/download/start.sh -o start.sh
curl -fsSL https://github.com/akinalpfdn/Mqvi/releases/latest/download/livekit.yaml -o livekit.yaml
curl -fsSL https://github.com/akinalpfdn/Mqvi/releases/latest/download/.env.example -o .env

chmod +x mqvi-server start.sh
```

`mqvi-server` binary'si (~40 MB) frontend, veritabani migration'lari ve i18n dosyalarinin tumunu iceren tek bir calistirilabilir dosyadir. Go, Node.js veya baska bir runtime gerekmez.

### Yapilandirma

`.env` dosyasini duzenle ve en az bu 3 sirri ayarla:

```bash
nano .env
```

| Degisken | Nasil uretilir |
|----------|----------------|
| `JWT_SECRET` | `openssl rand -hex 32` |
| `LIVEKIT_API_SECRET` | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` |

`.env` dosyasindaki `LIVEKIT_API_SECRET` degerinin `livekit.yaml` dosyasindaki `keys.devkey` degeri ile eslestiginden emin ol.

### Baslat

```bash
./start.sh
```

`start.sh` LiveKit binary'sini otomatik indirir (yoksa), veri dizinlerini olusturur ve hem LiveKit hem mqvi'yi baslatir. Arka planda calistirmak icin:

```bash
nohup ./start.sh > output.log 2>&1 &
```

Tarayicinda `http://SUNUCU_IP:9090` adresini ac. Kayit olan ilk kullanici sunucu sahibi olur.

### Caddy ile SSL (opsiyonel)

```bash
apt install caddy
```

`/etc/caddy/Caddyfile` dosyasina ekle:

```
alanadın.com {
    reverse_proxy localhost:9090
}

lk.alanadın.com {
    reverse_proxy localhost:7880
}
```

```bash
systemctl restart caddy
```

Caddy, Let's Encrypt uzerinden SSL sertifikalari otomatik alir ve yeniler. `.env` dosyasindaki `LIVEKIT_URL` degerini `wss://lk.alanadın.com` olarak guncelle.

### Firewall

Bu portlarin acik oldugundan emin ol:

| Port | Protokol | Amac |
|------|----------|------|
| `9090` | TCP | Web Arayuzu + API |
| `7880` | TCP | LiveKit sinyal |
| `7881` | TCP | LiveKit TURN aktarma |
| `7882` | UDP | LiveKit medya |
| `50000–60000` | UDP | LiveKit ICE adaylari |

### Ortam Degiskenleri

Tum secenekler icin [`.env.example`](deploy/.env.example) dosyasina bak. Onemli ayarlar:

| Degisken | Varsayilan | Aciklama |
|----------|-----------|----------|
| `SERVER_PORT` | `9090` | HTTP portu |
| `JWT_SECRET` | — | **Zorunlu.** Token imzalama icin rastgele string |
| `LIVEKIT_URL` | `ws://localhost:7880` | LiveKit sunucu URL'i (Caddy ile `wss://` kullan) |
| `LIVEKIT_API_KEY` | `devkey` | LiveKit API anahtari (livekit.yaml ile eslesmeli) |
| `LIVEKIT_API_SECRET` | — | **Zorunlu.** livekit.yaml ile eslesmeli |
| `ENCRYPTION_KEY` | — | **Zorunlu.** Saklanan kimlik bilgilerini sifrelemek icin AES-256 anahtar |
| `DATABASE_PATH` | `./data/mqvi.db` | SQLite veritabani yolu |
| `UPLOAD_DIR` | `./data/uploads` | Dosya yukleme dizini |
| `UPLOAD_MAX_SIZE` | `26214400` | Maksimum yukleme boyutu (25 MB) |

---

## Gelistirme

### Onkokullar

- Go 1.21+
- Node.js 20+
- npm

### Kurulum

```bash
# Klonla
git clone https://github.com/akinalpfdn/Mqvi.git
cd Mqvi

# Backend
cd server
go mod download
go run .

# Frontend (ayri terminal)
cd client
npm install
npm run dev
```

Vite dev sunucusu `/api` ve `/ws` isteklerini `localhost:9090`'a yonlendirir.

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
- Ses & goruntulu gorusmeler (LiveKit)
- Ekran paylasimi (1080p/30fps)
- Kanal override'lari ile rol & izin sistemi
- Emoji tepkileri
- Direkt mesajlar & arkadas sistemi
- Mesaj sabitleme & arama
- Davet sistemi
- Durum & otomatik bosta algilama
- Klavye kisayollari
- Ozel temalar
- Coklu dil destegi (EN + TR)
- Masaustu uygulamasi (Electron, otomatik guncelleme)
- Coklu sunucu mimarisi
- Tek tikla self-host kurulumu (LiveKit)

### Planlanan
- Uctan uca sifreleme (E2EE)
- Mobil uygulamalar (iOS & Android)
- Plugin / bot API
- Sunucular arasi federasyon
- Sifreli dosya paylasimi

---

## Katkida Bulunma

Katkilar memnuniyetle karsilanir! Lutfen PR gondermeden once degisikliginizi tartismak icin bir issue acin.

---

## Lisans

[MIT](LICENSE) — istediginiz gibi kullanin.
