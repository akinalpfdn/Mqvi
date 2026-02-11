# 🚀 mqvi — Open Source Discord Alternatifi Geliştirme Planı

> Self-hosted, P2P ruhlu, Discord kalitesinde sesli/görüntülü iletişim platformu.
> Hedef: Herkesin kendi sunucusunda kurup arkadaşlarıyla kullanabileceği, açık kaynak bir uygulama.

---

## Teknoloji Kararları

### Neden Bu Stack?

| Katman | Teknoloji | Gerekçe |
|--------|-----------|---------|
| **Backend** | **Go (Golang)** | Concurrent bağlantılar için ideal, düşük bellek, tek binary deploy, LiveKit da Go ile yazılmış |
| **Frontend** | **React + TypeScript** | Geniş ekosistem, component bazlı UI, Discord benzeri layout için en uygun |
| **Desktop** | **Tauri v2** | Electron'dan 10x hafif (~15MB vs 150MB+), Rust tabanlı, native hissiyat |
| **Realtime Chat** | **WebSocket (Gorilla/nhooyr)** | Go'nun en güçlü yanı, binlerce eşzamanlı bağlantı |
| **Voice/Video** | **LiveKit (self-hosted)** | Open source SFU, 1080p/30fps screen share, adaptive bitrate, SDK'ları hazır |
| **Database** | **SQLite + Turso** | Sıfır konfigürasyon, tek dosya, self-host için ideal, gerekirse Turso ile edge |
| **Auth** | **JWT + Davet Kodu sistemi** | Basit, server-owner kontrollü, public registration yok |
| **File Storage** | **Local disk + S3 uyumlu (opsiyonel)** | Basit başla, MinIO ile ölçekle |

### Neden Electron Değil Tauri?

- Tauri v2 binary: ~15MB (Electron: 150MB+)
- RAM kullanımı: ~50MB (Electron: 300MB+)
- Native OS entegrasyonu daha iyi
- Rust backend ile system tray, auto-update, notifications hazır
- Open source proje için kullanıcıların indirmesi/kurması çok daha kolay
- React frontend'i aynen kullanıyorsun, sadece wrapper değişiyor

---

## Mimari Genel Bakış

```
┌─────────────────────────────────────────────────────┐
│                    Tauri Desktop App                  │
│  ┌───────────────────────────────────────────────┐   │
│  │              React + TypeScript UI              │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐   │   │
│  │  │ Chat     │ │ Voice    │ │ Screen Share │   │   │
│  │  │ Panels   │ │ Controls │ │ Viewer       │   │   │
│  │  └────┬─────┘ └────┬─────┘ └──────┬───────┘   │   │
│  │       │             │              │            │   │
│  │  WebSocket     LiveKit SDK    LiveKit SDK      │   │
│  └───────┼─────────────┼──────────────┼───────────┘   │
└──────────┼─────────────┼──────────────┼───────────────┘
           │             │              │
           ▼             ▼              ▼
┌──────────────────┐  ┌─────────────────────┐
│   Go API Server  │  │  LiveKit Server     │
│                  │  │  (SFU)              │
│  • REST API      │  │  • Voice rooms      │
│  • WebSocket hub │  │  • Screen share     │
│  • Auth (JWT)    │  │  • 1080p/30fps      │
│  • Permissions   │  │  • Adaptive bitrate │
│  • File upload   │  │  • Simulcast        │
│                  │  │                     │
│  SQLite DB       │  └─────────────────────┘
└──────────────────┘

Deployment: Tek sunucuda Docker Compose ile her şey ayağa kalkar
```

---

## Özellik Listesi (Scope)

### ✅ MVP'de Olacak (v1.0)
- [ ] Sunucu oluşturma ve davet kodu ile katılma
- [ ] Birden fazla text channel (oluştur, sil, düzenle)
- [ ] Birden fazla voice channel (oluştur, sil, düzenle)
- [ ] Gerçek zamanlı text chat (mesaj gönderme, düzenleme, silme)
- [ ] Dosya/resim paylaşımı (chat içinde)
- [ ] Voice chat (mute, deafen, ses seviyesi ayarı, kullanıcı bazlı volume)
- [ ] Screen share 1080p/30fps (aynı anda 2 yayın izlenebilir)
- [ ] Kullanıcı rolleri ve yetkileri (Admin, Moderator, Member)
- [ ] Kanal bazlı izinler (kim yazabilir, kim girebilir)
- [ ] Kullanıcı profili (avatar, kullanıcı adı, durum)
- [ ] Online/offline/idle durum göstergesi
- [ ] Bildirimler (mention, DM)
- [ ] Sistem tray'de çalışma
- [ ] Push to talk + voice activity detection
- [ ] Discord benzeri UI/UX

### 🔮 v1.1+ (Post-MVP)
- DM (direkt mesaj)
- Emoji reactions
- Mesaj pinleme
- Arama (mesaj geçmişinde)
- Tema desteği (dark/light + custom)
- Ses efektleri (giriş/çıkış sesleri)
- Bot/webhook API
- Mobil uygulama (React Native ile aynı backend)

---

## Veritabanı Şeması

```sql
-- Sunucu (her deployment bir sunucu)
CREATE TABLE server (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    name TEXT NOT NULL,
    icon_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Kullanıcılar
CREATE TABLE users (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    username TEXT NOT NULL UNIQUE,
    display_name TEXT,
    avatar_url TEXT,
    password_hash TEXT NOT NULL,
    status TEXT DEFAULT 'offline', -- online, idle, dnd, offline
    custom_status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Roller
CREATE TABLE roles (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    name TEXT NOT NULL,
    color TEXT DEFAULT '#99AAB5',
    position INTEGER NOT NULL DEFAULT 0,
    -- Permissions (bitfield)
    permissions INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Varsayılan roller: admin (tüm yetkiler), moderator, member
-- Permission bits:
--   1  = MANAGE_CHANNELS
--   2  = MANAGE_ROLES
--   4  = KICK_MEMBERS
--   8  = BAN_MEMBERS
--   16 = MANAGE_MESSAGES
--   32 = SEND_MESSAGES
--   64 = CONNECT_VOICE
--   128 = SPEAK
--   256 = STREAM (screen share)
--   512 = ADMIN (tüm yetkiler)

-- Kullanıcı-Rol ilişkisi
CREATE TABLE user_roles (
    user_id TEXT REFERENCES users(id),
    role_id TEXT REFERENCES roles(id),
    PRIMARY KEY (user_id, role_id)
);

-- Kategoriler (channel grouping)
CREATE TABLE categories (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);

-- Kanallar
CREATE TABLE channels (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('text', 'voice')),
    category_id TEXT REFERENCES categories(id),
    topic TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    user_limit INTEGER DEFAULT 0, -- 0 = unlimited (voice only)
    bitrate INTEGER DEFAULT 64000, -- voice only
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Kanal bazlı yetki override
CREATE TABLE channel_permissions (
    channel_id TEXT REFERENCES channels(id),
    role_id TEXT REFERENCES roles(id),
    allow INTEGER NOT NULL DEFAULT 0,
    deny INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, role_id)
);

-- Mesajlar
CREATE TABLE messages (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    channel_id TEXT REFERENCES channels(id) NOT NULL,
    user_id TEXT REFERENCES users(id) NOT NULL,
    content TEXT,
    edited_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Dosya ekleri
CREATE TABLE attachments (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    message_id TEXT REFERENCES messages(id) NOT NULL,
    filename TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Davet kodları
CREATE TABLE invites (
    code TEXT PRIMARY KEY,
    created_by TEXT REFERENCES users(id),
    max_uses INTEGER DEFAULT 0, -- 0 = unlimited
    uses INTEGER DEFAULT 0,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Oturum takibi (JWT refresh)
CREATE TABLE sessions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    user_id TEXT REFERENCES users(id) NOT NULL,
    refresh_token TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_messages_channel ON messages(channel_id, created_at DESC);
CREATE INDEX idx_user_roles_user ON user_roles(user_id);
CREATE INDEX idx_channels_category ON channels(category_id, position);
```

---

## API Tasarımı

### REST Endpoints

```
Auth:
  POST   /api/auth/register          — Kayıt (ilk kullanıcı otomatik admin)
  POST   /api/auth/login              — Giriş → JWT access + refresh token
  POST   /api/auth/refresh            — Token yenileme
  POST   /api/auth/logout             — Çıkış

Server:
  GET    /api/server                  — Sunucu bilgisi
  PATCH  /api/server                  — Sunucu güncelle (admin)

Channels:
  GET    /api/channels                — Tüm kanallar (kategorilerle)
  POST   /api/channels                — Kanal oluştur
  PATCH  /api/channels/:id            — Kanal düzenle
  DELETE /api/channels/:id            — Kanal sil

Categories:
  GET    /api/categories              — Tüm kategoriler
  POST   /api/categories              — Kategori oluştur
  PATCH  /api/categories/:id          — Kategori düzenle
  DELETE /api/categories/:id          — Kategori sil

Messages:
  GET    /api/channels/:id/messages   — Mesajlar (pagination: ?before=id&limit=50)
  POST   /api/channels/:id/messages   — Mesaj gönder
  PATCH  /api/messages/:id            — Mesaj düzenle
  DELETE /api/messages/:id            — Mesaj sil

Users:
  GET    /api/users                   — Tüm kullanıcılar
  GET    /api/users/me                — Kendi profilim
  PATCH  /api/users/me                — Profil güncelle
  POST   /api/users/me/avatar         — Avatar yükle

Roles:
  GET    /api/roles                   — Tüm roller
  POST   /api/roles                   — Rol oluştur (admin)
  PATCH  /api/roles/:id               — Rol düzenle (admin)
  DELETE /api/roles/:id               — Rol sil (admin)
  PUT    /api/users/:id/roles         — Kullanıcıya rol ata (admin/mod)

Invites:
  POST   /api/invites                 — Davet kodu oluştur
  GET    /api/invites                 — Aktif davetler
  DELETE /api/invites/:code           — Davet iptal
  POST   /api/invites/:code/join      — Davet ile katıl

Voice (LiveKit entegrasyonu):
  POST   /api/voice/token             — LiveKit bağlantı token'ı al
  GET    /api/voice/participants/:channelId — Kanalda kimler var

Files:
  POST   /api/upload                  — Dosya yükle (max 25MB)
```

### WebSocket Events

```
Bağlantı: ws://server/ws?token=JWT_TOKEN

── Client → Server ──
{ op: "heartbeat" }
{ op: "typing", d: { channel_id: "..." } }
{ op: "presence_update", d: { status: "online" | "idle" | "dnd" } }

── Server → Client ──
{ op: "ready", d: { user, channels, members, roles } }
{ op: "message_create", d: { message } }
{ op: "message_update", d: { message } }
{ op: "message_delete", d: { id, channel_id } }
{ op: "channel_create", d: { channel } }
{ op: "channel_update", d: { channel } }
{ op: "channel_delete", d: { id } }
{ op: "member_join", d: { user } }
{ op: "member_leave", d: { user_id } }
{ op: "presence_update", d: { user_id, status } }
{ op: "typing_start", d: { user_id, channel_id } }
{ op: "voice_state_update", d: { user_id, channel_id, muted, deafened } }
{ op: "voice_stream_start", d: { user_id, channel_id, stream_type } }
{ op: "voice_stream_end", d: { user_id, channel_id } }
```

---

## Klasör Yapısı

```
mqvi/
├── docker-compose.yml          # Tek komutla her şeyi ayağa kaldır
├── README.md                   # Kurulum rehberi
├── LICENSE                     # MIT
│
├── server/                     # Go Backend
│   ├── main.go
│   ├── go.mod
│   ├── go.sum
│   ├── config/
│   │   └── config.go           # Env-based konfigürasyon
│   ├── database/
│   │   ├── database.go         # SQLite bağlantı + migration
│   │   └── migrations/         # SQL migration dosyaları
│   ├── models/
│   │   ├── user.go
│   │   ├── channel.go
│   │   ├── message.go
│   │   ├── role.go
│   │   └── invite.go
│   ├── handlers/
│   │   ├── auth.go
│   │   ├── channels.go
│   │   ├── messages.go
│   │   ├── users.go
│   │   ├── roles.go
│   │   ├── invites.go
│   │   ├── voice.go
│   │   └── upload.go
│   ├── middleware/
│   │   ├── auth.go             # JWT validation
│   │   └── permissions.go      # Role/permission check
│   ├── ws/
│   │   ├── hub.go              # WebSocket connection manager
│   │   ├── client.go           # Per-connection handler
│   │   └── events.go           # Event types + dispatching
│   └── services/
│       ├── livekit.go          # LiveKit token generation
│       └── storage.go          # File storage abstraction
│
├── client/                     # React + TypeScript Frontend
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── api/
│   │   │   ├── client.ts       # Axios/fetch wrapper
│   │   │   ├── auth.ts
│   │   │   ├── channels.ts
│   │   │   ├── messages.ts
│   │   │   └── voice.ts
│   │   ├── stores/             # Zustand state management
│   │   │   ├── authStore.ts
│   │   │   ├── channelStore.ts
│   │   │   ├── messageStore.ts
│   │   │   ├── voiceStore.ts
│   │   │   └── uiStore.ts
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts
│   │   │   ├── useVoice.ts
│   │   │   └── usePermissions.ts
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   │   ├── AppLayout.tsx        # Ana layout (3 panel)
│   │   │   │   ├── Sidebar.tsx          # Sol: kanal listesi
│   │   │   │   ├── ChatArea.tsx         # Orta: mesajlar
│   │   │   │   └── MemberList.tsx       # Sağ: üye listesi
│   │   │   ├── channels/
│   │   │   │   ├── ChannelList.tsx
│   │   │   │   ├── ChannelItem.tsx
│   │   │   │   ├── VoiceChannel.tsx
│   │   │   │   └── CreateChannelModal.tsx
│   │   │   ├── chat/
│   │   │   │   ├── MessageList.tsx
│   │   │   │   ├── Message.tsx
│   │   │   │   ├── MessageInput.tsx
│   │   │   │   ├── FileUpload.tsx
│   │   │   │   └── TypingIndicator.tsx
│   │   │   ├── voice/
│   │   │   │   ├── VoicePanel.tsx       # Alt bar: bağlı kanal info
│   │   │   │   ├── VoiceControls.tsx    # Mute, deafen, disconnect
│   │   │   │   ├── ScreenShare.tsx      # Yayın başlat/durdur
│   │   │   │   └── StreamViewer.tsx     # Yayın izleme (2 eşzamanlı)
│   │   │   ├── members/
│   │   │   │   ├── MemberList.tsx
│   │   │   │   ├── MemberItem.tsx
│   │   │   │   └── UserPopover.tsx
│   │   │   ├── auth/
│   │   │   │   ├── LoginPage.tsx
│   │   │   │   ├── RegisterPage.tsx
│   │   │   │   └── InvitePage.tsx
│   │   │   ├── settings/
│   │   │   │   ├── ServerSettings.tsx
│   │   │   │   ├── RoleManager.tsx
│   │   │   │   ├── UserSettings.tsx
│   │   │   │   └── VoiceSettings.tsx
│   │   │   └── shared/
│   │   │       ├── Avatar.tsx
│   │   │       ├── Modal.tsx
│   │   │       ├── Tooltip.tsx
│   │   │       └── ContextMenu.tsx
│   │   ├── styles/
│   │   │   ├── globals.css
│   │   │   └── theme.ts         # Discord renk paleti
│   │   └── utils/
│   │       ├── permissions.ts
│   │       ├── formatters.ts
│   │       └── constants.ts
│   └── public/
│       └── sounds/              # Join/leave/notification sesleri
│
├── src-tauri/                   # Tauri v2 (Desktop wrapper)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs               # System tray, auto-update, deep links
│   └── icons/
│
└── docs/
    ├── SETUP.md                 # Detaylı kurulum rehberi
    ├── SELF-HOST.md             # VPS'e deploy rehberi
    ├── CONTRIBUTING.md
    └── API.md                   # API dökümantasyonu
```

---

## Geliştirme Fazları

### Faz 0 — Proje Altyapısı (1 gün)
**Hedef:** Projeyi ayağa kaldır, tüm tooling hazır olsun.

- [ ] Git repo + .gitignore
- [ ] Go module init + temel dependency'ler
- [ ] Vite + React + TypeScript + Tailwind kurulumu
- [ ] Tauri v2 init
- [ ] Docker Compose: Go server + LiveKit + (dev) hot reload
- [ ] SQLite database init + migration sistemi
- [ ] Temel config sistemi (env variables)
- [ ] CI/CD: GitHub Actions (lint + build)

**Çıktı:** `docker-compose up` ile boş bir uygulama ayağa kalkıyor.

---

### Faz 1 — Auth + Temel UI Shell (2-3 gün)
**Hedef:** Kullanıcılar kayıt olup giriş yapabilsin, ana layout görünsün.

**Backend:**
- [ ] User modeli + CRUD
- [ ] Password hashing (bcrypt)
- [ ] JWT access token (15 dk) + refresh token (7 gün)
- [ ] Register endpoint (ilk kullanıcı = admin)
- [ ] Login / Logout / Refresh endpoints
- [ ] Auth middleware

**Frontend:**
- [ ] Login sayfası
- [ ] Register sayfası
- [ ] Auth store (Zustand) + token management
- [ ] Protected routes
- [ ] Ana layout: 3-panel Discord layout (boş)
  - Sol sidebar (240px)
  - Orta chat alanı (esnek)
  - Sağ üye listesi (240px, toggle)
- [ ] Discord renk teması (dark mode)
  - Background: #313338
  - Sidebar: #2B2D31
  - Chat: #313338
  - Input: #383A40

**Çıktı:** Giriş yapıp boş Discord arayüzünü görebiliyorsun.

---

### Faz 2 — Kanallar + Gerçek Zamanlı Chat (3-4 gün)
**Hedef:** Text kanallarında gerçek zamanlı mesajlaşma.

**Backend:**
- [ ] Channel CRUD endpoints
- [ ] Category CRUD endpoints
- [ ] Message CRUD endpoints (pagination ile)
- [ ] WebSocket hub implementasyonu
  - Connection management
  - Room/channel-based broadcasting
  - Heartbeat (30 sn interval)
- [ ] WS events: message_create, message_update, message_delete
- [ ] Typing indicator event
- [ ] File upload endpoint (max 25MB, local storage)
- [ ] Attachment model + mesajla ilişkilendirme

**Frontend:**
- [ ] Channel listesi (kategorilerle, collapsible)
- [ ] Channel oluşturma modal
- [ ] Mesaj listesi (infinite scroll yukarı)
- [ ] Mesaj bileşeni (avatar, isim, zaman, içerik)
- [ ] Mesaj input (Enter gönder, Shift+Enter yeni satır)
- [ ] Mesaj düzenleme (kendi mesajın)
- [ ] Mesaj silme (kendi mesajın + yetkililer)
- [ ] Dosya/resim yükleme + preview
- [ ] Resim mesajları inline gösterim
- [ ] Typing indicator ("X yazıyor...")
- [ ] WebSocket hook + auto-reconnect
- [ ] Kanal değiştirince scroll position hatırlama
- [ ] Yeni mesaj göstergesi (unread indicator)
- [ ] @mention autocomplete

**Çıktı:** Birden fazla text kanalında gerçek zamanlı sohbet.

---

### Faz 3 — Voice Chat (3-4 gün)
**Hedef:** Voice kanallarda konuşma, temel kontroller.

**Backend:**
- [ ] LiveKit server konfigürasyonu
- [ ] LiveKit token generation endpoint
- [ ] Voice state tracking (kim hangi kanalda)
- [ ] WS event: voice_state_update

**Frontend:**
- [ ] Voice channel UI (bağlı kullanıcıları göster)
- [ ] Voice kanalına tıkla → bağlan
- [ ] LiveKit React SDK entegrasyonu
- [ ] Alt panel: bağlı kanal bilgisi + kontroller
  - Mute/Unmute mikrofon
  - Deafen/Undeafen (ses kapat)
  - Disconnect butonu
- [ ] Push-to-talk modu (tuş atama)
- [ ] Voice Activity Detection (otomatik mute)
- [ ] Konuşan kişi göstergesi (yeşil border)
- [ ] Kullanıcı bazlı ses seviyesi ayarı
- [ ] Voice Settings sayfası
  - Input/Output cihazı seçimi
  - Mikrofon hassasiyeti
  - Noise suppression (LiveKit built-in)
- [ ] Kanal giriş/çıkış sesleri

**Çıktı:** Arkadaşlarınla voice channel'da konuşabiliyorsun.

---

### Faz 4 — Screen Share (2-3 gün)
**Hedef:** 1080p/30fps screen share, aynı anda 2 yayın.

**Backend:**
- [ ] LiveKit screen share track konfigürasyonu
  - Max resolution: 1920x1080
  - Max FPS: 30
  - Codec: VP9 (daha iyi sıkıştırma) veya H.264 fallback
  - Simulcast: aktif (izleyici bant genişliğine göre adaptif)
- [ ] Stream state tracking (kim yayın yapıyor)
- [ ] WS events: voice_stream_start, voice_stream_end
- [ ] Aynı anda max 2 yayın limiti (server-side kontrol)

**Frontend:**
- [ ] "Ekranını Paylaş" butonu (voice panelinde)
- [ ] Screen/window/tab seçici (getDisplayMedia)
- [ ] Yayın yapan kişinin yanında 🔴 göstergesi
- [ ] Stream Viewer bileşeni
  - Tıkla → büyük görüntü aç
  - Picture-in-Picture modu
  - Tam ekran modu
- [ ] 2 eşzamanlı yayın grid layout
  - Tek yayın: tam genişlik
  - İki yayın: yan yana veya üst-alt (kullanıcı tercihi)
- [ ] Yayın kalite göstergesi (resolution + fps)
- [ ] Yayın sesi (sistem sesi paylaşma opsiyonu)
- [ ] Yayıncı kontrolü: duraklat, bitir

**Çıktı:** 1080p/30fps ekran paylaşımı, 2 yayın eşzamanlı izlenebiliyor.

---

### Faz 5 — Kullanıcı Yetkileri + Roller (2 gün)
**Hedef:** Rol bazlı yetki sistemi, kanal izinleri.

**Backend:**
- [ ] Role CRUD endpoints
- [ ] Permission bitfield sistemi
- [ ] Permission middleware (her endpoint'te kontrol)
- [ ] Kanal bazlı permission override
- [ ] İlk kullanıcı = Owner rolü (silinemez)
- [ ] Varsayılan roller: Owner, Admin, Moderator, Member
- [ ] Davet kodu sistemi (oluştur, kullan, expire)

**Frontend:**
- [ ] Server Settings sayfası
  - Genel ayarlar (isim, ikon)
  - Rol yönetimi
    - Rol oluştur/düzenle/sil
    - Renk seçici
    - Permission toggle'ları
    - Rol sıralaması (drag & drop)
  - Kanal izinleri (rol bazlı override)
  - Davet kodları yönetimi
- [ ] Kullanıcıya sağ tık → rol atama
- [ ] Yetkisiz işlemlerde UI'da butonları gizle/disable
- [ ] Üye listesinde role göre gruplama + renk

**Çıktı:** Admin her şeyi yönetebiliyor, roller çalışıyor.

---

### Faz 6 — Presence + UX Polish (2-3 gün)
**Hedef:** Online durumu, bildirimler, genel cilalama.

**Backend:**
- [ ] Presence sistemi (WebSocket bağlantı = online)
- [ ] Idle detection (5 dk aktivite yoksa)
- [ ] Son görülme takibi

**Frontend:**
- [ ] Online/Offline/Idle/DND durum göstergesi (avatar üstünde renkli nokta)
- [ ] Özel durum mesajı
- [ ] Üye listesi: online/offline gruplama
- [ ] Mention bildirimi (kanal adında kırmızı sayı)
- [ ] Desktop notification (Tauri native)
- [ ] System tray
  - Minimize to tray
  - Bildirim badge
  - Sağ tık menü (mute, disconnect, quit)
- [ ] Keyboard shortcuts
  - Ctrl+K: kanal ara
  - Ctrl+Shift+M: mute toggle
  - Ctrl+Shift+D: deafen toggle
- [ ] Kullanıcı ayarları sayfası
  - Profil düzenleme
  - Ses ayarları
  - Bildirim tercihleri
  - Keybind özelleştirme
- [ ] Mesaj hover aksiyonları (düzenle, sil, reaction placeholder)
- [ ] Context menu (sağ tık) her yerde
- [ ] Loading states + skeleton UI
- [ ] Error handling + toast notifications
- [ ] Auto-reconnect (WS + voice)

**Çıktı:** Pürüzsüz, Discord hissiyatı veren kullanıcı deneyimi.

---

### Faz 7 — Deployment + Open Source Hazırlığı (2 gün)
**Hedef:** Herkes tek komutla kurabilsin.

- [ ] Docker Compose finalize
  ```yaml
  services:
    mqvi:
      build: ./server
      ports: ["8080:8080"]
      environment:
        - LIVEKIT_URL=ws://livekit:7880
        - LIVEKIT_API_KEY=...
        - LIVEKIT_API_SECRET=...
      volumes:
        - ./data:/data  # SQLite + uploads
    
    livekit:
      image: livekit/livekit-server:latest
      ports: ["7880:7880", "7881:7881", "50000-50100:50000-50100/udp"]
      volumes:
        - ./livekit.yaml:/etc/livekit.yaml
    
    client:
      build: ./client
      ports: ["3000:3000"]
  ```
- [ ] One-click deploy script (`./install.sh`)
- [ ] SETUP.md: adım adım kurulum
  - Minimum gereksinimler
  - VPS kurulumu (Hetzner rehberi)
  - Domain + SSL (Caddy reverse proxy)
  - Firewall kuralları
- [ ] SELF-HOST.md: ileri düzey konfigürasyon
- [ ] Tauri build: Windows + macOS + Linux binary
- [ ] Auto-update sistemi (Tauri built-in)
- [ ] GitHub Release CI/CD (her tag'de binary çıkar)
- [ ] README.md: proje tanıtımı, screenshot'lar, özellik listesi
- [ ] CONTRIBUTING.md
- [ ] LICENSE (MIT)

**Çıktı:** GitHub'da yıldız almaya hazır, herkes kullanabilir.

---

## Toplam Tahmini Süre

| Faz | Süre | Kümülatif |
|-----|------|-----------|
| Faz 0: Altyapı | 1 gün | 1 gün |
| Faz 1: Auth + UI Shell | 2-3 gün | 4 gün |
| Faz 2: Chat | 3-4 gün | 8 gün |
| Faz 3: Voice | 3-4 gün | 12 gün |
| Faz 4: Screen Share | 2-3 gün | 15 gün |
| Faz 5: Yetkiler | 2 gün | 17 gün |
| Faz 6: Polish | 2-3 gün | 20 gün |
| Faz 7: Deploy | 2 gün | 22 gün |

### **Toplam: ~3-4 hafta** (Claude Code ile, günde 3-4 saat çalışarak)
### **Full-time sprint:** ~2 hafta

> ⚠️ Bu sürelere "öğrenme" dahil değil — Claude Code yazıyor, sen yönlendiriyorsun.
> Asıl süre yiyen kısım: test etme, edge case'leri bulma, UI detaylarını beğenme.

---

## Başlangıç Komutları

```bash
# Repo oluştur
mkdir mqvi && cd mqvi
git init

# Backend
mkdir server && cd server
go mod init github.com/akinalp/mqvi
cd ..

# Frontend
npm create vite@latest client -- --template react-ts
cd client && npm install && cd ..

# Tauri
cd client
npm install @tauri-apps/cli@next
npx tauri init
cd ..

# Docker
touch docker-compose.yml
```

---

## Notlar

### Performance Hedefleri
- Mesaj gönderme: <100ms (WS üzerinden)
- Voice latency: <50ms (LiveKit SFU)
- Screen share: 1080p/30fps, <200ms delay
- App başlatma: <3 saniye
- İlk yükleme (web): <2 saniye
- Memory kullanımı: <200MB (Tauri avantajı)

### Güvenlik
- Tüm şifreler bcrypt ile hash'lenir
- JWT access token kısa ömürlü (15 dk)
- Rate limiting tüm endpoint'lerde
- File upload: tip kontrolü + boyut limiti
- XSS koruması (mesaj sanitization)
- CORS sadece kendi domain'ine izin

### Open Source Stratejisi
- MIT lisansı (en özgür)
- GitHub'da public repo
- "Self-hosted Discord alternative" SEO
- README'de güzel screenshot'lar
- Docker ile tek komut kurulum
- YouTube'da geliştirme serisi (devlog)
- Hacker News + Reddit /r/selfhosted paylaşımı