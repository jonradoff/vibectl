package services

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/jonradoff/vibectl/internal/models"
)

// SettingsService manages application-wide settings.
type SettingsService struct {
	db *mongo.Database
}

// NewSettingsService creates a new SettingsService.
func NewSettingsService(db *mongo.Database) *SettingsService {
	return &SettingsService{db: db}
}

func (s *SettingsService) collection() *mongo.Collection {
	return s.db.Collection("settings")
}

// EnsureIndexes — no special indexes needed for the settings singleton.
func (s *SettingsService) EnsureIndexes(_ context.Context) error {
	return nil
}

// Get retrieves the singleton settings document, returning defaults if none exists.
func (s *SettingsService) Get(ctx context.Context) (*models.Settings, error) {
	var settings models.Settings
	err := s.collection().FindOne(ctx, bson.D{}).Decode(&settings)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			// Return defaults
			return &models.Settings{
				VibectlMdAutoRegen: false,
				VibectlMdSchedule:  "",
				UpdatedAt:          time.Now().UTC(),
			}, nil
		}
		return nil, fmt.Errorf("get settings: %w", err)
	}
	return &settings, nil
}

// Update upserts the singleton settings document.
func (s *SettingsService) Update(ctx context.Context, settings *models.Settings) error {
	settings.UpdatedAt = time.Now().UTC()
	update := bson.D{{Key: "$set", Value: settings}}
	opts := options.UpdateOne().SetUpsert(true)
	_, err := s.collection().UpdateOne(ctx, bson.D{}, update, opts)
	if err != nil {
		return fmt.Errorf("update settings: %w", err)
	}
	return nil
}
