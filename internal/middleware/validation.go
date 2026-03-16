package middleware

import (
	"encoding/json"
	"net/http"
)

type APIError struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func WriteError(w http.ResponseWriter, status int, message, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(APIError{Error: message, Code: code})
}

func WriteJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
