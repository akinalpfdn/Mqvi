package models

import (
	"encoding/json"
	"reflect"
	"testing"
)

// The sidebar entry is the client's only source for a server's encryption state, and the client
// reads an absent flag as "unknown", not "off" — deliberately, because guessing "off" is what sent
// a plaintext message to an encrypted server. That makes the JSON tags load-bearing in a way tags
// usually are not: adding `,omitempty` to a bool drops it from the wire whenever it is false, so
// every unencrypted server would arrive as unknown and its members would be refused a send.
//
// One character, no compile error, no test — until this one.
func TestServerListItem_SendsEveryFieldEvenWhenFalse(t *testing.T) {
	raw, err := json.Marshal(ServerListItem{ID: "s1", Name: "Alpha"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var onTheWire map[string]any
	if err := json.Unmarshal(raw, &onTheWire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	for _, key := range []string{"id", "name", "icon_url", "verified", "e2ee_enabled"} {
		if _, present := onTheWire[key]; !present {
			t.Errorf(
				"%q is missing from the payload when it holds a zero value (%s) — the client reads an "+
					"absent field as unknown", key, raw,
			)
		}
	}
}

// The constructor hand-lists its fields, and the comment above it says so: hand-listing is what
// left `verified` out of the broadcasts in the first place. A field added to the struct and not to
// the constructor compiles, ships, and arrives as a zero value.
func TestNewServerListItem_CopiesEveryFieldItDeclares(t *testing.T) {
	source := &Server{}
	fillNonZero(t, reflect.ValueOf(source).Elem(), reflect.TypeOf(ServerListItem{}))

	got := reflect.ValueOf(NewServerListItem(source))

	typ := got.Type()
	for i := 0; i < typ.NumField(); i++ {
		if got.Field(i).IsZero() {
			t.Errorf(
				"%s came back zero although the server had a value for it — the constructor does not "+
					"copy it", typ.Field(i).Name,
			)
		}
	}
}

// fillNonZero sets, on the source struct, every field the target type declares — so a field the
// constructor forgets shows up as a zero on the way out.
func fillNonZero(t *testing.T, source reflect.Value, target reflect.Type) {
	t.Helper()
	for i := 0; i < target.NumField(); i++ {
		name := target.Field(i).Name
		f := source.FieldByName(name)
		if !f.IsValid() || !f.CanSet() {
			t.Fatalf("Server has no settable field %q, so this test cannot prove the copy", name)
		}
		switch f.Kind() {
		case reflect.String:
			f.SetString("x")
		case reflect.Bool:
			f.SetBool(true)
		case reflect.Ptr:
			p := reflect.New(f.Type().Elem())
			if p.Elem().Kind() == reflect.String {
				p.Elem().SetString("x")
			}
			f.Set(p)
		default:
			t.Fatalf("field %q has kind %s, which this test does not know how to fill", name, f.Kind())
		}
	}
}
