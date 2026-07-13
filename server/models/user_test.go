package models

import "testing"

// users.language is NOT NULL DEFAULT 'en', but every INSERT names the column, so the default
// never fires and an unset field lands as "". That empty string reads as "no preference": the
// client keeps the browser locale while the profile picker and push notifications both fall
// back to English, which is how a Turkish user ends up with a Turkish UI labelled "English".
func TestCreateUserRequest_ValidateNormalizesLanguage(t *testing.T) {
	tests := []struct {
		name string
		lang string
		want string
	}{
		{"absent — an older client sends none", "", DefaultUserLanguage},
		{"unsupported", "de", DefaultUserLanguage},
		{"supported", "tr", "tr"},
		{"supported default", "en", "en"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := &CreateUserRequest{
				Username: "someone",
				Password: "hunter2hunter2",
				Language: tt.lang,
			}
			if err := req.Validate(); err != nil {
				t.Fatalf("validate: %v", err)
			}
			if req.Language != tt.want {
				t.Errorf("language = %q, want %q", req.Language, tt.want)
			}
		})
	}
}
