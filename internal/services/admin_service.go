package services

import (
	"context"
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

// AdminService manages the legacy single-admin account for CLI backward compatibility.
// New code should use UserService + AuthSessionService instead.
type AdminService struct {
	collection *mongo.Collection
}

func NewAdminService(db *mongo.Database) *AdminService {
	return &AdminService{collection: db.Collection("admin")}
}

// GetPasswordHash returns the stored bcrypt hash from the legacy admin doc, or "" if none.
// Used during startup migration to seed the users collection.
func (s *AdminService) GetPasswordHash(ctx context.Context) (string, error) {
	var doc adminDoc
	err := s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: adminDocID}}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("check admin: %w", err)
	}
	return doc.PasswordHash, nil
}

// HasPassword returns true if an admin password has been configured.
func (s *AdminService) HasPassword(ctx context.Context) (bool, error) {
	hash, err := s.GetPasswordHash(ctx)
	return hash != "", err
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
	rawToken, err := generateToken()
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
	rawToken, err := generateToken()
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
		return false, nil
	}
	return true, nil
}
