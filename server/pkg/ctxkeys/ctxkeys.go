// Package ctxkeys holds the request-context keys shared by middleware and handlers.
//
// They used to live in the handlers package, which forced middleware to import handlers — the
// wrong direction: middleware runs before a handler and must not depend on one. A leaf package
// both can import breaks the inversion without either knowing about the other.
//
// The key type stays unexported on purpose. Only the constants below can index these values, so
// nothing outside this package can collide with them, and a string literal cannot be passed by
// mistake.
package ctxkeys

type contextKey string

// User is the authenticated *models.User, set by AuthMiddleware.
const User contextKey = "user"

// ServerID is the active server, set by ServerMembershipMiddleware.
const ServerID contextKey = "server_id"

// Permissions is the user's effective permission set for the active server, set by
// PermissionMiddleware.
const Permissions contextKey = "permissions"
