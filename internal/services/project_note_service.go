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

type ProjectNoteService struct {
	collection *mongo.Collection
}

func NewProjectNoteService(db *mongo.Database) *ProjectNoteService {
	return &ProjectNoteService{collection: db.Collection("project_notes")}
}

func (s *ProjectNoteService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "projectCode", Value: 1}},
			Options: options.Index().SetUnique(true),
		},
	})
	return err
}

// Upsert creates or replaces the note for a project.
func (s *ProjectNoteService) Upsert(ctx context.Context, projectCode, text string, userID *bson.ObjectID) (*models.ProjectNote, error) {
	now := time.Now().UTC()
	filter := bson.D{{Key: "projectCode", Value: projectCode}}
	update := bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "projectCode", Value: projectCode},
			{Key: "text", Value: text},
			{Key: "createdBy", Value: userID},
			{Key: "updatedAt", Value: now},
		}},
		{Key: "$setOnInsert", Value: bson.D{
			{Key: "createdAt", Value: now},
		}},
	}
	opts := options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)
	var note models.ProjectNote
	err := s.collection.FindOneAndUpdate(ctx, filter, update, opts).Decode(&note)
	if err != nil {
		return nil, fmt.Errorf("upsert project note: %w", err)
	}
	return &note, nil
}

// GetByProject returns the note for a project, or nil if none exists.
func (s *ProjectNoteService) GetByProject(ctx context.Context, projectCode string) (*models.ProjectNote, error) {
	var note models.ProjectNote
	err := s.collection.FindOne(ctx, bson.D{{Key: "projectCode", Value: projectCode}}).Decode(&note)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("get project note: %w", err)
	}
	return &note, nil
}

// GetByProjects returns notes for multiple projects in one query.
func (s *ProjectNoteService) GetByProjects(ctx context.Context, codes []string) (map[string]*models.ProjectNote, error) {
	cursor, err := s.collection.Find(ctx, bson.D{{Key: "projectCode", Value: bson.D{{Key: "$in", Value: codes}}}})
	if err != nil {
		return nil, fmt.Errorf("get project notes bulk: %w", err)
	}
	defer cursor.Close(ctx)
	result := make(map[string]*models.ProjectNote)
	for cursor.Next(ctx) {
		var note models.ProjectNote
		if err := cursor.Decode(&note); err == nil {
			result[note.ProjectCode] = &note
		}
	}
	return result, nil
}

// Delete removes the note for a project.
func (s *ProjectNoteService) Delete(ctx context.Context, projectCode string) error {
	_, err := s.collection.DeleteOne(ctx, bson.D{{Key: "projectCode", Value: projectCode}})
	return err
}
