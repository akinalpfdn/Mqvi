// Package pkg, projede paylaşılan utility'leri barındırır.
// Bu dosya domain-level error tanımlarını içerir.
//
// Go'da error'lar basit değerlerdir (string taşıyan struct'lar).
// errors.New() ile sabit error değişkenleri tanımlarız.
// Böylece error karşılaştırması string yerine referans ile yapılır:
//
//	if errors.Is(err, pkg.ErrNotFound) { ... }
//
// Bu, typo'ya açık string karşılaştırmasından çok daha güvenlidir.
package pkg

import "errors"

// Domain-level error'lar.
// Handler katmanı bu error'ları HTTP status code'larına map'ler.
// Service katmanı bunları döner, handler yakalar.
var (
	ErrNotFound      = errors.New("not found")
	ErrUnauthorized  = errors.New("unauthorized")
	ErrForbidden     = errors.New("forbidden")
	ErrAlreadyExists = errors.New("already exists")
	ErrBadRequest    = errors.New("bad request")
	ErrInternal      = errors.New("internal error")
)
