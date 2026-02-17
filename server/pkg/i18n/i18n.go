// Package i18n, backend tarafında çoklu dil desteği sağlar.
//
// API error mesajları ve yanıtlar kullanıcının diline göre döner.
// Dil bilgisi şu sırayla belirlenir:
//   1. Kullanıcının DB'deki language tercihi (giriş yapılmışsa)
//   2. Accept-Language HTTP header'ı
//   3. Varsayılan dil (en)
//
// Kullanım:
//
//	localizer := i18n.NewLocalizer("tr")
//	msg := localizer.T("auth.invalidCredentials")
//	// → "Geçersiz kullanıcı adı veya şifre"
package i18n

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"strings"
	"sync"
)

// SupportedLanguages — desteklenen dil kodları.
var SupportedLanguages = []string{"en", "tr"}

// DefaultLanguage — varsayılan dil.
const DefaultLanguage = "en"

// translations, tüm dil çevirilerini bellekte tutan harita.
// map[lang]map[key]value formatında.
// Uygulama başlangıcında yüklenir, sonra sadece okunur — thread-safe.
var (
	translations map[string]map[string]string
	loadOnce     sync.Once
)

// Load, çeviri dosyalarını fs.FS'ten yükler.
// localesFS: JSON dosyalarını içeren dosya sistemi (embed.FS veya os.DirFS)
// Her dil için bir JSON dosyası beklenir: en.json, tr.json
//
// sync.Once nedir?
// Bir fonksiyonun programın ömrü boyunca sadece BİR KERE çalışmasını garanti eder.
// Birden fazla goroutine aynı anda çağırsa bile sadece biri çalışır, diğerleri bekler.
// Config/translation yükleme gibi "bir kere yap" işlemleri için idealdir.
func Load(localesFS fs.FS) error {
	var loadErr error

	loadOnce.Do(func() {
		translations = make(map[string]map[string]string)

		for _, lang := range SupportedLanguages {
			fileName := lang + ".json"

			data, err := fs.ReadFile(localesFS, fileName)
			if err != nil {
				loadErr = fmt.Errorf("failed to read translation file %s: %w", fileName, err)
				return
			}

			// Nested JSON'u flat key'lere dönüştür: {"auth": {"login": "..."}} → "auth.login"
			var nested map[string]any
			if err := json.Unmarshal(data, &nested); err != nil {
				loadErr = fmt.Errorf("failed to parse translation file %s: %w", fileName, err)
				return
			}

			flat := make(map[string]string)
			flattenMap("", nested, flat)
			translations[lang] = flat

			log.Printf("[i18n] loaded %d keys for language: %s", len(flat), lang)
		}
	})

	return loadErr
}

// Localizer, belirli bir dil için çeviri yapan struct.
type Localizer struct {
	lang string
}

// NewLocalizer, belirli bir dil için Localizer oluşturur.
// Desteklenmeyen dil verilirse varsayılana düşer.
func NewLocalizer(lang string) *Localizer {
	if !isSupported(lang) {
		lang = DefaultLanguage
	}
	return &Localizer{lang: lang}
}

// T, çeviri anahtarına karşılık gelen metni döner.
// Anahtar bulunamazsa → İngilizce'ye düşer.
// İngilizce'de de yoksa → anahtarın kendisini döner.
func (l *Localizer) T(key string) string {
	// Önce kullanıcının dilinde ara
	if msg, ok := translations[l.lang][key]; ok {
		return msg
	}
	// Fallback: İngilizce
	if msg, ok := translations[DefaultLanguage][key]; ok {
		return msg
	}
	// Son çare: anahtarın kendisi
	return key
}

// TWithParams, parametreli çeviri yapar.
// Çeviri metnindeki {{param}} yer tutucularını değerlerle değiştirir.
//
// Örnek:
//
//	localizer.TWithParams("chat.typing", map[string]string{"user": "Ali"})
//	→ "Ali yazıyor..."
func (l *Localizer) TWithParams(key string, params map[string]string) string {
	msg := l.T(key)
	for k, v := range params {
		msg = strings.ReplaceAll(msg, "{{"+k+"}}", v)
	}
	return msg
}

// DetectLanguage, Accept-Language header'ından en uygun dili belirler.
// Header formatı: "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7"
func DetectLanguage(acceptLanguage string) string {
	if acceptLanguage == "" {
		return DefaultLanguage
	}

	// Basit parsing: ilk eşleşen desteklenen dili döndür
	parts := strings.Split(acceptLanguage, ",")
	for _, part := range parts {
		lang := strings.TrimSpace(strings.Split(part, ";")[0])
		// "tr-TR" → "tr"
		lang = strings.Split(lang, "-")[0]
		lang = strings.ToLower(lang)

		if isSupported(lang) {
			return lang
		}
	}

	return DefaultLanguage
}

// ─── Helpers ───

func isSupported(lang string) bool {
	for _, l := range SupportedLanguages {
		if l == lang {
			return true
		}
	}
	return false
}

// flattenMap, nested JSON'u "dot notation" key'lere dönüştürür.
// {"auth": {"login": "Giriş"}} → {"auth.login": "Giriş"}
func flattenMap(prefix string, src map[string]any, dst map[string]string) {
	for k, v := range src {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}

		switch val := v.(type) {
		case string:
			dst[key] = val
		case map[string]any:
			flattenMap(key, val, dst)
		}
	}
}
