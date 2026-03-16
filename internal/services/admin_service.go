package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"golang.org/x/crypto/bcrypt"
)

const adminDocID = "admin"

type adminDoc struct {
	ID             string    `bson:"_id"`
	PasswordHash   string    `bson:"passwordHash,omitempty"`
	TokenHash      string    `bson:"tokenHash,omitempty"` // SHA-256 of the raw token (never stored in plaintext)
	TokenCreatedAt time.Time `bson:"tokenCreatedAt,omitempty"`
	UpdatedAt      time.Time `bson:"updatedAt"`
}

// AdminService manages the single admin account stored in MongoDB.
// The password is bcrypt-hashed. Session tokens are stored as SHA-256 hashes —
// the raw token is only ever held in memory and returned to the client once.
type AdminService struct {
	collection *mongo.Collection
}

func NewAdminService(db *mongo.Database) *AdminService {
	return &AdminService{collection: db.Collection("admin")}
}

// hashToken returns the hex-encoded SHA-256 of a raw token string.
func hashToken(rawToken string) string {
	h := sha256.Sum256([]byte(rawToken))
	return hex.EncodeToString(h[:])
}

// HasPassword returns true if an admin password has been configured.
func (s *AdminService) HasPassword(ctx context.Context) (bool, error) {
	var doc adminDoc
	err := s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: adminDocID}}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check admin: %w", err)
	}
	return doc.PasswordHash != "", nil
}

// SetPassword hashes a new password and stores it, generating a fresh session token.
// If no admin account exists, one is created (bootstrap mode).
// Returns the new session token (raw; not stored).
func (s *AdminService) SetPassword(ctx context.Context, currentPassword, newPassword string) (string, error) {
	var doc adminDoc
	err := s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: adminDocID}}).Decode(&doc)
	notFound := err == mongo.ErrNoDocuments
	if err != nil && !notFound {
		return "", fmt.Errorf("lookup admin: %w", err)
	}

	// If a password is already set, verify the current one.
	if !notFound && doc.PasswordHash != "" {
		if err := bcrypt.CompareHashAndPassword([]byte(doc.PasswordHash), []byte(currentPassword)); err != nil {
			return "", fmt.Errorf("current password is incorrect")
		}
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	rawToken, err := generateAdminToken()
	if err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}

	newDoc := adminDoc{
		ID:             adminDocID,
		PasswordHash:   string(hash),
		TokenHash:      hashToken(rawToken),
		TokenCreatedAt: time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	_, err = s.collection.ReplaceOne(
		ctx,
		bson.D{{Key: "_id", Value: adminDocID}},
		newDoc,
		options.Replace().SetUpsert(true),
	)
	if err != nil {
		return "", fmt.Errorf("save admin: %w", err)
	}
	return rawToken, nil
}

// Login verifies the password and returns a session token (rotating it each login).
func (s *AdminService) Login(ctx context.Context, password string) (string, error) {
	var doc adminDoc
	err := s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: adminDocID}}).Decode(&doc)
	if err == mongo.ErrNoDocuments || doc.PasswordHash == "" {
		return "", fmt.Errorf("no admin password set; run: vibectl admin set-password")
	}
	if err != nil {
		return "", fmt.Errorf("lookup admin: %w", err)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(doc.PasswordHash), []byte(password)); err != nil {
		return "", fmt.Errorf("invalid password")
	}

	// Rotate token on each successful login.
	rawToken, err := generateAdminToken()
	if err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	_, err = s.collection.UpdateOne(
		ctx,
		bson.D{{Key: "_id", Value: adminDocID}},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "tokenHash", Value: hashToken(rawToken)},
			{Key: "tokenCreatedAt", Value: time.Now().UTC()},
			{Key: "updatedAt", Value: time.Now().UTC()},
		}}},
	)
	if err != nil {
		return "", fmt.Errorf("save token: %w", err)
	}
	return rawToken, nil
}

// VerifyToken checks whether the given Bearer token is valid and unexpired.
// The incoming token is hashed before comparison — the DB never holds plaintext tokens.
func (s *AdminService) VerifyToken(ctx context.Context, token string) (bool, error) {
	if token == "" {
		return false, nil
	}
	var doc adminDoc
	err := s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: adminDocID}}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("lookup admin: %w", err)
	}
	if doc.TokenHash == "" || doc.TokenHash != hashToken(token) {
		return false, nil
	}
	if !doc.TokenCreatedAt.IsZero() && time.Since(doc.TokenCreatedAt) > 30*24*time.Hour {
		return false, nil // token expired
	}
	return true, nil
}

func generateAdminToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
