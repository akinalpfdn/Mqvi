# mqvi Go Backend — Multi-stage Docker build

# ─── Builder Stage ───
FROM golang:1.23-alpine AS builder

# Pure-Go SQLite driver — no CGO/GCC needed
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

# Migrations
COPY --from=builder /build/database/migrations ./database/migrations

# Data directory
RUN mkdir -p /data/uploads

EXPOSE 9090

CMD ["./mqvi"]
