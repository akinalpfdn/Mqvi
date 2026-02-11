# mqvi Go Backend — Multi-stage Docker build
#
# Multi-stage build ne demek?
# İlk stage'de (builder) Go kodunu derleriz — Go SDK, tüm source code vs. buradadır.
# İkinci stage'de (runner) sadece derlenmiş binary'yi ve migration dosyalarını kopyalarız.
# Sonuç: ~15MB image (tüm Go SDK yerine sadece binary).

# ─── Builder Stage ───
FROM golang:1.23-alpine AS builder

# Pure-Go SQLite driver (modernc.org/sqlite) kullanıyoruz — CGO/GCC gerekmez!
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o mqvi .

# ─── Runner Stage ───
FROM alpine:3.19

# SQLite runtime dependency
RUN apk add --no-cache ca-certificates

WORKDIR /app

# Binary
COPY --from=builder /build/mqvi .

# Migration dosyaları
COPY --from=builder /build/database/migrations ./database/migrations

# Data dizini
RUN mkdir -p /data/uploads

EXPOSE 8080

CMD ["./mqvi"]
