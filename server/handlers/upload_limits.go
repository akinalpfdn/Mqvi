package handlers

import (
	"fmt"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"

	"github.com/akinalp/mqvi/services"
)

const multipartOverheadBytes = 1 << 20

// Form field prefix for the companion previews a client uploads alongside files[i].
const thumbnailFieldPrefix = "thumb_"

// maxThumbnailEdge bounds the dimensions a client may claim for its preview. Our own generator caps
// the long edge at 800; anything far past that is a client trying to make every viewer render an
// <img width="1000000000">.
const maxThumbnailEdge = 8192

func limitMultipartBody(w http.ResponseWriter, r *http.Request, maxFileBytes int64, maxFiles int) {
	if maxFileBytes <= 0 || maxFiles <= 0 {
		return
	}
	// Each file may bring a companion thumbnail, so the budget has to cover those parts too —
	// otherwise a send at the file limit dies inside ParseMultipartForm with an unhelpful
	// "failed to parse multipart form" instead of a size error.
	perFile := maxFileBytes + multipartOverheadBytes + services.MaxThumbnailBytes
	r.Body = http.MaxBytesReader(w, r.Body, perFile*int64(maxFiles))
}

// thumbnailBytes sums the companion previews in the form. They are charged to the uploader's quota
// like any other stored bytes, so they must be reserved before the upload starts.
func thumbnailBytes(form *multipart.Form) int64 {
	if form == nil {
		return 0
	}
	var total int64
	for name, headers := range form.File {
		if !strings.HasPrefix(name, thumbnailFieldPrefix) {
			continue
		}
		for _, h := range headers {
			total += h.Size
		}
	}
	return total
}

// thumbnailFor returns the companion preview the client uploaded for files[index], or nil.
//
// Paired by index rather than by order of a parallel list: a missing thumbnail must not shift every
// later attachment onto the wrong preview. Absent is the normal case.
//
// The caller owns the returned file and must close it.
func thumbnailFor(form *multipart.Form, index int) *services.ThumbnailUpload {
	if form == nil {
		return nil
	}
	headers := form.File[fmt.Sprintf("%s%d", thumbnailFieldPrefix, index)]
	if len(headers) == 0 {
		return nil
	}
	file, err := headers[0].Open()
	if err != nil {
		return nil
	}
	width := thumbnailDimension(form, fmt.Sprintf("%s%d_w", thumbnailFieldPrefix, index))
	height := thumbnailDimension(form, fmt.Sprintf("%s%d_h", thumbnailFieldPrefix, index))
	return &services.ThumbnailUpload{File: file, Header: headers[0], Width: width, Height: height}
}

// thumbnailDimension reads a client-supplied preview dimension, returning 0 for anything it will not
// vouch for. The value is echoed to every viewer as an <img> width/height, so an unparsable or
// absurd number is dropped rather than trusted — storeThumbnail then stores no dimensions at all
// and the client falls back to laying out from the image itself.
func thumbnailDimension(form *multipart.Form, key string) int {
	raw := formValue(form, key)
	if raw == "" {
		return 0
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v <= 0 || v > maxThumbnailEdge {
		return 0
	}
	return v
}

func formValue(form *multipart.Form, key string) string {
	if values := form.Value[key]; len(values) > 0 {
		return values[0]
	}
	return ""
}
