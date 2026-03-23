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

// IssueService manages issue CRUD and queries.
type IssueService struct {
	db       *mongo.Database
	projects *ProjectService
}

// NewIssueService creates a new IssueService.
func NewIssueService(db *mongo.Database, projects *ProjectService) *IssueService {
	return &IssueService{db: db, projects: projects}
}

func (s *IssueService) collection() *mongo.Collection {
	return s.db.Collection("issues")
}

// ListByProject returns issues for a project, optionally filtered by type, priority, and status.
func (s *IssueService) ListByProject(ctx context.Context, projectID string, filters map[string]string) ([]models.Issue, error) {
	pid, err := bson.ObjectIDFromHex(projectID)
	if err != nil {
		return nil, fmt.Errorf("invalid project ID: %w", err)
	}

	filter := bson.D{
		{Key: "projectId", Value: pid},
		{Key: "archived", Value: bson.D{{Key: "$ne", Value: true}}},
	}
	if v, ok := filters["type"]; ok && v != "" {
		filter = append(filter, bson.E{Key: "type", Value: v})
	}
	if v, ok := filters["priority"]; ok && v != "" {
		filter = append(filter, bson.E{Key: "priority", Value: v})
	}
	if v, ok := filters["status"]; ok && v != "" {
		filter = append(filter, bson.E{Key: "status", Value: v})
	}

	opts := options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}})
	cursor, err := s.collection().Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("finding issues: %w", err)
	}
	defer cursor.Close(ctx)

	var issues []models.Issue
	if err := cursor.All(ctx, &issues); err != nil {
		return nil, fmt.Errorf("decoding issues: %w", err)
	}
	if issues == nil {
		issues = []models.Issue{}
	}
	return issues, nil
}

// Create creates a new issue within a transaction, incrementing the project counter atomically.
func (s *IssueService) Create(ctx context.Context, projectID string, req *models.CreateIssueRequest) (*models.Issue, error) {
	if !models.ValidIssueType(string(req.Type)) {
		return nil, fmt.Errorf("invalid issue type: %s", req.Type)
	}
	if !models.ValidPriority(string(req.Priority)) {
		return nil, fmt.Errorf("invalid priority: %s", req.Priority)
	}
	if req.Type == models.IssueTypeBug && req.ReproSteps == "" {
		return nil, fmt.Errorf("reproSteps should be provided for bug issues")
	}

	pid, err := bson.ObjectIDFromHex(projectID)
	if err != nil {
		return nil, fmt.Errorf("invalid project ID: %w", err)
	}

	project, err := s.projects.GetByID(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("getting project: %w", err)
	}

	var dueDate *time.Time
	if req.DueDate != "" {
		t, err := time.Parse(time.RFC3339, req.DueDate)
		if err != nil {
			t, err = time.Parse("2006-01-02", req.DueDate)
			if err != nil {
				return nil, fmt.Errorf("invalid dueDate format: %w", err)
			}
		}
		dueDate = &t
	}

	var issue models.Issue

	sess, err := s.db.Client().StartSession()
	if err != nil {
		return nil, fmt.Errorf("starting session: %w", err)
	}
	defer sess.EndSession(ctx)

	_, err = sess.WithTransaction(ctx, func(ctx context.Context) (interface{}, error) {
		counter, err := s.projects.IncrementCounter(ctx, pid)
		if err != nil {
			return nil, fmt.Errorf("incrementing counter: %w", err)
		}

		now := time.Now().UTC()
		attachments := req.Attachments
		if attachments == nil {
			attachments = []models.Attachment{}
		}

		issue = models.Issue{
			ProjectID:        pid,
			IssueKey:         fmt.Sprintf("%s-%04d", project.Code, counter),
			Number:           counter,
			Title:            req.Title,
			Description:      req.Description,
			Type:             req.Type,
			Priority:         req.Priority,
			Status:           "open",
			Source:           req.Source,
			SourceFeedbackID: req.SourceFeedbackID,
			CreatedBy:        req.CreatedBy,
			DueDate:     dueDate,
			ReproSteps:  req.ReproSteps,
			Attachments: attachments,
			CreatedAt:   now,
			UpdatedAt:   now,
		}

		result, err := s.collection().InsertOne(ctx, issue)
		if err != nil {
			return nil, fmt.Errorf("inserting issue: %w", err)
		}
		issue.ID = result.InsertedID.(bson.ObjectID)
		return nil, nil
	})
	if err != nil {
		return nil, err
	}

	return &issue, nil
}

// GetByKey retrieves an issue by its unique issue key.
func (s *IssueService) GetByKey(ctx context.Context, issueKey string) (*models.Issue, error) {
	var issue models.Issue
	err := s.collection().FindOne(ctx, bson.D{{Key: "issueKey", Value: issueKey}}).Decode(&issue)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("issue not found: %s", issueKey)
		}
		return nil, fmt.Errorf("finding issue: %w", err)
	}
	return &issue, nil
}

// Update updates mutable fields of an issue identified by its key.
func (s *IssueService) Update(ctx context.Context, issueKey string, req *models.UpdateIssueRequest) (*models.Issue, error) {
	updates := bson.D{}
	if req.Title != nil {
		updates = append(updates, bson.E{Key: "title", Value: *req.Title})
	}
	if req.Description != nil {
		updates = append(updates, bson.E{Key: "description", Value: *req.Description})
	}
	if req.Priority != nil {
		if !models.ValidPriority(string(*req.Priority)) {
			return nil, fmt.Errorf("invalid priority: %s", *req.Priority)
		}
		updates = append(updates, bson.E{Key: "priority", Value: *req.Priority})
	}
	if req.Source != nil {
		updates = append(updates, bson.E{Key: "source", Value: *req.Source})
	}
	if req.DueDate != nil {
		if *req.DueDate == "" {
			updates = append(updates, bson.E{Key: "dueDate", Value: nil})
		} else {
			t, err := time.Parse(time.RFC3339, *req.DueDate)
			if err != nil {
				t, err = time.Parse("2006-01-02", *req.DueDate)
				if err != nil {
					return nil, fmt.Errorf("invalid dueDate format: %w", err)
				}
			}
			updates = append(updates, bson.E{Key: "dueDate", Value: t})
		}
	}
	if req.ReproSteps != nil {
		updates = append(updates, bson.E{Key: "reproSteps", Value: *req.ReproSteps})
	}

	if len(updates) == 0 {
		return s.GetByKey(ctx, issueKey)
	}

	updates = append(updates, bson.E{Key: "updatedAt", Value: time.Now().UTC()})

	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var issue models.Issue
	err := s.collection().FindOneAndUpdate(
		ctx,
		bson.D{{Key: "issueKey", Value: issueKey}},
		bson.D{{Key: "$set", Value: updates}},
		opts,
	).Decode(&issue)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("issue not found: %s", issueKey)
		}
		return nil, fmt.Errorf("updating issue: %w", err)
	}
	return &issue, nil
}

// TransitionStatus validates and applies a status transition.
func (s *IssueService) TransitionStatus(ctx context.Context, issueKey string, newStatus string) (*models.Issue, error) {
	issue, err := s.GetByKey(ctx, issueKey)
	if err != nil {
		return nil, err
	}

	if err := models.ValidateStatusTransition(issue.Type, issue.Status, newStatus); err != nil {
		return nil, err
	}

	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var updated models.Issue
	err = s.collection().FindOneAndUpdate(
		ctx,
		bson.D{{Key: "issueKey", Value: issueKey}},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "status", Value: newStatus},
			{Key: "updatedAt", Value: time.Now().UTC()},
		}}},
		opts,
	).Decode(&updated)
	if err != nil {
		return nil, fmt.Errorf("transitioning status: %w", err)
	}
	return &updated, nil
}

// Delete soft-deletes an issue by setting archived=true.
func (s *IssueService) Delete(ctx context.Context, issueKey string) error {
	now := time.Now().UTC()
	result, err := s.collection().UpdateOne(
		ctx,
		bson.D{{Key: "issueKey", Value: issueKey}},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "archived", Value: true},
			{Key: "archivedAt", Value: now},
			{Key: "updatedAt", Value: now},
		}}},
	)
	if err != nil {
		return fmt.Errorf("archiving issue: %w", err)
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("issue not found: %s", issueKey)
	}
	return nil
}

// Restore un-archives a soft-deleted issue.
func (s *IssueService) Restore(ctx context.Context, issueKey string) error {
	result, err := s.collection().UpdateOne(
		ctx,
		bson.D{{Key: "issueKey", Value: issueKey}},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "archived", Value: false},
			{Key: "updatedAt", Value: time.Now().UTC()},
		}, }, {Key: "$unset", Value: bson.D{
			{Key: "archivedAt", Value: ""},
		}}},
	)
	if err != nil {
		return fmt.Errorf("restoring issue: %w", err)
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("issue not found: %s", issueKey)
	}
	return nil
}

// DeleteAllByProject permanently removes all issues (archived or not) for a project.
// Used for cascade deletion when a project is permanently deleted.
func (s *IssueService) DeleteAllByProject(ctx context.Context, projectID string) error {
	pid, err := bson.ObjectIDFromHex(projectID)
	if err != nil {
		return fmt.Errorf("invalid project ID: %w", err)
	}
	_, err = s.collection().DeleteMany(ctx, bson.D{{Key: "projectId", Value: pid}})
	if err != nil {
		return fmt.Errorf("delete issues for project: %w", err)
	}
	return nil
}

// PermanentDelete permanently removes an archived issue.
func (s *IssueService) PermanentDelete(ctx context.Context, issueKey string) error {
	result, err := s.collection().DeleteOne(ctx, bson.D{
		{Key: "issueKey", Value: issueKey},
		{Key: "archived", Value: true},
	})
	if err != nil {
		return fmt.Errorf("permanently deleting issue: %w", err)
	}
	if result.DeletedCount == 0 {
		return fmt.Errorf("archived issue not found: %s", issueKey)
	}
	return nil
}

// ListArchived returns archived issues for a project.
func (s *IssueService) ListArchived(ctx context.Context, projectID string) ([]models.Issue, error) {
	pid, err := bson.ObjectIDFromHex(projectID)
	if err != nil {
		return nil, fmt.Errorf("invalid project ID: %w", err)
	}

	filter := bson.D{
		{Key: "projectId", Value: pid},
		{Key: "archived", Value: true},
	}

	opts := options.Find().SetSort(bson.D{{Key: "archivedAt", Value: -1}})
	cursor, err := s.collection().Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("finding archived issues: %w", err)
	}
	defer cursor.Close(ctx)

	var issues []models.Issue
	if err := cursor.All(ctx, &issues); err != nil {
		return nil, fmt.Errorf("decoding archived issues: %w", err)
	}
	if issues == nil {
		issues = []models.Issue{}
	}
	return issues, nil
}

// Search performs a text search on title and description, optionally scoped to a project.
func (s *IssueService) Search(ctx context.Context, query string, projectID string) ([]models.Issue, error) {
	filter := bson.D{{Key: "$text", Value: bson.D{{Key: "$search", Value: query}}}}

	if projectID != "" {
		pid, err := bson.ObjectIDFromHex(projectID)
		if err != nil {
			return nil, fmt.Errorf("invalid project ID: %w", err)
		}
		filter = append(filter, bson.E{Key: "projectId", Value: pid})
	}

	opts := options.Find().
		SetSort(bson.D{{Key: "score", Value: bson.D{{Key: "$meta", Value: "textScore"}}}}).
		SetProjection(bson.D{{Key: "score", Value: bson.D{{Key: "$meta", Value: "textScore"}}}})

	cursor, err := s.collection().Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("searching issues: %w", err)
	}
	defer cursor.Close(ctx)

	var issues []models.Issue
	if err := cursor.All(ctx, &issues); err != nil {
		return nil, fmt.Errorf("decoding search results: %w", err)
	}
	if issues == nil {
		issues = []models.Issue{}
	}
	return issues, nil
}

// EnsureIndexes creates the required indexes for the issues collection.
func (s *IssueService) EnsureIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "issueKey", Value: 1}},
			Options: options.Index().SetUnique(true),
		},
		{
			Keys: bson.D{
				{Key: "projectId", Value: 1},
				{Key: "priority", Value: 1},
				{Key: "status", Value: 1},
			},
		},
		{
			Keys: bson.D{
				{Key: "title", Value: "text"},
				{Key: "description", Value: "text"},
			},
		},
	}

	_, err := s.collection().Indexes().CreateMany(ctx, indexes)
	if err != nil {
		return fmt.Errorf("creating indexes: %w", err)
	}
	return nil
}

// CountByProject returns issue counts grouped by status for a project (excludes archived).
func (s *IssueService) CountByProject(ctx context.Context, projectID bson.ObjectID) (map[string]int, error) {
	pipeline := bson.A{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "projectId", Value: projectID},
			{Key: "archived", Value: bson.D{{Key: "$ne", Value: true}}},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$status"},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
		}}},
	}

	cursor, err := s.collection().Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("aggregating by status: %w", err)
	}
	defer cursor.Close(ctx)

	counts := make(map[string]int)
	for cursor.Next(ctx) {
		var result struct {
			ID    string `bson:"_id"`
			Count int    `bson:"count"`
		}
		if err := cursor.Decode(&result); err != nil {
			return nil, fmt.Errorf("decoding count: %w", err)
		}
		counts[result.ID] = result.Count
	}
	return counts, nil
}

// CountByPriority returns issue counts grouped by priority for a project (excludes archived).
func (s *IssueService) CountByPriority(ctx context.Context, projectID bson.ObjectID) (map[string]int, error) {
	pipeline := bson.A{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "projectId", Value: projectID},
			{Key: "archived", Value: bson.D{{Key: "$ne", Value: true}}},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$priority"},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
		}}},
	}

	cursor, err := s.collection().Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("aggregating by priority: %w", err)
	}
	defer cursor.Close(ctx)

	counts := make(map[string]int)
	for cursor.Next(ctx) {
		var result struct {
			ID    string `bson:"_id"`
			Count int    `bson:"count"`
		}
		if err := cursor.Decode(&result); err != nil {
			return nil, fmt.Errorf("decoding count: %w", err)
		}
		counts[result.ID] = result.Count
	}
	return counts, nil
}
