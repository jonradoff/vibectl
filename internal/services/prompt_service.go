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
		Keys: bson.D{{Key: "projectCode", Value: 1}, {Key: "name", Value: 1}},
	})
	return err
}

// Create creates a prompt with ownership tracking.
func (s *PromptService) Create(ctx context.Context, projectCode string, req *models.CreatePromptRequest, userID *bson.ObjectID, userName string) (*models.Prompt, error) {
	now := time.Now().UTC()
	p := &models.Prompt{
		Name:        req.Name,
		Body:        req.Body,
		CreatedBy:   userID,
		CreatorName: userName,
		Shared:      req.Shared,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	if projectCode == "*" || projectCode == "" {
		p.Global = true
		p.ProjectCode = ""
	} else {
		p.ProjectCode = projectCode
		p.Global = false
	}

	res, err := s.collection.InsertOne(ctx, p)
	if err != nil {
		return nil, fmt.Errorf("insert prompt: %w", err)
	}
	p.ID = res.InsertedID.(bson.ObjectID)
	return p, nil
}

// ListByProject returns prompts the user can see: shared prompts + user's own personal prompts.
func (s *PromptService) ListByProject(ctx context.Context, projectCode string, userID *bson.ObjectID) ([]models.Prompt, error) {
	// Scope: project-specific OR global
	scopeFilter := bson.A{
		bson.D{{Key: "projectCode", Value: projectCode}},
		bson.D{{Key: "global", Value: true}},
	}

	// Visibility: shared prompts OR user's own prompts OR legacy prompts (no createdBy field)
	visFilter := bson.A{
		bson.D{{Key: "shared", Value: true}},
		bson.D{{Key: "createdBy", Value: bson.D{{Key: "$exists", Value: false}}}}, // legacy prompts
	}
	if userID != nil {
		visFilter = append(visFilter, bson.D{{Key: "createdBy", Value: *userID}})
	}

	filter := bson.D{
		{Key: "$or", Value: scopeFilter},
		{Key: "$or", Value: visFilter},
	}
	// MongoDB doesn't allow two $or at the top level in the same doc. Use $and.
	filter = bson.D{{Key: "$and", Value: bson.A{
		bson.D{{Key: "$or", Value: scopeFilter}},
		bson.D{{Key: "$or", Value: visFilter}},
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

// ListAll returns all prompts the user can see.
func (s *PromptService) ListAll(ctx context.Context, userID *bson.ObjectID) ([]models.Prompt, error) {
	visFilter := bson.A{
		bson.D{{Key: "shared", Value: true}},
		bson.D{{Key: "createdBy", Value: bson.D{{Key: "$exists", Value: false}}}},
	}
	if userID != nil {
		visFilter = append(visFilter, bson.D{{Key: "createdBy", Value: *userID}})
	}
	filter := bson.D{{Key: "$or", Value: visFilter}}

	opts := options.Find().SetSort(bson.D{{Key: "global", Value: -1}, {Key: "name", Value: 1}})
	cursor, err := s.collection.Find(ctx, filter, opts)
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

// CountByProject returns the total number of prompts for a given project (including global prompts scoped to it).
func (s *PromptService) CountByProject(ctx context.Context, projectCode string) (int, error) {
	filter := bson.D{{Key: "$or", Value: bson.A{
		bson.D{{Key: "projectCode", Value: projectCode}},
		bson.D{{Key: "global", Value: true}},
	}}}
	n, err := s.collection.CountDocuments(ctx, filter)
	if err != nil {
		return 0, fmt.Errorf("count prompts: %w", err)
	}
	return int(n), nil
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
	if req.Shared != nil {
		set = append(set, bson.E{Key: "shared", Value: *req.Shared})
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
