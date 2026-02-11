# mqvi Project Rules

Bu dosya Claude Code'un her konuşmada otomatik okuduğu kural setidir.
**Bu projede "basit tut / over-engineering yapma" varsayılanı GEÇERSİZDİR.**
Kod her zaman production-grade, scalable ve SOLID uyumlu olmalıdır.

---

## Kullanıcı Profili

- Kullanıcı Go ve Tauri'ye yeni, React/TypeScript tecrübesi az.
- Açıklamalar öğretici olmalı: "neden bu pattern", "bu Go'da ne işe yarıyor" anlatılmalı.
- Yeni bir Go konsepti (goroutine, channel, interface, middleware, vb.) ilk kez kullanıldığında kısa açıklama ekle.
- Teknik kararlarda seçeneklerin artılarını/eksilerini göster.

---

## Stack

| Katman | Teknoloji |
|--------|-----------|
| Backend | Go (net/http + gorilla/websocket) |
| Frontend | React + TypeScript + Vite + Tailwind |
| Desktop | Tauri v2 |
| State | Zustand |
| Voice/Video | LiveKit (self-hosted SFU) |
| Database | SQLite (go-sqlite3) |
| Auth | JWT (access + refresh token) |
| Deploy | Docker Compose |

---

## Mimari Prensipler

### SOLID - Her Zaman Uyulmalı
- **Single Responsibility:** Her struct/component tek sorumluluk taşır.
- **Open/Closed:** Yeni davranış yeni implementasyon ile eklenir, mevcut kod değiştirilmez.
- **Liskov Substitution:** Interface implementasyonları birbirinin yerine geçebilmeli.
- **Interface Segregation:** Büyük interface'ler parçalanır, consumer sadece ihtiyacını implement eder.
- **Dependency Inversion:** Concrete struct'lara değil interface'lere bağımlı ol.

### Design Pattern Kullanımı
- Projede aktif patternler: **Repository, Service Layer, Middleware Chain, Observer (WebSocket hub), Factory, Strategy, Facade**.
- Pattern seçimi problem tipiyle eşleşmelidir, keyfi kullanma.
- Pattern uygularken interface tanımı ile başla.

### Katmanlı Mimari (Backend)
```
handlers/    → HTTP/WS request handling (thin, sadece parse + response)
services/    → Business logic (tüm kurallar burada)
repository/  → Data access (SQL queries, DB abstraction)
models/      → Struct tanımları + validation
middleware/  → Auth, permissions, rate limiting, logging
ws/          → WebSocket hub + event dispatching
```
- Handler asla doğrudan DB'ye erişmez → Service çağırır.
- Service asla `http.Request` bilmez → sadece domain modelleri alır/verir.
- Repository asla business logic içermez → CRUD + query.

### Dependency Injection (Backend)
- Tüm dependency'ler constructor injection ile alınır.
- Her service/handler struct'ında interface field'ları tutulur.
- `main.go`'da wire-up yapılır, global state YASAK.

```go
// DOĞRU
type MessageService struct {
    repo    MessageRepository  // interface
    hub     EventPublisher     // interface
}

func NewMessageService(repo MessageRepository, hub EventPublisher) *MessageService {
    return &MessageService{repo: repo, hub: hub}
}

// YANLIŞ
var db *sql.DB // global
```

---

## Go Kod Standartları

### Naming Conventions
- **Package:** tek kelime, lowercase → `handlers`, `models`, `ws`
- **Interface:** davranış ismi + `er` suffix VEYA `I` prefix yok → `MessageRepository`, `EventPublisher`
- **Struct:** PascalCase → `ChannelService`, `WebSocketHub`
- **Private:** camelCase → `currentHealth`, `connMap`
- **Constant:** PascalCase veya ALL_CAPS → `MaxMessageLength`, `DEFAULT_BITRATE`
- **Error variable:** `Err` prefix → `ErrNotFound`, `ErrUnauthorized`
- **Constructor:** `New` prefix → `NewChannelService()`, `NewAuthMiddleware()`

### Error Handling
- Her error kontrol edilmeli, `_` ile yutma YASAK.
- Custom error tipleri tanımla, string karşılaştırma yapma.
- Service katmanında domain error'lar, handler'da HTTP status mapping.

```go
// errors.go
var (
    ErrNotFound      = errors.New("not found")
    ErrUnauthorized  = errors.New("unauthorized")
    ErrForbidden     = errors.New("forbidden")
    ErrAlreadyExists = errors.New("already exists")
)
```

### Concurrency
- Shared state'e erişim `sync.Mutex` veya `sync.RWMutex` ile korunur.
- Goroutine'ler `context.Context` ile iptal edilebilir olmalı.
- Channel kullanımında buffer size bilinçli seçilmeli.
- WebSocket hub'da fan-out pattern ile broadcast.

### Dosya Organizasyonu
- Bir dosya = bir ana struct + interface'i.
- Test dosyası aynı dizinde: `service.go` → `service_test.go`.
- `internal/` package dışından erişilmemesi gereken kodlar için.

---

## React/TypeScript Kod Standartları

### Component Yapısı
```typescript
// 1. Imports (external → internal → types → styles)
// 2. Types/Interfaces
// 3. Component (function declaration, not arrow)
// 4. Hooks (zustand stores → custom hooks → React hooks)
// 5. Handlers
// 6. Render helpers (varsa)
// 7. Return JSX
```

### Naming Conventions
- **Component:** PascalCase → `ChannelList.tsx`, `VoicePanel.tsx`
- **Hook:** `use` prefix → `useWebSocket.ts`, `useVoice.ts`
- **Store:** camelCase + `Store` suffix → `channelStore.ts`
- **Type/Interface:** PascalCase, `I` prefix yok → `Channel`, `Message`, `User`
- **Event handler:** `handle` prefix → `handleSend`, `handleMute`
- **Boolean prop/state:** `is`/`has`/`can` prefix → `isMuted`, `hasPermission`

### State Management
- Global state: **Zustand** store'ları (auth, channels, messages, voice, ui).
- Store'lar slice pattern ile organize edilir, tek monolith store YASAK.
- Component-local state: `useState` sadece UI state için.
- Server state: store + WebSocket sync, fazladan cache katmanı ekleme.

### Styling
- **Tailwind CSS** utility-first, custom CSS yazma.
- Discord renk paleti theme.ts'de tanımlı, hardcode renk YASAK.
- Responsive düşünme (şimdilik desktop-only ama yapı bozulmasın).

---

## WebSocket Protokolü

```typescript
// Client → Server
{ op: "heartbeat" }
{ op: "typing", d: { channel_id: string } }
{ op: "presence_update", d: { status: "online" | "idle" | "dnd" } }

// Server → Client
{ op: string, d: any, seq: number }
```
- Her event `seq` (sequence number) taşır, client eksik event tespit edebilir.
- Reconnect'te son `seq` gönderilir, server missed events'i replay eder.
- Heartbeat 30sn interval, 3 miss = disconnect.

---

## Veritabanı Kuralları

- Migration'lar `migrations/` klasöründe sıralı SQL dosyaları: `001_init.sql`, `002_roles.sql`.
- Her migration idempotent olmalı (`IF NOT EXISTS`).
- Repository pattern: her tablo için ayrı repository interface + implementasyon.
- Raw SQL kullan, ORM yok. `sqlc` veya manual query.
- Transaction gereken işlemler service katmanında `WithTx()` wrapper ile.

---

## LiveKit Entegrasyonu

- Token generation server-side (Go SDK).
- Client tarafında `@livekit/components-react` kullanılır.
- Screen share config: 1080p/30fps, VP9 codec, simulcast aktif.
- Aynı anda max 2 screen share (server-side track kontrolü).
- Voice: Opus codec, noise suppression aktif, adaptive bitrate.

---

## Güvenlik

- Şifreler bcrypt ile hash'lenir (cost=12).
- JWT access token: 15dk, refresh token: 7 gün.
- Her endpoint'te auth middleware, her mutating endpoint'te permission middleware.
- File upload: MIME type whitelist + 25MB limit.
- Mesaj içeriği sanitize edilir (XSS koruması).
- Rate limiting: token bucket per-user.

---

## Dosya Yapısı

```
mqvi/
├── server/               # Go backend
│   ├── main.go
│   ├── config/
│   ├── models/
│   ├── repository/
│   ├── services/
│   ├── handlers/
│   ├── middleware/
│   ├── ws/
│   ├── migrations/
│   └── pkg/              # Shared utilities
├── client/               # React frontend
│   └── src/
│       ├── api/
│       ├── stores/
│       ├── hooks/
│       ├── components/
│       │   ├── layout/
│       │   ├── channels/
│       │   ├── chat/
│       │   ├── voice/
│       │   ├── members/
│       │   ├── auth/
│       │   ├── settings/
│       │   └── shared/
│       ├── styles/
│       ├── types/
│       └── utils/
├── src-tauri/            # Tauri desktop wrapper
├── docker-compose.yml
└── docs/
```

---

## Yasaklar - ASLA KULLANMA

1. Global değişken / package-level mutable state
2. `init()` fonksiyonlarında side effect
3. Error'ları `_` ile yutma
4. `any` / `interface{}` gereksiz kullanımı (typed olmalı)
5. God struct / 300+ satırlık fonksiyon
6. Frontend'de `any` type assertion
7. Inline style (Tailwind kullan)
8. `console.log` production'da (debug flagli logger kullan)
9. Hardcoded renk/boyut değerleri (theme'den al)
10. Circular dependency (katmanlar arası tek yönlü bağımlılık)

---

## Yeni Özellik Ekleme Checklist

### Backend
1. [ ] Interface tanımla (ilgili package'da)
2. [ ] Model/struct oluştur (models/)
3. [ ] Repository oluştur (repository/)
4. [ ] Service oluştur, dependency'leri constructor'dan al (services/)
5. [ ] Handler oluştur (handlers/)
6. [ ] Middleware gerekiyorsa ekle
7. [ ] main.go'da wire-up yap
8. [ ] Migration gerekiyorsa SQL dosyası ekle
9. [ ] WebSocket event gerekiyorsa ws/events.go'ya ekle

### Frontend
1. [ ] Type tanımla (types/)
2. [ ] API fonksiyonu ekle (api/)
3. [ ] Store güncellemesi gerekiyorsa slice ekle (stores/)
4. [ ] Component oluştur (tek dosya = tek component)
5. [ ] Hook gerekiyorsa oluştur (hooks/)
6. [ ] WebSocket event handler'ı ekle