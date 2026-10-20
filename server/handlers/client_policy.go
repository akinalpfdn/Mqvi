package handlers

import (
	"net/http"

	"github.com/akinalp/mqvi/pkg"
)

// ClientPolicyResponse tells the mobile apps what this server requires of them. Public: an app
// has to know it is too old before anyone signs in.
type ClientPolicyResponse struct {
	MinVersions ClientMinVersions `json:"min_versions"`
}

// ClientMinVersions holds the oldest app version served per platform; "" means no minimum.
type ClientMinVersions struct {
	Android string `json:"android"`
	IOS     string `json:"ios"`
}

// ClientPolicyHandler serves GET /api/client-policy. The policy is fixed at startup.
type ClientPolicyHandler struct {
	policy ClientPolicyResponse
}

func NewClientPolicyHandler(minAndroid, minIOS string) *ClientPolicyHandler {
	return &ClientPolicyHandler{policy: ClientPolicyResponse{
		MinVersions: ClientMinVersions{Android: minAndroid, IOS: minIOS},
	}}
}

// Get returns the policy. GET /api/client-policy
func (h *ClientPolicyHandler) Get(w http.ResponseWriter, r *http.Request) {
	pkg.JSON(w, http.StatusOK, h.policy)
}
