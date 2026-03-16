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

type FeedbackService struct {
	db         *mongo.Database
	collection *mongo.Collection
}

func NewFeedbackService(db *mongo.Database) *FeedbackService {
	return &FeedbackService{
		db:         db,
		collection: db.Collection("feedback"),
	}
}

// EnsureIndexes creates indexes on projectId and triageStatus.
func (s *FeedbackService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "projectId", Value: 1}}},
		{Keys: bson.D{{Key: "triageStatus", Value: 1}}},
		{Keys: bson.D{{Key: "sourceUrl", Value: 1}}},
	})
	return err
}

// List returns feedback items filtered by optional projectId, triageStatus, and sourceType.
func (s *FeedbackService) List(ctx context.Context, filters map[string]string) ([]models.FeedbackItem, error) {
	filter := bson.D{}
	if pid, ok := filters["projectId"]; ok && pid != "" {
		oid, err := bson.ObjectIDFromHex(pid)
		if err != nil {
			return nil, fmt.Errorf("invalid projectId: %w", err)
		}
		filter = append(filter, bson.E{Key: "projectId", Value: oid})
	}
	if ts, ok := filters["triageStatus"]; ok && ts != "" {
		filter = append(filter, bson.E{Key: "triageStatus", Value: ts})
	}
	if st, ok := filters["sourceType"]; ok && st != "" {
		filter = append(filter, bson.E{Key: "sourceType", Value: st})
	}

	opts := options.Find().SetSort(bson.D{{Key: "submittedAt", Value: -1}})
	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("find feedback: %w", err)
	}
	defer cursor.Close(ctx)

	var items []models.FeedbackItem
	if err := cursor.All(ctx, &items); err != nil {
		return nil, fmt.Errorf("decode feedback: %w", err)
	}
	if items == nil {
		items = []models.FeedbackItem{}
	}
	return items, nil
}

// ListByProject returns all feedback items for a given project.
func (s *FeedbackService) ListByProject(ctx context.Context, projectID string) ([]models.FeedbackItem, error) {
	oid, err := bson.ObjectIDFromHex(projectID)
	if err != nil {
		return nil, fmt.Errorf("invalid project ID: %w", err)
	}

	opts := options.Find().SetSort(bson.D{{Key: "submittedAt", Value: -1}})
	cursor, err := s.collection.Find(ctx, bson.D{{Key: "projectId", Value: oid}}, opts)
	if err != nil {
		return nil, fmt.Errorf("find feedback by project: %w", err)
	}
	defer cursor.Close(ctx)

	var items []models.FeedbackItem
	if err := cursor.All(ctx, &items); err != nil {
		return nil, fmt.Errorf("decode feedback: %w", err)
	}
	if items == nil {
		items = []models.FeedbackItem{}
	}
	return items, nil
}

// Create inserts a new feedback item with triageStatus=pending and submittedAt=now.
func (s *FeedbackService) Create(ctx context.Context, req *models.CreateFeedbackRequest) (*models.FeedbackItem, error) {
	now := time.Now().UTC()

	item := models.FeedbackItem{
		SourceType:   req.SourceType,
		SourceURL:    req.SourceURL,
		RawContent:   req.RawContent,
		SubmittedBy:  req.SubmittedBy,
		SubmittedAt:  now,
		TriageStatus: models.TriageStatusPending,
	}

	if req.ProjectID != "" {
		oid, err := bson.ObjectIDFromHex(req.ProjectID)
		if err != nil {
			return nil, fmt.Errorf("invalid project ID: %w", err)
		}
		item.ProjectID = &oid
	}

	result, err := s.collection.InsertOne(ctx, item)
	if err != nil {
		return nil, fmt.Errorf("insert feedback: %w", err)
	}

	item.ID = result.InsertedID.(bson.ObjectID)
	return &item, nil
}

// CreateBatch inserts multiple feedback items at once.
func (s *FeedbackService) CreateBatch(ctx context.Context, reqs []models.CreateFeedbackRequest) ([]models.FeedbackItem, error) {
	now := time.Now().UTC()
	items := make([]models.FeedbackItem, len(reqs))
	docs := make([]interface{}, len(reqs))

	for i, req := range reqs {
		item := models.FeedbackItem{
			SourceType:   req.SourceType,
			SourceURL:    req.SourceURL,
			RawContent:   req.RawContent,
			SubmittedBy:  req.SubmittedBy,
			SubmittedAt:  now,
			TriageStatus: models.TriageStatusPending,
		}
		if req.ProjectID != "" {
			oid, err := bson.ObjectIDFromHex(req.ProjectID)
			if err != nil {
				return nil, fmt.Errorf("invalid project ID in batch item %d: %w", i, err)
			}
			item.ProjectID = &oid
		}
		items[i] = item
		docs[i] = item
	}

	result, err := s.collection.InsertMany(ctx, docs)
	if err != nil {
		return nil, fmt.Errorf("insert feedback batch: %w", err)
	}

	for i, id := range result.InsertedIDs {
		items[i].ID = id.(bson.ObjectID)
	}

	return items, nil
}

// GetByID retrieves a feedback item by its ObjectID hex string.
func (s *FeedbackService) GetByID(ctx context.Context, id string) (*models.FeedbackItem, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, fmt.Errorf("invalid feedback ID: %w", err)
	}

	var item models.FeedbackItem
	err = s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: oid}}).Decode(&item)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("feedback item not found")
		}
		return nil, fmt.Errorf("find feedback: %w", err)
	}
	return &item, nil
}

// UpdateAIAnalysis sets the aiAnalysis field on a feedback item.
func (s *FeedbackService) UpdateAIAnalysis(ctx context.Context, id string, analysis *models.AIAnalysis) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid feedback ID: %w", err)
	}

	update := bson.D{{Key: "$set", Value: bson.D{{Key: "aiAnalysis", Value: analysis}}}}
	result, err := s.collection.UpdateOne(ctx, bson.D{{Key: "_id", Value: oid}}, update)
	if err != nil {
		return fmt.Errorf("update AI analysis: %w", err)
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("feedback item not found")
	}
	return nil
}

// Review accepts or dismisses a feedback item, setting triageStatus and reviewedAt.
func (s *FeedbackService) Review(ctx context.Context, id string, req *models.ReviewFeedbackRequest) (*models.FeedbackItem, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, fmt.Errorf("invalid feedback ID: %w", err)
	}

	var status models.TriageStatus
	switch req.Action {
	case "accept":
		status = models.TriageStatusAccepted
	case "dismiss":
		status = models.TriageStatusDismissed
	default:
		return nil, fmt.Errorf("invalid action %q: must be \"accept\" or \"dismiss\"", req.Action)
	}

	now := time.Now().UTC()
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "triageStatus", Value: status},
		{Key: "reviewedAt", Value: now},
	}}}

	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var item models.FeedbackItem
	err = s.collection.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: oid}}, update, opts).Decode(&item)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("feedback item not found")
		}
		return nil, fmt.Errorf("review feedback: %w", err)
	}
	return &item, nil
}

// FindBySourceURL returns a feedback item matching the given sourceUrl, or nil if not found.
func (s *FeedbackService) FindBySourceURL(ctx context.Context, sourceURL string) (*models.FeedbackItem, error) {
	var item models.FeedbackItem
	err := s.collection.FindOne(ctx, bson.D{{Key: "sourceUrl", Value: sourceURL}}).Decode(&item)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("find by sourceUrl: %w", err)
	}
	return &item, nil
}

// CountPending returns the number of feedback items with triageStatus=pending.
func (s *FeedbackService) CountPending(ctx context.Context) (int, error) {
	count, err := s.collection.CountDocuments(ctx, bson.D{{Key: "triageStatus", Value: models.TriageStatusPending}})
	if err != nil {
		return 0, fmt.Errorf("count pending feedback: %w", err)
	}
	return int(count), nil
}
