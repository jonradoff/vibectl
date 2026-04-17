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

type CodeDeltaService struct {
	collection *mongo.Collection
}

func NewCodeDeltaService(db *mongo.Database) *CodeDeltaService {
	return &CodeDeltaService{collection: db.Collection("code_deltas")}
}

func (s *CodeDeltaService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "projectId", Value: 1}, {Key: "recordedAt", Value: -1}}},
		{Keys: bson.D{{Key: "recordedAt", Value: -1}}},
	})
	return err
}

// Record inserts a code delta entry.
func (s *CodeDeltaService) Record(ctx context.Context, delta *models.CodeDelta) error {
	delta.RecordedAt = time.Now().UTC()
	_, err := s.collection.InsertOne(ctx, delta)
	return err
}

// RecordAsync records a code delta in a background goroutine.
func (s *CodeDeltaService) RecordAsync(delta *models.CodeDelta) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		s.Record(ctx, delta)
	}()
}

// ProjectProductivity holds aggregated code delta stats for a project.
type ProjectProductivity struct {
	ProjectID    string        `json:"projectId" bson:"-"`
	RawID        bson.ObjectID `json:"-" bson:"_id"`
	LinesAdded   int64         `json:"linesAdded" bson:"linesAdded"`
	LinesRemoved int64         `json:"linesRemoved" bson:"linesRemoved"`
	BytesDelta   int64         `json:"bytesDelta" bson:"bytesDelta"`
	FilesChanged int64         `json:"filesChanged" bson:"filesChanged"`
	PromptCount  int64         `json:"promptCount" bson:"promptCount"`
}

// GetProductivity returns aggregated code delta stats per project for the given time range.
func (s *CodeDeltaService) GetProductivity(ctx context.Context, since time.Time) ([]ProjectProductivity, error) {
	pipeline := bson.A{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "recordedAt", Value: bson.D{{Key: "$gte", Value: since}}},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$projectId"},
			{Key: "linesAdded", Value: bson.D{{Key: "$sum", Value: "$linesAdded"}}},
			{Key: "linesRemoved", Value: bson.D{{Key: "$sum", Value: "$linesRemoved"}}},
			{Key: "bytesDelta", Value: bson.D{{Key: "$sum", Value: "$bytesDelta"}}},
			{Key: "filesChanged", Value: bson.D{{Key: "$sum", Value: "$filesChanged"}}},
			{Key: "promptCount", Value: bson.D{{Key: "$sum", Value: 1}}},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "linesAdded", Value: -1}}}},
	}

	cursor, err := s.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("aggregate productivity: %w", err)
	}
	defer cursor.Close(ctx)

	var results []ProjectProductivity
	if err := cursor.All(ctx, &results); err != nil {
		return nil, fmt.Errorf("decode productivity: %w", err)
	}
	if results == nil {
		results = []ProjectProductivity{}
	}
	for i := range results {
		results[i].ProjectID = results[i].RawID.Hex()
	}
	return results, nil
}

// GetProductivityByProject returns code delta stats for a specific project.
func (s *CodeDeltaService) GetProductivityByProject(ctx context.Context, projectID string, since time.Time) (*ProjectProductivity, error) {
	oid, err := bson.ObjectIDFromHex(projectID)
	if err != nil {
		return nil, nil
	}

	pipeline := bson.A{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "projectId", Value: oid},
			{Key: "recordedAt", Value: bson.D{{Key: "$gte", Value: since}}},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: nil},
			{Key: "linesAdded", Value: bson.D{{Key: "$sum", Value: "$linesAdded"}}},
			{Key: "linesRemoved", Value: bson.D{{Key: "$sum", Value: "$linesRemoved"}}},
			{Key: "bytesDelta", Value: bson.D{{Key: "$sum", Value: "$bytesDelta"}}},
			{Key: "filesChanged", Value: bson.D{{Key: "$sum", Value: "$filesChanged"}}},
			{Key: "promptCount", Value: bson.D{{Key: "$sum", Value: 1}}},
		}}},
	}

	cursor, err := s.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var results []ProjectProductivity
	cursor.All(ctx, &results)
	if len(results) == 0 {
		return nil, nil
	}
	results[0].ProjectID = projectID
	return &results[0], nil
}

// ListRecent returns recent individual code delta records.
func (s *CodeDeltaService) ListRecent(ctx context.Context, projectID string, limit int) ([]models.CodeDelta, error) {
	if limit <= 0 {
		limit = 50
	}
	filter := bson.D{}
	if projectID != "" {
		oid, err := bson.ObjectIDFromHex(projectID)
		if err == nil {
			filter = append(filter, bson.E{Key: "projectId", Value: oid})
		}
	}
	opts := options.Find().SetSort(bson.D{{Key: "recordedAt", Value: -1}}).SetLimit(int64(limit))
	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var results []models.CodeDelta
	cursor.All(ctx, &results)
	if results == nil {
		results = []models.CodeDelta{}
	}
	return results, nil
}
