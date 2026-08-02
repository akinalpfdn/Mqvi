package middleware

import (
	"go/parser"
	"go/token"
	"strconv"
	"testing"
)

// Middleware runs before a handler and must not depend on one. It imported `handlers` for years
// purely to reach three context-key constants, which put the dependency arrow backwards and made
// the keys impossible to move. They live in pkg/ctxkeys now.
//
// Nothing in the compiler stops the import coming back — the next person who needs a constant from
// handlers will just add it and it will build. This is the thing that says no.
func TestMiddleware_DoesNotImportHandlers(t *testing.T) {
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", nil, parser.ImportsOnly)
	if err != nil {
		t.Fatalf("parse middleware package: %v", err)
	}
	// Guards the guard: an empty parse would make the loop below pass without checking anything.
	if len(pkgs) == 0 {
		t.Fatal("parsed no packages — the check ran against nothing")
	}

	const forbidden = "github.com/akinalp/mqvi/handlers"

	for _, pkg := range pkgs {
		for name, file := range pkg.Files {
			for _, imp := range file.Imports {
				path, err := strconv.Unquote(imp.Path.Value)
				if err != nil {
					t.Fatalf("%s: unquote import %s: %v", name, imp.Path.Value, err)
				}
				if path == forbidden {
					t.Errorf("%s imports %s — middleware must not depend on handlers. "+
						"If you need a shared value, put it in a leaf package both can import, "+
						"the way pkg/ctxkeys holds the context keys.", name, path)
				}
			}
		}
	}
}
