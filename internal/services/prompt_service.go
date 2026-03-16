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

type PromptService struct {
	collection *mongo.Collection
}

func NewPromptService(db *mongo.Database) *PromptService {
	return &PromptService{collection: db.Collection("prompts")}
}

func (s *PromptService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{{Key: "projectId", Value: 1}, {Key: "name", Value: 1}},
	})
	return err
}

// Create creates a prompt. If projectID is "*" or empty, creates a global prompt.
func (s *PromptService) Create(ctx context.Context, projectID string, req *models.CreatePromptRequest) (*models.Prompt, error) {
	now := time.Now().UTC()
	p := &models.Prompt{
		Name:      req.Name,
		Body:      req.Body,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if projectID == "*" || projectID == "" {
		p.Global = true
		p.ProjectID = nil
	} else {
		oid, err := bson.ObjectIDFromHex(projectID)
		if err != nil {
			return nil, fmt.Errorf("invalid project ID: %w", err)
		}
		p.ProjectID = &oid
		p.Global = false
	}

	res, err := s.collection.InsertOne(ctx, p)
	if err != nil {
		return nil, fmt.Errorf("insert prompt: %w", err)
	}
	p.ID = res.InsertedID.(bson.ObjectID)
	return p, nil
}

// ListByProject returns prompts for the given project PLUS all global prompts.
func (s *PromptService) ListByProject(ctx context.Context, projectID string) ([]models.Prompt, error) {
	oid, err := bson.ObjectIDFromHex(projectID)
	if err != nil {
		return nil, fmt.Errorf("invalid project ID: %w", err)
	}
	// Match project-specific OR global
	filter := bson.D{{Key: "$or", Value: bson.A{
		bson.D{{Key: "projectId", Value: oid}},
		bson.D{{Key: "global", Value: true}},
	}}}
	opts := options.Find().SetSort(bson.D{{Key: "global", Value: -1}, {Key: "name", Value: 1}})
	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("find prompts: %w", err)
	}
	defer cursor.Close(ctx)
	var results []models.Prompt
	if err := cursor.All(ctx, &results); err != nil {
		return nil, fmt.Errorf("decode prompts: %w", err)
	}
	if results == nil {
		results = []models.Prompt{}
	}
	return results, nil
}

func (s *PromptService) ListAll(ctx context.Context) ([]models.Prompt, error) {
	opts := options.Find().SetSort(bson.D{{Key: "global", Value: -1}, {Key: "name", Value: 1}})
	cursor, err := s.collection.Find(ctx, bson.D{}, opts)
	if err != nil {
		return nil, fmt.Errorf("find all prompts: %w", err)
	}
	defer cursor.Close(ctx)
	var results []models.Prompt
	if err := cursor.All(ctx, &results); err != nil {
		return nil, fmt.Errorf("decode prompts: %w", err)
	}
	if results == nil {
		results = []models.Prompt{}
	}
	return results, nil
}

func (s *PromptService) GetByID(ctx context.Context, id string) (*models.Prompt, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, fmt.Errorf("invalid prompt ID: %w", err)
	}
	var p models.Prompt
	if err := s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: oid}}).Decode(&p); err != nil {
		return nil, fmt.Errorf("prompt not found: %w", err)
	}
	return &p, nil
}

func (s *PromptService) Update(ctx context.Context, id string, req *models.UpdatePromptRequest) (*models.Prompt, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, fmt.Errorf("invalid prompt ID: %w", err)
	}
	set := bson.D{{Key: "updatedAt", Value: time.Now().UTC()}}
	if req.Name != "" {
		set = append(set, bson.E{Key: "name", Value: req.Name})
	}
	if req.Body != "" {
		set = append(set, bson.E{Key: "body", Value: req.Body})
	}
	after := options.After
	opts := options.FindOneAndUpdate().SetReturnDocument(after)
	var p models.Prompt
	if err := s.collection.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: oid}}, bson.D{{Key: "$set", Value: set}}, opts).Decode(&p); err != nil {
		return nil, fmt.Errorf("update prompt: %w", err)
	}
	return &p, nil
}

func (s *PromptService) Delete(ctx context.Context, id string) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid prompt ID: %w", err)
	}
	res, err := s.collection.DeleteOne(ctx, bson.D{{Key: "_id", Value: oid}})
	if err != nil {
		return fmt.Errorf("delete prompt: %w", err)
	}
	if res.DeletedCount == 0 {
		return fmt.Errorf("prompt not found")
	}
	return nil
}
