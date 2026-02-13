// Package handlers — AvatarHandler: kullanıcı avatar ve sunucu ikon yükleme endpoint'leri.
//
// Bu handler, mevcut UploadService'den bağımsızdır çünkü:
// - UploadService mesaj eklentilerine özeldir (messageID gerektirir, Attachment kaydı oluşturur)
// - Avatar upload ise doğrudan User/Server kaydını günceller
// - Sadece resim MIME type'ları kabul edilir (genel upload'dan daha kısıtlı)
//
// İşlem akışı:
// 1. Multipart form parse → "file" alanını oku
// 2. MIME type kontrolü (sadece resim)
// 3. Boyut kontrolü (max 8MB)
// 4. Dosyayı diske kaydet (random hex prefix + orijinal isim)
// 5. Kullanıcı/sunucu kaydını güncelle (avatar_url / icon_url)
// 6. WS broadcast ile tüm client'lara bildir
package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/services"
)

// avatarMaxSize, avatar/ikon dosyası için maksimum boyut (8MB).
// Genel dosya upload limitinden (25MB) daha düşüktür çünkü
// avatarlar küçük, optimize edilmiş resimler olmalıdır.
const avatarMaxSize = 8 << 20 // 8 * 1024 * 1024 = 8MB

// allowedImageMimes, avatar yüklemesinde kabul edilen resim MIME type'ları.
// Genel upload'dan farklı olarak video/pdf/text kabul edilmez.
var allowedImageMimes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

// AvatarHandler, avatar ve ikon yükleme endpoint'lerini yönetir.
//
// Dependency'ler:
// - userRepo: Kullanıcı avatar_url güncellemesi için
// - memberService: Güncellenmiş MemberWithRoles döndürmek ve WS broadcast için
// - serverService: Sunucu icon_url güncellemesi için
// - uploadDir: Dosyaların kaydedileceği dizin yolu
type AvatarHandler struct {
	userRepo      repository.UserRepository
	memberService services.MemberService
	serverService services.ServerService
	uploadDir     string
}

// NewAvatarHandler, constructor.
func NewAvatarHandler(
	userRepo repository.UserRepository,
	memberService services.MemberService,
	serverService services.ServerService,
	uploadDir string,
) *AvatarHandler {
	return &AvatarHandler{
		userRepo:      userRepo,
		memberService: memberService,
		serverService: serverService,
		uploadDir:     uploadDir,
	}
}

// UploadUserAvatar godoc
// POST /api/users/me/avatar
// Content-Type: multipart/form-data
// Body: file field ile resim dosyası
//
// Kullanıcının kendi avatarını yükler.
// Eski avatar dosyası varsa diskten silinir (çöp birikmesini önler).
// Yeni avatar URL'i user kaydına yazılır ve member_update WS broadcast yapılır.
func (h *AvatarHandler) UploadUserAvatar(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	// Dosyayı parse et ve validate et
	fileURL, err := h.processUpload(r)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	// Eski avatar dosyasını diskten sil (varsa)
	h.deleteOldFile(user.AvatarURL)

	// UpdateProfile ile avatar_url'i güncelle + WS broadcast
	// Bu şekilde tek bir noktadan (MemberService) güncelleme yapılır —
	// DRY prensibi: aynı broadcast mantığını tekrar yazmıyoruz.
	member, err := h.memberService.UpdateProfile(r.Context(), user.ID, &models.UpdateProfileRequest{
		AvatarURL: &fileURL,
	})
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, member)
}

// UploadServerIcon godoc
// POST /api/server/icon
// Content-Type: multipart/form-data
// Body: file field ile resim dosyası
//
// Sunucu ikonunu yükler. Admin yetkisi gerektirir (permMiddleware ile korunur).
// Eski ikon dosyası varsa diskten silinir.
// Yeni ikon URL'i server kaydına yazılır ve server_update WS broadcast yapılır.
func (h *AvatarHandler) UploadServerIcon(w http.ResponseWriter, r *http.Request) {
	// Dosyayı parse et ve validate et
	fileURL, err := h.processUpload(r)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	// Mevcut sunucu bilgisini al — eski ikonu silmek için
	currentServer, err := h.serverService.Get(r.Context())
	if err != nil {
		pkg.Error(w, err)
		return
	}

	// Eski ikon dosyasını diskten sil (varsa)
	h.deleteOldFile(currentServer.IconURL)

	// ServerService ile icon_url güncelle + WS broadcast
	server, err := h.serverService.UpdateIcon(r.Context(), fileURL)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, server)
}

// processUpload, multipart form'dan dosyayı okur, validate eder ve diske kaydeder.
// Başarılı olursa dosyanın URL path'ini döner (ör: "/api/uploads/a1b2c3d4_avatar.png").
//
// Bu private metod hem UploadUserAvatar hem de gelecekteki UploadServerIcon
// tarafından ortak kullanılır — DRY prensibi.
func (h *AvatarHandler) processUpload(r *http.Request) (string, error) {
	// Multipart form parse — maxMemory parametresi dosyanın bellekte tutulacak
	// maksimum boyutunu belirler. Üzerindeki kısım temp dosyaya yazılır.
	if err := r.ParseMultipartForm(avatarMaxSize); err != nil {
		return "", fmt.Errorf("%w: failed to parse multipart form", pkg.ErrBadRequest)
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		return "", fmt.Errorf("%w: file field is required", pkg.ErrBadRequest)
	}
	defer file.Close()

	// Boyut kontrolü
	if header.Size > avatarMaxSize {
		return "", fmt.Errorf("%w: file too large (max 8MB)", pkg.ErrBadRequest)
	}

	// MIME type kontrolü — sadece resim dosyaları kabul edilir
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	mimeBase := strings.Split(contentType, ";")[0]
	mimeBase = strings.TrimSpace(mimeBase)

	if !allowedImageMimes[mimeBase] {
		return "", fmt.Errorf("%w: only image files are allowed (jpeg, png, gif, webp)", pkg.ErrBadRequest)
	}

	// Unique dosya adı: {random_hex}_{sanitized_original_name}
	// Random prefix çakışmayı önler, orijinal isim debugging kolaylığı sağlar.
	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", fmt.Errorf("failed to generate random filename: %w", err)
	}
	safeFilename := sanitizeAvatarFilename(header.Filename)
	diskFilename := hex.EncodeToString(randomBytes) + "_" + safeFilename

	// Dosyayı diske kaydet
	destPath := filepath.Join(h.uploadDir, diskFilename)
	destFile, err := os.Create(destPath)
	if err != nil {
		return "", fmt.Errorf("failed to create file: %w", err)
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, file); err != nil {
		os.Remove(destPath) // Hata durumunda yarım kalan dosyayı temizle
		return "", fmt.Errorf("failed to save file: %w", err)
	}

	return "/api/uploads/" + diskFilename, nil
}

// deleteOldFile, eski avatar/ikon dosyasını diskten siler.
// URL null ise veya dosya bulunamazsa sessizce devam eder —
// avatar silme kritik bir işlem değildir, hata loglanır ama propagate edilmez.
func (h *AvatarHandler) deleteOldFile(fileURL *string) {
	if fileURL == nil || *fileURL == "" {
		return
	}

	// URL'den dosya adını çıkar: "/api/uploads/abc123_avatar.png" → "abc123_avatar.png"
	filename := filepath.Base(*fileURL)
	if filename == "." || filename == "/" {
		return
	}

	oldPath := filepath.Join(h.uploadDir, filename)
	// os.Remove hata döndürürse (dosya yoksa vb.) sessizce geçiyoruz
	os.Remove(oldPath)
}

// sanitizeAvatarFilename, dosya adını güvenli hale getirir.
// Path traversal saldırılarını önler.
// upload_service.go'daki sanitizeFilename ile aynı mantık —
// package-private olduğu için burada ayrı tanımlanıyor.
func sanitizeAvatarFilename(name string) string {
	name = filepath.Base(name)

	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == '\x00' {
			return -1
		}
		return r
	}, name)

	if name == "" || name == "." || name == ".." {
		name = "unnamed"
	}

	return name
}
