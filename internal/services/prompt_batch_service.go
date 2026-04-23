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

type PromptBatchService struct {
	collection *mongo.Collection
}

func NewPromptBatchService(db *mongo.Database) *PromptBatchService {
	return &PromptBatchService{collection: db.Collection("prompt_batches")}
}

func (s *PromptBatchService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "projectCode", Value: 1}, {Key: "createdAt", Value: -1}}},
	})
	return err
}

func (s *PromptBatchService) Create(ctx context.Context, batch *models.PromptBatch) error {
	batch.CreatedAt = time.Now().UTC()
	result, err := s.collection.InsertOne(ctx, batch)
	if err != nil {
		return fmt.Errorf("insert prompt batch: %w", err)
	}
	batch.ID = result.InsertedID.(bson.ObjectID)
	return nil
}

func (s *PromptBatchService) GetByID(ctx context.Context, id string) (*models.PromptBatch, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, fmt.Errorf("invalid batch ID: %w", err)
	}
	var batch models.PromptBatch
	err = s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: oid}}).Decode(&batch)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("find prompt batch: %w", err)
	}
	return &batch, nil
}

func (s *PromptBatchService) ListByProject(ctx context.Context, projectCode string, limit int) ([]models.PromptBatch, error) {
	if limit <= 0 {
		limit = 20
	}
	opts := options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(int64(limit))
	cursor, err := s.collection.Find(ctx, bson.D{{Key: "projectCode", Value: projectCode}}, opts)
	if err != nil {
		return nil, fmt.Errorf("list prompt batches: %w", err)
	}
	defer cursor.Close(ctx)
	var batches []models.PromptBatch
	if err := cursor.All(ctx, &batches); err != nil {
		return nil, fmt.Errorf("decode prompt batches: %w", err)
	}
	return batches, nil
}
