package services

import (
	"context"
	"fmt"
	"regexp"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/jonradoff/vibectl/internal/models"
)

var codePattern = regexp.MustCompile(`^[A-Z]{3,5}$`)

type ProjectService struct {
	db         *mongo.Database
	collection *mongo.Collection
}

func NewProjectService(db *mongo.Database) *ProjectService {
	return &ProjectService{
		db:         db,
		collection: db.Collection("projects"),
	}
}

// EnsureIndexes creates a unique index on the code field.
func (s *ProjectService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "code", Value: 1}},
		Options: options.Index().SetUnique(true),
	})
	return err
}

// List returns all non-archived projects, ordered by creation time descending.
func (s *ProjectService) List(ctx context.Context) ([]models.Project, error) {
	filter := bson.D{{Key: "archived", Value: bson.D{{Key: "$ne", Value: true}}}}
	opts := options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}})
	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("find projects: %w", err)
	}
	defer cursor.Close(ctx)

	var projects []models.Project
	if err := cursor.All(ctx, &projects); err != nil {
		return nil, fmt.Errorf("decode projects: %w", err)
	}
	if projects == nil {
		projects = []models.Project{}
	}
	return projects, nil
}

// ListArchived returns all archived projects, ordered by updatedAt descending.
func (s *ProjectService) ListArchived(ctx context.Context) ([]models.Project, error) {
	filter := bson.D{{Key: "archived", Value: true}}
	opts := options.Find().SetSort(bson.D{{Key: "updatedAt", Value: -1}})
	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("find archived projects: %w", err)
	}
	defer cursor.Close(ctx)

	var projects []models.Project
	if err := cursor.All(ctx, &projects); err != nil {
		return nil, fmt.Errorf("decode archived projects: %w", err)
	}
	if projects == nil {
		projects = []models.Project{}
	}
	return projects, nil
}

// Archive sets a project's archived flag to true.
func (s *ProjectService) Archive(ctx context.Context, id string) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid project ID: %w", err)
	}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "archived", Value: true},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}}
	result, err := s.collection.UpdateByID(ctx, oid, update)
	if err != nil {
		return fmt.Errorf("archive project: %w", err)
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("project not found")
	}
	return nil
}

// Unarchive sets a project's archived flag to false.
func (s *ProjectService) Unarchive(ctx context.Context, id string) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid project ID: %w", err)
	}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "archived", Value: false},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}}
	result, err := s.collection.UpdateByID(ctx, oid, update)
	if err != nil {
		return fmt.Errorf("unarchive project: %w", err)
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("project not found")
	}
	return nil
}

// Create validates the request and inserts a new project.
func (s *ProjectService) Create(ctx context.Context, req *models.CreateProjectRequest) (*models.Project, error) {
	if req.Name == "" {
		return nil, fmt.Errorf("project name is required")
	}
	if req.Code == "" {
		return nil, fmt.Errorf("project code is required")
	}
	if !codePattern.MatchString(req.Code) {
		return nil, fmt.Errorf("project code must be 3-5 uppercase letters")
	}

	// Check uniqueness of code.
	count, err := s.collection.CountDocuments(ctx, bson.D{{Key: "code", Value: req.Code}})
	if err != nil {
		return nil, fmt.Errorf("check code uniqueness: %w", err)
	}
	if count > 0 {
		return nil, fmt.Errorf("project with code %q already exists", req.Code)
	}

	now := time.Now().UTC()
	goals := req.Goals
	if goals == nil {
		goals = []string{}
	}

	project := models.Project{
		Name:         req.Name,
		Code:         req.Code,
		Description:  req.Description,
		Links:        req.Links,
		Goals:        goals,
		IssueCounter: 0,
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	result, err := s.collection.InsertOne(ctx, project)
	if err != nil {
		return nil, fmt.Errorf("insert project: %w", err)
	}

	project.ID = result.InsertedID.(bson.ObjectID)
	return &project, nil
}

// GetByID retrieves a project by its ObjectID hex string.
func (s *ProjectService) GetByID(ctx context.Context, id string) (*models.Project, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, fmt.Errorf("invalid project ID: %w", err)
	}

	var project models.Project
	err = s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: oid}}).Decode(&project)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("project not found")
		}
		return nil, fmt.Errorf("find project: %w", err)
	}
	return &project, nil
}

// GetByCode retrieves a project by its unique code.
func (s *ProjectService) GetByCode(ctx context.Context, code string) (*models.Project, error) {
	var project models.Project
	err := s.collection.FindOne(ctx, bson.D{{Key: "code", Value: code}}).Decode(&project)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("project not found")
		}
		return nil, fmt.Errorf("find project by code: %w", err)
	}
	return &project, nil
}

// Update applies partial updates to a project identified by its ObjectID hex string.
func (s *ProjectService) Update(ctx context.Context, id string, req *models.UpdateProjectRequest) (*models.Project, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, fmt.Errorf("invalid project ID: %w", err)
	}

	setFields := bson.D{
		{Key: "updatedAt", Value: time.Now().UTC()},
	}
	if req.Name != nil {
		setFields = append(setFields, bson.E{Key: "name", Value: *req.Name})
	}
	if req.Description != nil {
		setFields = append(setFields, bson.E{Key: "description", Value: *req.Description})
	}
	if req.Links != nil {
		setFields = append(setFields, bson.E{Key: "links", Value: *req.Links})
	}
	if req.Goals != nil {
		setFields = append(setFields, bson.E{Key: "goals", Value: *req.Goals})
	}
	if req.HealthCheck != nil {
		setFields = append(setFields, bson.E{Key: "healthCheck", Value: *req.HealthCheck})
	}
	if req.Deployment != nil {
		setFields = append(setFields, bson.E{Key: "deployment", Value: *req.Deployment})
	}

	update := bson.D{{Key: "$set", Value: setFields}}

	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var project models.Project
	err = s.collection.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: oid}}, update, opts).Decode(&project)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("project not found")
		}
		return nil, fmt.Errorf("update project: %w", err)
	}
	return &project, nil
}

// Delete removes a project by its ObjectID hex string.
func (s *ProjectService) Delete(ctx context.Context, id string) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid project ID: %w", err)
	}

	result, err := s.collection.DeleteOne(ctx, bson.D{{Key: "_id", Value: oid}})
	if err != nil {
		return fmt.Errorf("delete project: %w", err)
	}
	if result.DeletedCount == 0 {
		return fmt.Errorf("project not found")
	}
	return nil
}

// UpdateRecurringThemes sets the recurring themes for a project.
func (s *ProjectService) UpdateRecurringThemes(ctx context.Context, id string, themes []models.RecurringTheme) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid project ID: %w", err)
	}
	_, err = s.collection.UpdateByID(ctx, oid, bson.D{{Key: "$set", Value: bson.D{
		{Key: "recurringThemes", Value: themes},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}})
	return err
}

// UpdateArchitectureSummary sets the architecture summary for a project.
func (s *ProjectService) UpdateArchitectureSummary(ctx context.Context, id string, summary string) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid project ID: %w", err)
	}
	now := time.Now().UTC()
	_, err = s.collection.UpdateByID(ctx, oid, bson.D{{Key: "$set", Value: bson.D{
		{Key: "architectureSummary", Value: summary},
		{Key: "architectureUpdatedAt", Value: now},
		{Key: "updatedAt", Value: now},
	}}})
	return err
}

// SetVibectlMdGeneratedAt updates the timestamp of last VIBECTL.md generation.
func (s *ProjectService) SetVibectlMdGeneratedAt(ctx context.Context, id string, t time.Time) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid project ID: %w", err)
	}
	_, err = s.collection.UpdateByID(ctx, oid, bson.D{{Key: "$set", Value: bson.D{
		{Key: "vibectlMdGeneratedAt", Value: t},
	}}})
	return err
}

// IncrementCounter atomically increments the project's issueCounter and returns the new value.
func (s *ProjectService) IncrementCounter(ctx context.Context, projectID bson.ObjectID) (int, error) {
	update := bson.D{{Key: "$inc", Value: bson.D{{Key: "issueCounter", Value: 1}}}}
	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)

	var project models.Project
	err := s.collection.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: projectID}}, update, opts).Decode(&project)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return 0, fmt.Errorf("project not found")
		}
		return 0, fmt.Errorf("increment counter: %w", err)
	}
	return project.IssueCounter, nil
}
