package services

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const sessionTTL = 30 * 24 * time.Hour

// AuthSessionService manages per-user authentication sessions in the `auth_sessions` collection.
type AuthSessionService struct {
	col     *mongo.Collection
	userSvc *UserService
}

func NewAuthSessionService(db *mongo.Database, userSvc *UserService) *AuthSessionService {
	return &AuthSessionService{col: db.Collection("auth_sessions"), userSvc: userSvc}
}

func (s *AuthSessionService) EnsureIndexes(ctx context.Context) error {
	_, err := s.col.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "tokenHash", Value: 1}}, Options: options.Index().SetUnique(true)},
		{Keys: bson.D{{Key: "userId", Value: 1}}},
		// TTL index: MongoDB auto-deletes expired sessions
		{Keys: bson.D{{Key: "expiresAt", Value: 1}}, Options: options.Index().SetExpireAfterSeconds(0)},
	})
	return err
}

// Create generates a new session for the given user and returns the raw token.
// The raw token is returned once and never stored — only its SHA-256 hash is in the DB.
func (s *AuthSessionService) Create(ctx context.Context, userID bson.ObjectID, r *http.Request) (string, error) {
	raw, err := generateToken()
	if err != nil {
		return "", fmt.Errorf("generating token: %w", err)
	}
	now := time.Now().UTC()
	session := models.AuthSession{
		UserID:    userID,
		TokenHash: hashToken(raw),
		CreatedAt: now,
		ExpiresAt: now.Add(sessionTTL),
	}
	if r != nil {
		session.UserAgent = r.UserAgent()
		session.IP = extractIP(r)
	}
	if _, err := s.col.InsertOne(ctx, session); err != nil {
		return "", fmt.Errorf("inserting session: %w", err)
	}
	return raw, nil
}

// Verify looks up the session by token hash, checks expiry, and returns the owning User.
// Returns nil, nil if the token is invalid or expired.
func (s *AuthSessionService) Verify(ctx context.Context, rawToken string) (*models.User, error) {
	if rawToken == "" {
		return nil, nil
	}
	var session models.AuthSession
	err := s.col.FindOne(ctx, bson.D{
		{Key: "tokenHash", Value: hashToken(rawToken)},
		{Key: "expiresAt", Value: bson.D{{Key: "$gt", Value: time.Now().UTC()}}},
	}).Decode(&session)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s.userSvc.GetByID(ctx, session.UserID)
}

// Revoke deletes the session identified by raw token.
func (s *AuthSessionService) Revoke(ctx context.Context, rawToken string) error {
	_, err := s.col.DeleteOne(ctx, bson.D{{Key: "tokenHash", Value: hashToken(rawToken)}})
	return err
}

// RevokeAllForUser deletes all sessions belonging to a user.
func (s *AuthSessionService) RevokeAllForUser(ctx context.Context, userID bson.ObjectID) error {
	_, err := s.col.DeleteMany(ctx, bson.D{{Key: "userId", Value: userID}})
	return err
}

func extractIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return xff
	}
	return r.RemoteAddr
}
