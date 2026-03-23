package services

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
)

// hashToken returns the hex-encoded SHA-256 of a raw token string.
// Centralised here so both AdminService and AuthSessionService use the same function.
func hashToken(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}

// generateToken creates a random 32-byte hex-encoded token (64 chars).
func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// encryptString encrypts plaintext using AES-256-GCM with the given key.
// The key is hashed to exactly 32 bytes so any length key works.
// Returns hex(nonce + ciphertext).
func encryptString(key, plaintext string) (string, error) {
	if key == "" {
		return "", errors.New("encryption key not configured")
	}
	k := sha256.Sum256([]byte(key))
	block, err := aes.NewCipher(k[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ct := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return hex.EncodeToString(ct), nil
}

// decryptString reverses encryptString.
func decryptString(key, cipherHex string) (string, error) {
	if key == "" {
		return "", errors.New("encryption key not configured")
	}
	data, err := hex.DecodeString(cipherHex)
	if err != nil {
		return "", err
	}
	k := sha256.Sum256([]byte(key))
	block, err := aes.NewCipher(k[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	ns := gcm.NonceSize()
	if len(data) < ns {
		return "", errors.New("ciphertext too short")
	}
	pt, err := gcm.Open(nil, data[:ns], data[ns:], nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}
