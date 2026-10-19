package models

// CredentialStoreFailureRequest is the desktop app reporting that "remember me" could not save or
// read the stored username and password. The failure is silent for the user — the login form is
// simply empty next time — so nothing would reach the server otherwise.
type CredentialStoreFailureRequest struct {
	Operation string `json:"operation"`
	Reason    string `json:"reason"`
	Platform  string `json:"platform"`
	// Backend is Electron's Linux password store (getSelectedStorageBackend); empty elsewhere.
	Backend string `json:"backend,omitempty"`
	Detail  string `json:"detail,omitempty"`
}

// Closed sets: these land in the operator's log, and an unvalidated string is a member writing
// arbitrary content into it.
var CredentialStoreOperations = map[string]bool{"save": true, "load": true}

var CredentialStoreFailureReasons = map[string]bool{
	"unavailable":    true, // safeStorage reported encryption unavailable
	"encrypt_failed": true,
	"write_failed":   true,
	"decrypt_failed": true, // the stored file exists but cannot be read back
	"read_failed":    true,
}

var CredentialStorePlatforms = map[string]bool{"windows": true, "macos": true, "linux": true}

var CredentialStoreBackends = map[string]bool{
	"": true, "basic_text": true, "gnome_libsecret": true, "kwallet": true, "kwallet5": true,
	"kwallet6": true, "unknown": true,
}

// CredentialStoreDetailMax bounds the free-form error text.
const CredentialStoreDetailMax = 200
