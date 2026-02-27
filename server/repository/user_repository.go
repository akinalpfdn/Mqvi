// Package repository, veritabanı erişim katmanını tanımlar.
//
// Repository Pattern nedir?
// Veritabanı işlemlerini (CRUD) soyutlayan bir tasarım kalıbıdır.
// Service katmanı doğrudan SQL yazmaz — repository interface'i üzerinden çalışır.
//
// Neden interface?
// 1. Test: Mock repository yazarak DB olmadan test edebilirsin
// 2. Esneklik: SQLite'tan PostgreSQL'e geçmek istersen sadece yeni implementasyon yazarsın
// 3. SOLID (Dependency Inversion): Service, concrete struct'a değil interface'e bağımlı
//
// Go'da interface "implicit"tır — bir struct, interface'deki tüm method'ları
// implement ediyorsa otomatik olarak o interface'i sağlar. Java'daki gibi
// "implements" keyword'üne gerek yok.
package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// UserRepository, kullanıcı veritabanı işlemleri için interface.
//
// context.Context nedir?
// Go'da goroutine'ler arası iptal sinyali ve deadline taşıyan bir yapıdır.
// HTTP handler bir request aldığında context oluşturur — client bağlantıyı koparırsa
// context iptal olur ve devam eden DB sorgusu da durur. Resource waste'i önler.
type UserRepository interface {
	Create(ctx context.Context, user *models.User) error
	GetByID(ctx context.Context, id string) (*models.User, error)
	GetByUsername(ctx context.Context, username string) (*models.User, error)
	GetAll(ctx context.Context) ([]models.User, error)
	Update(ctx context.Context, user *models.User) error
	UpdateStatus(ctx context.Context, userID string, status models.UserStatus) error
	// UpdatePassword, kullanıcının şifre hash'ini günceller.
	// AuthService.ChangePassword tarafından çağrılır — yeni bcrypt hash alır.
	UpdatePassword(ctx context.Context, userID string, newPasswordHash string) error
	Count(ctx context.Context) (int, error)
	// Delete, kullanıcıyı siler (kick işlemi için).
	// FK cascade ile user_roles, sessions vb. ilişkili kayıtlar da silinir.
	Delete(ctx context.Context, id string) error
}
