package handlers

import (
	"fmt"
	"mime/multipart"
	"net/http"
	"strconv"

	"github.com/akinalp/mqvi/services"
)

const multipartOverheadBytes = 1 << 20

func limitMultipartBody(w http.ResponseWriter, r *http.Request, maxFileBytes int64, maxFiles int) {
	if maxFileBytes <= 0 || maxFiles <= 0 {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxFileBytes*int64(maxFiles)+multipartOverheadBytes*int64(maxFiles))
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
	headers := form.File[fmt.Sprintf("thumb_%d", index)]
	if len(headers) == 0 {
		return nil
	}
	file, err := headers[0].Open()
	if err != nil {
		return nil
	}
	width, _ := strconv.Atoi(formValue(form, fmt.Sprintf("thumb_%d_w", index)))
	height, _ := strconv.Atoi(formValue(form, fmt.Sprintf("thumb_%d_h", index)))
	return &services.ThumbnailUpload{File: file, Header: headers[0], Width: width, Height: height}
}

func formValue(form *multipart.Form, key string) string {
	if values := form.Value[key]; len(values) > 0 {
		return values[0]
	}
	return ""
}
