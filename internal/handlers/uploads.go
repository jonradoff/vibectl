package handlers

import (
	"encoding/json"
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
		// Validate mime type
		ct := fh.Header.Get("Content-Type")
		if !strings.HasPrefix(ct, "image/") {
			middleware.WriteError(w, http.StatusBadRequest, fmt.Sprintf("invalid file type: %s (only images allowed)", ct), "INVALID_TYPE")
			return
		}

		file, err := fh.Open()
		if err != nil {
			middleware.WriteError(w, http.StatusInternalServerError, "failed to read file", "READ_FAILED")
			return
		}
		defer file.Close()

		// Generate unique filename preserving extension
		ext := filepath.Ext(fh.Filename)
		id := uuid.New().String()
		storedName := id + ext
		destPath := filepath.Join(h.uploadDir, storedName)

		dst, err := os.Create(destPath)
		if err != nil {
			middleware.WriteError(w, http.StatusInternalServerError, "failed to save file", "SAVE_FAILED")
			return
		}
		defer dst.Close()

		if _, err := io.Copy(dst, file); err != nil {
			middleware.WriteError(w, http.StatusInternalServerError, "failed to write file", "WRITE_FAILED")
			return
		}

		attachments = append(attachments, models.Attachment{
			ID:       id,
			Filename: fh.Filename,
			URL:      "/uploads/" + storedName,
			MimeType: ct,
			Size:     fh.Size,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(attachments)
}
