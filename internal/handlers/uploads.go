package handlers

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
)

const maxUploadSize = 10 << 20 // 10 MB

// allowedExtensions is the set of image extensions we permit.
var allowedExtensions = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
}

type UploadHandler struct {
	uploadDir string
}

func NewUploadHandler(uploadDir string) *UploadHandler {
	os.MkdirAll(uploadDir, 0o755)
	return &UploadHandler{uploadDir: uploadDir}
}

func (h *UploadHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Post("/", h.Upload)
	return r
}

// Upload accepts multipart/form-data with one or more "files" fields.
// Returns a JSON array of Attachment metadata.
func (h *UploadHandler) Upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize*10) // allow multiple files

	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "file too large (max 10MB each)", "FILE_TOO_LARGE")
		return
	}

	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		middleware.WriteError(w, http.StatusBadRequest, "no files provided", "NO_FILES")
		return
	}

	var attachments []models.Attachment

	for _, fh := range files {
		// Validate extension against allowlist (client-provided filename)
		ext := strings.ToLower(filepath.Ext(fh.Filename))
		if !allowedExtensions[ext] {
			middleware.WriteError(w, http.StatusBadRequest,
				fmt.Sprintf("invalid file extension %q (allowed: jpg, jpeg, png, gif, webp)", ext), "INVALID_TYPE")
			return
		}

		file, err := fh.Open()
		if err != nil {
			middleware.WriteError(w, http.StatusInternalServerError, "failed to read file", "READ_FAILED")
			return
		}
		defer file.Close()

		// Read first 512 bytes to detect actual MIME type from content (not client header)
		buf := make([]byte, 512)
		n, err := file.Read(buf)
		if err != nil && err != io.EOF {
			middleware.WriteError(w, http.StatusInternalServerError, "failed to read file", "READ_FAILED")
			return
		}
		detectedCT := http.DetectContentType(buf[:n])
		if !strings.HasPrefix(detectedCT, "image/") {
			middleware.WriteError(w, http.StatusBadRequest,
				fmt.Sprintf("file content does not appear to be an image (detected: %s)", detectedCT), "INVALID_TYPE")
			return
		}

		// Generate unique filename
		id := uuid.New().String()
		storedName := id + ext
		destPath := filepath.Join(h.uploadDir, storedName)

		dst, err := os.Create(destPath)
		if err != nil {
			middleware.WriteError(w, http.StatusInternalServerError, "failed to save file", "SAVE_FAILED")
			return
		}
		defer dst.Close()

		// Write the already-read bytes, then the rest
		if _, err := dst.Write(buf[:n]); err != nil {
			middleware.WriteError(w, http.StatusInternalServerError, "failed to write file", "WRITE_FAILED")
			return
		}
		if _, err := io.Copy(dst, file); err != nil {
			middleware.WriteError(w, http.StatusInternalServerError, "failed to write file", "WRITE_FAILED")
			return
		}

		attachments = append(attachments, models.Attachment{
			ID:       id,
			Filename: fh.Filename,
			URL:      "/uploads/" + storedName,
			MimeType: detectedCT,
			Size:     fh.Size,
		})
	}

	middleware.WriteJSON(w, http.StatusOK, attachments)
}

// ServeWithDisposition wraps a file server to force Content-Disposition: attachment,
// preventing browsers from executing uploaded files inline.
func ServeWithDisposition(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Force download — never allow inline execution of uploaded files
		w.Header().Set("Content-Disposition", "attachment")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		fs.ServeHTTP(w, r)
	})
}

// isBinary checks if content appears to be binary (used by filesystem handler).
func isBinary(content []byte) bool {
	check := content
	if len(check) > 512 {
		check = check[:512]
	}
	return bytes.ContainsRune(check, 0)
}
