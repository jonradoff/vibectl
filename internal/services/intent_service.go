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

type IntentService struct {
	collection        *mongo.Collection
	historyCollection *mongo.Collection
}

func NewIntentService(db *mongo.Database) *IntentService {
	return &IntentService{
		collection:        db.Collection("intents"),
		historyCollection: db.Collection("chat_history"),
	}
}

func (s *IntentService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "projectCode", Value: 1}, {Key: "completedAt", Value: -1}}},
		{Keys: bson.D{{Key: "status", Value: 1}}},
		{Keys: bson.D{{Key: "category", Value: 1}}},
		{Keys: bson.D{{Key: "extractedAt", Value: -1}}},
		{Keys: bson.D{{Key: "sessionIds", Value: 1}}},
	})
	return err
}

func (s *IntentService) Create(ctx context.Context, intent *models.Intent) error {
	intent.ExtractedAt = time.Now().UTC()
	res, err := s.collection.InsertOne(ctx, intent)
	if err != nil {
		return fmt.Errorf("insert intent: %w", err)
	}
	intent.ID = res.InsertedID.(bson.ObjectID)
	return nil
}

func (s *IntentService) GetByID(ctx context.Context, id bson.ObjectID) (*models.Intent, error) {
	var intent models.Intent
	err := s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&intent)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}
	return &intent, nil
}

func (s *IntentService) GetBySessionID(ctx context.Context, sessionID string) ([]models.Intent, error) {
	cursor, err := s.collection.Find(ctx, bson.D{{Key: "sessionIds", Value: sessionID}})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var results []models.Intent
	cursor.All(ctx, &results)
	if results == nil {
		results = []models.Intent{}
	}
	return results, nil
}

func (s *IntentService) ListByProject(ctx context.Context, projectCode string, since time.Time, limit int) ([]models.Intent, error) {
	if limit <= 0 {
		limit = 100
	}
	filter := bson.D{
		{Key: "analysisModel", Value: bson.D{{Key: "$ne", Value: "skip"}}},
	}
	if projectCode != "" {
		filter = append(filter, bson.E{Key: "projectCode", Value: projectCode})
	}
	if !since.IsZero() {
		filter = append(filter, bson.E{Key: "completedAt", Value: bson.D{{Key: "$gte", Value: since}}})
	}
	opts := options.Find().SetSort(bson.D{{Key: "completedAt", Value: -1}}).SetLimit(int64(limit))
	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var results []models.Intent
	cursor.All(ctx, &results)
	if results == nil {
		results = []models.Intent{}
	}
	return results, nil
}

func (s *IntentService) List(ctx context.Context, projectCode, status, category string, since time.Time, limit int) ([]models.Intent, error) {
	if limit <= 0 {
		limit = 100
	}
	// Exclude skip placeholders and empty-projectCode intents from all queries
	filter := bson.D{
		{Key: "analysisModel", Value: bson.D{{Key: "$ne", Value: "skip"}}},
		{Key: "projectCode", Value: bson.D{{Key: "$ne", Value: ""}}},
	}
	if projectCode != "" {
		filter = append(filter, bson.E{Key: "projectCode", Value: projectCode})
	}
	if status != "" {
		filter = append(filter, bson.E{Key: "status", Value: status})
	}
	if category != "" {
		filter = append(filter, bson.E{Key: "category", Value: category})
	}
	if !since.IsZero() {
		filter = append(filter, bson.E{Key: "completedAt", Value: bson.D{{Key: "$gte", Value: since}}})
	}
	opts := options.Find().SetSort(bson.D{{Key: "completedAt", Value: -1}}).SetLimit(int64(limit))
	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var results []models.Intent
	cursor.All(ctx, &results)
	if results == nil {
		results = []models.Intent{}
	}
	return results, nil
}

// Merge appends a new session's data to an existing intent (cross-session continuity).
func (s *IntentService) Merge(ctx context.Context, existingID bson.ObjectID, newSessionID string, tokensIn, tokensOut, wallClock int64, promptCount int, newFiles []string) error {
	now := time.Now().UTC()
	update := bson.D{
		{Key: "$addToSet", Value: bson.D{{Key: "sessionIds", Value: newSessionID}}},
		{Key: "$inc", Value: bson.D{
			{Key: "tokensInput", Value: tokensIn},
			{Key: "tokensOutput", Value: tokensOut},
			{Key: "wallClockSecs", Value: wallClock},
			{Key: "promptCount", Value: promptCount},
			{Key: "mergeCount", Value: 1},
		}},
		{Key: "$set", Value: bson.D{
			{Key: "mergedAt", Value: now},
			{Key: "updatedAt", Value: now},
		}},
	}
	// Union new files
	if len(newFiles) > 0 {
		update = append(update, bson.E{Key: "$addToSet", Value: bson.D{
			{Key: "filesChanged", Value: bson.D{{Key: "$each", Value: newFiles}}},
		}})
	}
	_, err := s.collection.UpdateByID(ctx, existingID, update)
	return err
}

// ListRecent returns recent intents for a project (for merge detection).
func (s *IntentService) ListRecent(ctx context.Context, projectCode string, days int) ([]models.Intent, error) {
	since := time.Now().UTC().AddDate(0, 0, -days)
	filter := bson.D{
		{Key: "analysisModel", Value: bson.D{{Key: "$ne", Value: "skip"}}},
		{Key: "completedAt", Value: bson.D{{Key: "$gte", Value: since}}},
	}
	if projectCode != "" {
		filter = append(filter, bson.E{Key: "projectCode", Value: projectCode})
	}
	opts := options.Find().SetSort(bson.D{{Key: "completedAt", Value: -1}}).SetLimit(10)
	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var results []models.Intent
	cursor.All(ctx, &results)
	return results, nil
}

// ListWithOpenPRs returns intents that have PR links with state "open".
func (s *IntentService) ListWithOpenPRs(ctx context.Context) ([]models.Intent, error) {
	cursor, err := s.collection.Find(ctx, bson.D{
		{Key: "prLinks.state", Value: "open"},
	})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var results []models.Intent
	cursor.All(ctx, &results)
	return results, nil
}

func (s *IntentService) Update(ctx context.Context, id bson.ObjectID, updates bson.D) error {
	_, err := s.collection.UpdateByID(ctx, id, bson.D{{Key: "$set", Value: updates}})
	return err
}

// UpdateRaw applies a raw MongoDB update (for $push, $addToSet, etc.).
func (s *IntentService) UpdateRaw(ctx context.Context, id bson.ObjectID, update bson.D) error {
	_, err := s.collection.UpdateByID(ctx, id, update)
	return err
}

// CountUnanalyzedSessions returns the count of chat history entries without linked intents.
func (s *IntentService) CountUnanalyzedSessions(ctx context.Context) (int, error) {
	analyzedIDs, err := s.getAnalyzedSessionIDs(ctx)
	if err != nil {
		return 0, err
	}
	filter := bson.D{
		{Key: "messageCount", Value: bson.D{{Key: "$gte", Value: 2}}},
	}
	if len(analyzedIDs) > 0 {
		filter = append(filter, bson.E{Key: "claudeSessionId", Value: bson.D{{Key: "$nin", Value: analyzedIDs}}})
	}
	n, err := s.historyCollection.CountDocuments(ctx, filter)
	return int(n), err
}

func (s *IntentService) getAnalyzedSessionIDs(ctx context.Context) ([]string, error) {
	pipeline := bson.A{
		bson.D{{Key: "$unwind", Value: "$sessionIds"}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$sessionIds"}}}},
	}
	cursor, err := s.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("aggregate analyzed sessions: %w", err)
	}
	var analyzed []struct {
		ID string `bson:"_id"`
	}
	cursor.All(ctx, &analyzed)
	cursor.Close(ctx)

	ids := make([]string, len(analyzed))
	for i, a := range analyzed {
		ids[i] = a.ID
	}
	return ids, nil
}

// ListUnanalyzedSessions returns chat history entries that don't yet have linked intents.
func (s *IntentService) ListUnanalyzedSessions(ctx context.Context, limit int) ([]models.ChatHistoryEntry, error) {
	if limit <= 0 {
		limit = 50
	}

	analyzedIDs, err := s.getAnalyzedSessionIDs(ctx)
	if err != nil {
		return nil, err
	}

	filter := bson.D{
		{Key: "messageCount", Value: bson.D{{Key: "$gte", Value: 2}}},
	}
	if len(analyzedIDs) > 0 {
		filter = append(filter, bson.E{Key: "claudeSessionId", Value: bson.D{{Key: "$nin", Value: analyzedIDs}}})
	}
	// Don't load full messages here — they can be huge (500+ entries).
	// The extractor will load them individually when needed.
	opts := options.Find().
		SetSort(bson.D{{Key: "endedAt", Value: -1}}).
		SetLimit(int64(limit)).
		SetProjection(bson.D{
			{Key: "_id", Value: 1},
			{Key: "projectCode", Value: 1},
			{Key: "claudeSessionId", Value: 1},
			{Key: "messageCount", Value: 1},
			{Key: "startedAt", Value: 1},
			{Key: "endedAt", Value: 1},
		})

	historyCursor, err := s.historyCollection.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("find unanalyzed: %w", err)
	}
	defer historyCursor.Close(ctx)
	var results []models.ChatHistoryEntry
	historyCursor.All(ctx, &results)
	if results == nil {
		results = []models.ChatHistoryEntry{}
	}
	return results, nil
}

// GetHistoryEntry fetches a single full chat history entry by ID (with messages).
func (s *IntentService) GetHistoryEntry(ctx context.Context, id bson.ObjectID) (*models.ChatHistoryEntry, error) {
	var entry models.ChatHistoryEntry
	err := s.historyCollection.FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&entry)
	if err != nil {
		return nil, err
	}
	return &entry, nil
}

// ProductivityStats holds aggregated intent metrics for the productivity API.
type ProductivityStats struct {
	ProjectCode    string `json:"projectCode"`
	ProjectName    string `json:"projectName,omitempty"`
	Tags           []string `json:"tags,omitempty"`
	PointsDelivered int    `json:"pointsDelivered"`
	IntentCount    int    `json:"intentCount"`
	ByStatus       map[string]int `json:"byStatus"`
	ByCategory     map[string]int `json:"byCategory"`
	TotalTokensIn  int64  `json:"totalTokensIn"`
	TotalTokensOut int64  `json:"totalTokensOut"`
	TotalWallClock int64  `json:"totalWallClock"`
}
