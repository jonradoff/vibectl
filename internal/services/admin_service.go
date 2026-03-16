package services

import (
	"context"
	"crypto/rand"
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
	ID           string    `bson:"_id"`
	PasswordHash string    `bson:"passwordHash,omitempty"`
	Token        string    `bson:"token,omitempty"`
	UpdatedAt    time.Time `bson:"updatedAt"`
}

// AdminService manages the single admin account stored in MongoDB.
// The password is bcrypt-hashed. A session token is stored in MongoDB and
// validated on each authenticated request — the password itself never touches disk.
type AdminService struct {
	collection *mongo.Collection
}

func NewAdminService(db *mongo.Database) *AdminService {
	return &AdminService{collection: db.Collection("admin")}
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
// Returns the new session token.
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
	token, err := generateAdminToken()
	if err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}

	newDoc := adminDoc{
		ID:           adminDocID,
		PasswordHash: string(hash),
		Token:        token,
		UpdatedAt:    time.Now().UTC(),
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
	return token, nil
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
	token, err := generateAdminToken()
	if err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	_, err = s.collection.UpdateOne(
		ctx,
		bson.D{{Key: "_id", Value: adminDocID}},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "token", Value: token},
			{Key: "updatedAt", Value: time.Now().UTC()},
		}}},
	)
	if err != nil {
		return "", fmt.Errorf("save token: %w", err)
	}
	return token, nil
}

// VerifyToken checks whether the given Bearer token matches the stored session token.
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
	return doc.Token != "" && doc.Token == token, nil
}

func generateAdminToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
