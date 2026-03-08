// Package i18n provides backend localization.
//
// Language detection priority:
//  1. User's DB language preference (if authenticated)
//  2. Accept-Language header
//  3. Default (en)
package i18n

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"strings"
	"sync"
)

var SupportedLanguages = []string{"en", "tr"}

const DefaultLanguage = "en"

// Loaded once at startup, read-only after — thread-safe without mutex.
var (
	translations map[string]map[string]string
	loadOnce     sync.Once
)

// Load reads translation files from the given fs.FS.
// Expects one JSON file per language: en.json, tr.json.
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

			// Flatten nested JSON: {"auth": {"login": "..."}} → "auth.login"
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

type Localizer struct {
	lang string
}

// NewLocalizer creates a localizer for the given language.
// Falls back to default if unsupported.
func NewLocalizer(lang string) *Localizer {
	if !isSupported(lang) {
		lang = DefaultLanguage
	}
	return &Localizer{lang: lang}
}

// T returns the translated string for the given key.
// Falls back to English, then to the key itself.
func (l *Localizer) T(key string) string {
	if msg, ok := translations[l.lang][key]; ok {
		return msg
	}
	if msg, ok := translations[DefaultLanguage][key]; ok {
		return msg
	}
	return key
}

// TWithParams replaces {{param}} placeholders in the translated string.
func (l *Localizer) TWithParams(key string, params map[string]string) string {
	msg := l.T(key)
	for k, v := range params {
		msg = strings.ReplaceAll(msg, "{{"+k+"}}", v)
	}
	return msg
}

// DetectLanguage extracts the best supported language from Accept-Language header.
func DetectLanguage(acceptLanguage string) string {
	if acceptLanguage == "" {
		return DefaultLanguage
	}

	parts := strings.Split(acceptLanguage, ",")
	for _, part := range parts {
		lang := strings.TrimSpace(strings.Split(part, ";")[0])
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

// flattenMap converts nested JSON to dot-notation keys.
// {"auth": {"login": "Login"}} → {"auth.login": "Login"}
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
