package services

import (
	"context"
	"fmt"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const apiKeyPrefix = "vk_"

// APIKeyService manages named API keys for programmatic access.
type APIKeyService struct {
	col *mongo.Collection
}

func NewAPIKeyService(db *mongo.Database) *APIKeyService {
	return &APIKeyService{col: db.Collection("api_keys")}
}

// Create generates a new API key for the given user.
// Returns the key view and the raw token (shown once, never stored).
func (s *APIKeyService) Create(ctx context.Context, userID bson.ObjectID, name string) (*models.APIKeyView, string, error) {
	raw, err := generateToken()
	if err != nil {
		return nil, "", fmt.Errorf("generate token: %w", err)
	}
	token := apiKeyPrefix + raw
	hash := hashToken(token)

	key := models.APIKey{
		UserID:    userID,
		Name:      name,
		TokenHash: hash,
		CreatedAt: time.Now().UTC(),
	}
	res, err := s.col.InsertOne(ctx, key)
	if err != nil {
		return nil, "", err
	}
	key.ID = res.InsertedID.(bson.ObjectID)
	return &models.APIKeyView{ID: key.ID, Name: key.Name, CreatedAt: key.CreatedAt}, token, nil
}

// ListForUser returns all API keys owned by the given user (without token hashes).
func (s *APIKeyService) ListForUser(ctx context.Context, userID bson.ObjectID) ([]models.APIKeyView, error) {
	cur, err := s.col.Find(ctx, bson.M{"userId": userID})
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)

	var views []models.APIKeyView
	for cur.Next(ctx) {
		var k models.APIKey
		if err := cur.Decode(&k); err != nil {
			continue
		}
		view := models.APIKeyView{ID: k.ID, Name: k.Name, CreatedAt: k.CreatedAt, LastUsedAt: k.LastUsedAt}
		views = append(views, view)
	}
	if views == nil {
		views = []models.APIKeyView{}
	}
	return views, nil
}

// Revoke deletes an API key by ID, only if it belongs to the given user.
func (s *APIKeyService) Revoke(ctx context.Context, keyID, userID bson.ObjectID) error {
	res, err := s.col.DeleteOne(ctx, bson.M{"_id": keyID, "userId": userID})
	if err != nil {
		return err
	}
	if res.DeletedCount == 0 {
		return fmt.Errorf("not found or not yours")
	}
	return nil
}

// Verify looks up the API key by its hash and returns the owning user (updating lastUsedAt).
// Returns nil if not found.
func (s *APIKeyService) Verify(ctx context.Context, token string, userSvc *UserService) (*models.User, error) {
	hash := hashToken(token)
	var key models.APIKey
	if err := s.col.FindOne(ctx, bson.M{"tokenHash": hash}).Decode(&key); err != nil {
		return nil, nil //nolint:nilerr
	}

	// Update lastUsedAt asynchronously (best-effort, don't block the request)
	now := time.Now().UTC()
	go func() {
		_, _ = s.col.UpdateOne(context.Background(), bson.M{"_id": key.ID},
			bson.M{"$set": bson.M{"lastUsedAt": now}},
			options.UpdateOne())
	}()

	return userSvc.GetByID(ctx, key.UserID)
}

// IsAPIKeyToken reports whether the raw token string looks like an API key.
func IsAPIKeyToken(token string) bool {
	return len(token) > len(apiKeyPrefix) && token[:len(apiKeyPrefix)] == apiKeyPrefix
}
