package models

import "testing"

func TestPermission_Has(t *testing.T) {
	tests := []struct {
		name  string
		perms Permission
		check Permission
		want  bool
	}{
		{"zero has nothing", 0, PermSendMessages, false},
		{"single perm set", PermSendMessages, PermSendMessages, true},
		{"single perm not set", PermSendMessages, PermManageChannels, false},
		{"multiple perms ORed", PermSendMessages | PermReadMessages, PermReadMessages, true},
		{"multiple perms missing one", PermSendMessages | PermReadMessages, PermConnectVoice, false},
		{"admin bypasses all", PermAdmin, PermManageChannels, true},
		{"admin bypasses voice", PermAdmin, PermConnectVoice, true},
		{"admin bypasses stream", PermAdmin, PermStream, true},
		{"admin with extras", PermAdmin | PermSendMessages, PermManageRoles, true},
		{"all perms has everything", PermAll, PermDeafenMembers, true},
		{"all perms has admin", PermAll, PermAdmin, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.perms.Has(tt.check)
			if got != tt.want {
				t.Errorf("Permission(%d).Has(%d) = %v, want %v", tt.perms, tt.check, got, tt.want)
			}
		})
	}
}

func TestPermission_Bitfield_Operations(t *testing.T) {
	// Grant
	var p Permission
	p |= PermSendMessages
	if !p.Has(PermSendMessages) {
		t.Error("grant: should have PermSendMessages after OR")
	}

	// Revoke
	p &^= PermSendMessages
	if p.Has(PermSendMessages) {
		t.Error("revoke: should not have PermSendMessages after AND-NOT")
	}

	// Override formula: effective = (base & ~deny) | allow
	base := PermSendMessages | PermReadMessages | PermConnectVoice
	deny := PermSendMessages
	allow := PermStream
	effective := (base & ^deny) | allow

	if effective.Has(PermSendMessages) {
		t.Error("override: SendMessages should be denied")
	}
	if !effective.Has(PermReadMessages) {
		t.Error("override: ReadMessages should still be set (not denied)")
	}
	if !effective.Has(PermStream) {
		t.Error("override: Stream should be allowed via override")
	}
	if !effective.Has(PermConnectVoice) {
		t.Error("override: ConnectVoice should still be set")
	}
}

func TestPermAll_Covers_All_Permissions(t *testing.T) {
	allPerms := []Permission{
		PermManageChannels, PermManageRoles, PermKickMembers, PermBanMembers,
		PermManageMessages, PermSendMessages, PermConnectVoice, PermSpeak,
		PermStream, PermAdmin, PermManageInvites, PermReadMessages,
		PermViewChannel, PermMoveMembers, PermMuteMembers, PermDeafenMembers,
	}

	for _, perm := range allPerms {
		if PermAll&perm == 0 {
			t.Errorf("PermAll should include permission %d", perm)
		}
	}
}

func TestHasOwnerRole(t *testing.T) {
	tests := []struct {
		name  string
		roles []Role
		want  bool
	}{
		{"empty roles", nil, false},
		{"no owner", []Role{{Name: "Member"}}, false},
		{"has owner", []Role{{Name: "Member"}, {Name: "Owner", IsOwner: true}}, true},
		{"owner only", []Role{{IsOwner: true}}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := HasOwnerRole(tt.roles)
			if got != tt.want {
				t.Errorf("HasOwnerRole() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSetOverrideRequest_Validate(t *testing.T) {
	tests := []struct {
		name    string
		req     SetOverrideRequest
		wantErr bool
	}{
		{"valid allow only", SetOverrideRequest{Allow: PermSendMessages}, false},
		{"valid deny only", SetOverrideRequest{Deny: PermReadMessages}, false},
		{"valid allow and deny different bits", SetOverrideRequest{Allow: PermSendMessages, Deny: PermReadMessages}, false},
		{"zero allow and deny", SetOverrideRequest{}, false},
		{"overlapping bits", SetOverrideRequest{Allow: PermSendMessages, Deny: PermSendMessages}, true},
		{"non-overridable allow", SetOverrideRequest{Allow: PermManageRoles}, true},
		{"non-overridable deny", SetOverrideRequest{Deny: PermKickMembers}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.req.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
