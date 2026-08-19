package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/pkg/crypto"
)

// roomCredentials — where a voice channel's LiveKit room lives, and how to sign for it.
// Credentials are decrypted; they must never be logged or returned to a client.
type roomCredentials struct {
	InstanceID string
	URL        string
	APIKey     string
	APISecret  string
}

// resolveRoomInstance is the single answer to "which LiveKit instance serves this channel's room".
//
// Every path that needs it goes through here — the join token, the screen-share sub-participant
// token, and the server-side room client used for participant removal, listing and mute
// enforcement. That is not tidiness. The room name is `serverID:channelID` (see generateRoomName)
// and carries no instance identity, so if two of those paths ever resolved differently they would
// each open a room of the same name on a different SFU. Both halves would work, neither would hear
// the other, and nothing would error. Having one function makes that disagreement impossible rather
// than merely unlikely.
//
// channelID is taken but not yet used: the instance is currently a property of the server. GEO-02
// moves the decision to the channel, and this is the seam it changes.
//
// MUST NOT be called while holding s.mu — it does a DB lookup.
func (s *voiceService) resolveRoomInstance(ctx context.Context, serverID, _ string) (*roomCredentials, error) {
	inst, err := s.livekitGetter.GetByServerID(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("livekit instance lookup for server %s: %w", serverID, err)
	}

	apiKey, err := crypto.Decrypt(inst.APIKey, s.encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("livekit api key decrypt (instance %s): %w", inst.ID, err)
	}
	apiSecret, err := crypto.Decrypt(inst.APISecret, s.encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("livekit api secret decrypt (instance %s): %w", inst.ID, err)
	}

	return &roomCredentials{
		InstanceID: inst.ID,
		URL:        inst.URL,
		APIKey:     apiKey,
		APISecret:  apiSecret,
	}, nil
}

// generateRoomName is the one place a room is named. Kept beside the resolver because the two are
// a pair: the name says which room, the resolver says which server it lives on, and a room is only
// unambiguous when both agree.
func generateRoomName(serverID, channelID string) string {
	return serverID + ":" + channelID
}
