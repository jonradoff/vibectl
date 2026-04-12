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

type PlanService struct {
	collection *mongo.Collection
}

func NewPlanService(db *mongo.Database) *PlanService {
	return &PlanService{collection: db.Collection("plans")}
}

func (s *PlanService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "projectId", Value: 1}, {Key: "createdAt", Value: -1}}},
		{Keys: bson.D{{Key: "status", Value: 1}, {Key: "createdAt", Value: -1}}},
		{Keys: bson.D{{Key: "createdAt", Value: -1}}},
	})
	return err
}

// Create inserts a new plan record.
func (s *PlanService) Create(ctx context.Context, plan *models.Plan) error {
	now := time.Now().UTC()
	plan.CreatedAt = now
	plan.UpdatedAt = now
	if plan.Status == "" {
		plan.Status = "pending"
	}
	res, err := s.collection.InsertOne(ctx, plan)
	if err != nil {
		return fmt.Errorf("insert plan: %w", err)
	}
	plan.ID = res.InsertedID.(bson.ObjectID)
	return nil
}

// CreateAsync creates a plan in a background goroutine.
func (s *PlanService) CreateAsync(plan *models.Plan) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.Create(ctx, plan); err != nil {
			fmt.Printf("failed to create plan: %v\n", err)
		}
	}()
}

// UpdateStatus updates the status (and optionally feedback) of a plan.
func (s *PlanService) UpdateStatus(ctx context.Context, id bson.ObjectID, status string, feedback string) error {
	update := bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "status", Value: status},
			{Key: "updatedAt", Value: time.Now().UTC()},
		}},
	}
	if feedback != "" {
		update[0].Value = append(update[0].Value.(bson.D), bson.E{Key: "feedback", Value: feedback})
	}
	if status == "completed" {
		now := time.Now().UTC()
		update[0].Value = append(update[0].Value.(bson.D), bson.E{Key: "completedAt", Value: now})
	}
	_, err := s.collection.UpdateByID(ctx, id, update)
	if err != nil {
		return fmt.Errorf("update plan status: %w", err)
	}
	return nil
}

// UpdateStatusByRequestID updates the plan matching a given requestID + projectID.
func (s *PlanService) UpdateStatusByRequestID(ctx context.Context, projectID *bson.ObjectID, requestID string, status string, feedback string) error {
	filter := bson.D{{Key: "requestId", Value: requestID}}
	if projectID != nil {
		filter = append(filter, bson.E{Key: "projectId", Value: *projectID})
	}
	set := bson.D{
		{Key: "status", Value: status},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}
	if feedback != "" {
		set = append(set, bson.E{Key: "feedback", Value: feedback})
	}
	if status == "completed" {
		now := time.Now().UTC()
		set = append(set, bson.E{Key: "completedAt", Value: now})
	}
	update := bson.D{{Key: "$set", Value: set}}
	_, err := s.collection.UpdateOne(ctx, filter, update)
	if err != nil {
		return fmt.Errorf("update plan by requestID: %w", err)
	}
	return nil
}

// GetByID returns a single plan.
func (s *PlanService) GetByID(ctx context.Context, id bson.ObjectID) (*models.Plan, error) {
	var plan models.Plan
	err := s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&plan)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("find plan: %w", err)
	}
	return &plan, nil
}

// List returns plans with optional filtering.
func (s *PlanService) List(ctx context.Context, projectID string, status string, limit int, offset int) ([]models.Plan, int64, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	filter := bson.D{}
	if projectID != "" {
		oid, err := bson.ObjectIDFromHex(projectID)
		if err != nil {
			return nil, 0, fmt.Errorf("invalid project ID: %w", err)
		}
		filter = append(filter, bson.E{Key: "projectId", Value: oid})
	}
	if status != "" {
		filter = append(filter, bson.E{Key: "status", Value: status})
	}

	total, err := s.collection.CountDocuments(ctx, filter)
	if err != nil {
		return nil, 0, fmt.Errorf("count plans: %w", err)
	}

	opts := options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(int64(limit)).
		SetSkip(int64(offset))

	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, 0, fmt.Errorf("find plans: %w", err)
	}
	defer cursor.Close(ctx)

	var results []models.Plan
	if err := cursor.All(ctx, &results); err != nil {
		return nil, 0, fmt.Errorf("decode plans: %w", err)
	}
	if results == nil {
		results = []models.Plan{}
	}
	return results, total, nil
}

// MarkAcceptedPlansCompleted marks all accepted plans for a project as completed
// when the session ends (inference: if Claude finished without abandoning, the plan was completed).
func (s *PlanService) MarkAcceptedPlansCompleted(ctx context.Context, projectID string) error {
	oid, err := bson.ObjectIDFromHex(projectID)
	if err != nil {
		return nil // silently skip invalid IDs
	}
	now := time.Now().UTC()
	filter := bson.D{
		{Key: "projectId", Value: oid},
		{Key: "status", Value: "accepted"},
	}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "status", Value: "completed"},
		{Key: "completedAt", Value: now},
		{Key: "updatedAt", Value: now},
	}}}
	_, err = s.collection.UpdateMany(ctx, filter, update)
	return err
}
