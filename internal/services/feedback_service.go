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

// EnsureIndexes creates indexes on projectCode and triageStatus.
func (s *FeedbackService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "projectCode", Value: 1}}},
		{Keys: bson.D{{Key: "triageStatus", Value: 1}}},
		{Keys: bson.D{{Key: "sourceUrl", Value: 1}}},
		{Keys: bson.D{{Key: "projectCode", Value: 1}, {Key: "triageStatus", Value: 1}, {Key: "promptSubmittedAt", Value: 1}}},
	})
	return err
}

// List returns feedback items filtered by optional projectCode, triageStatus, and sourceType.
func (s *FeedbackService) List(ctx context.Context, filters map[string]string) ([]models.FeedbackItem, error) {
	filter := bson.D{}
	if pc, ok := filters["projectCode"]; ok && pc != "" {
		filter = append(filter, bson.E{Key: "projectCode", Value: pc})
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
func (s *FeedbackService) ListByProject(ctx context.Context, projectCode string) ([]models.FeedbackItem, error) {
	opts := options.Find().SetSort(bson.D{{Key: "submittedAt", Value: -1}})
	cursor, err := s.collection.Find(ctx, bson.D{{Key: "projectCode", Value: projectCode}}, opts)
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
		SourceType:      req.SourceType,
		SourceURL:       req.SourceURL,
		RawContent:      req.RawContent,
		SubmittedBy:     req.SubmittedBy,
		SubmittedAt:     now,
		TriageStatus:    models.TriageStatusPending,
		Metadata:        req.Metadata,
		SubmittedViaKey: req.SubmittedViaKey,
	}

	if req.ProjectCode != "" {
		item.ProjectCode = req.ProjectCode
	} else if req.ProjectID != "" {
		// Legacy: resolve projectId to projectCode if needed
		item.ProjectCode = req.ProjectID
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
		_ = i // suppress unused warning
		item := models.FeedbackItem{
			SourceType:   req.SourceType,
			SourceURL:    req.SourceURL,
			RawContent:   req.RawContent,
			SubmittedBy:  req.SubmittedBy,
			SubmittedAt:  now,
			TriageStatus: models.TriageStatusPending,
		}
		if req.ProjectCode != "" {
			item.ProjectCode = req.ProjectCode
		} else if req.ProjectID != "" {
			item.ProjectCode = req.ProjectID
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

// CountPending returns the number of feedback items with triageStatus=pending (globally).
func (s *FeedbackService) CountPending(ctx context.Context) (int, error) {
	count, err := s.collection.CountDocuments(ctx, bson.D{{Key: "triageStatus", Value: models.TriageStatusPending}})
	if err != nil {
		return 0, fmt.Errorf("count pending feedback: %w", err)
	}
	return int(count), nil
}

// CountPendingByProject returns the number of pending feedback items for a project.
func (s *FeedbackService) CountPendingByProject(ctx context.Context, projectCode string) (int, error) {
	filter := bson.D{
		{Key: "projectCode", Value: projectCode},
		{Key: "triageStatus", Value: bson.D{{Key: "$in", Value: bson.A{
			models.TriageStatusPending,
			models.TriageStatusTriaged,
		}}}},
	}
	count, err := s.collection.CountDocuments(ctx, filter)
	if err != nil {
		return 0, fmt.Errorf("count pending feedback by project: %w", err)
	}
	return int(count), nil
}

// SetTriaged marks a feedback item as triaged (AI has analyzed it).
func (s *FeedbackService) SetTriaged(ctx context.Context, id string) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid feedback ID: %w", err)
	}
	now := time.Now().UTC()
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "triageStatus", Value: models.TriageStatusTriaged},
		{Key: "triagedAt", Value: now},
	}}}
	_, err = s.collection.UpdateOne(ctx, bson.D{{Key: "_id", Value: oid}}, update)
	if err != nil {
		return fmt.Errorf("set triaged: %w", err)
	}
	return nil
}

// LinkToIssue sets the linkedIssueKey on an accepted feedback item.
func (s *FeedbackService) LinkToIssue(ctx context.Context, id, issueKey string) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid feedback ID: %w", err)
	}
	update := bson.D{{Key: "$set", Value: bson.D{{Key: "linkedIssueKey", Value: issueKey}}}}
	_, err = s.collection.UpdateOne(ctx, bson.D{{Key: "_id", Value: oid}}, update)
	if err != nil {
		return fmt.Errorf("link feedback to issue: %w", err)
	}
	return nil
}

// ListAcceptedUnsubmitted returns accepted feedback items that haven't been dispatched to Claude Code yet.
func (s *FeedbackService) ListAcceptedUnsubmitted(ctx context.Context, projectCode string) ([]models.FeedbackItem, error) {
	filter := bson.D{
		{Key: "projectCode", Value: projectCode},
		{Key: "triageStatus", Value: models.TriageStatusAccepted},
		{Key: "promptSubmittedAt", Value: bson.D{{Key: "$exists", Value: false}}},
	}
	opts := options.Find().SetSort(bson.D{{Key: "submittedAt", Value: -1}}).SetLimit(20)
	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("list accepted unsubmitted: %w", err)
	}
	defer cursor.Close(ctx)
	var items []models.FeedbackItem
	if err := cursor.All(ctx, &items); err != nil {
		return nil, fmt.Errorf("decode accepted unsubmitted: %w", err)
	}
	if items == nil {
		items = []models.FeedbackItem{}
	}
	return items, nil
}

// MarkPromptSubmitted sets promptSubmittedAt and promptBatchId on the given feedback IDs.
// Uses a guard filter to prevent double-submission.
func (s *FeedbackService) MarkPromptSubmitted(ctx context.Context, ids []string, batchID string) (int64, error) {
	oids := make([]bson.ObjectID, 0, len(ids))
	for _, id := range ids {
		oid, err := bson.ObjectIDFromHex(id)
		if err != nil {
			continue
		}
		oids = append(oids, oid)
	}
	now := time.Now().UTC()
	filter := bson.D{
		{Key: "_id", Value: bson.D{{Key: "$in", Value: oids}}},
		{Key: "promptSubmittedAt", Value: bson.D{{Key: "$exists", Value: false}}},
	}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "promptSubmittedAt", Value: now},
		{Key: "promptBatchId", Value: batchID},
	}}}
	result, err := s.collection.UpdateMany(ctx, filter, update)
	if err != nil {
		return 0, fmt.Errorf("mark prompt submitted: %w", err)
	}
	return result.ModifiedCount, nil
}
