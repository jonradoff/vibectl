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

type SessionService struct {
	db         *mongo.Database
	collection *mongo.Collection
}

func NewSessionService(db *mongo.Database) *SessionService {
	return &SessionService{
		db:         db,
		collection: db.Collection("sessions"),
	}
}

// EnsureIndexes creates indexes on projectCode and startedAt.
func (s *SessionService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "projectCode", Value: 1}}},
		{Keys: bson.D{{Key: "startedAt", Value: -1}}},
	})
	return err
}

// ListByProject returns all sessions for a project, sorted by startedAt descending.
func (s *SessionService) ListByProject(ctx context.Context, projectCode string) ([]models.SessionLog, error) {
	opts := options.Find().SetSort(bson.D{{Key: "startedAt", Value: -1}})
	cursor, err := s.collection.Find(ctx, bson.D{{Key: "projectCode", Value: projectCode}}, opts)
	if err != nil {
		return nil, fmt.Errorf("find sessions: %w", err)
	}
	defer cursor.Close(ctx)

	var sessions []models.SessionLog
	if err := cursor.All(ctx, &sessions); err != nil {
		return nil, fmt.Errorf("decode sessions: %w", err)
	}
	if sessions == nil {
		sessions = []models.SessionLog{}
	}
	return sessions, nil
}

// GetLatest returns the most recent session for a project.
func (s *SessionService) GetLatest(ctx context.Context, projectCode string) (*models.SessionLog, error) {
	opts := options.FindOne().SetSort(bson.D{{Key: "startedAt", Value: -1}})
	var session models.SessionLog
	err := s.collection.FindOne(ctx, bson.D{{Key: "projectCode", Value: projectCode}}, opts).Decode(&session)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("no sessions found for project")
		}
		return nil, fmt.Errorf("find latest session: %w", err)
	}
	return &session, nil
}

// Create inserts a new session with status=active and startedAt=now.
func (s *SessionService) Create(ctx context.Context, projectCode string) (*models.SessionLog, error) {
	now := time.Now().UTC()
	session := models.SessionLog{
		ProjectCode:    projectCode,
		StartedAt:      now,
		IssuesWorkedOn: []string{},
		Status:         models.SessionStatusActive,
	}

	result, err := s.collection.InsertOne(ctx, session)
	if err != nil {
		return nil, fmt.Errorf("insert session: %w", err)
	}

	session.ID = result.InsertedID.(bson.ObjectID)
	return &session, nil
}

// Update applies partial updates to a session identified by its ObjectID hex string.
func (s *SessionService) Update(ctx context.Context, id string, req *models.UpdateSessionRequest) (*models.SessionLog, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, fmt.Errorf("invalid session ID: %w", err)
	}

	setFields := bson.D{}
	if req.Status != nil {
		setFields = append(setFields, bson.E{Key: "status", Value: *req.Status})
		if *req.Status == models.SessionStatusCompleted {
			now := time.Now().UTC()
			setFields = append(setFields, bson.E{Key: "endedAt", Value: now})
		}
	}
	if req.Summary != nil {
		setFields = append(setFields, bson.E{Key: "summary", Value: *req.Summary})
	}
	if req.IssuesWorkedOn != nil {
		setFields = append(setFields, bson.E{Key: "issuesWorkedOn", Value: *req.IssuesWorkedOn})
	}

	if len(setFields) == 0 {
		return s.GetByID(ctx, id)
	}

	update := bson.D{{Key: "$set", Value: setFields}}
	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)

	var session models.SessionLog
	err = s.collection.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: oid}}, update, opts).Decode(&session)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("session not found")
		}
		return nil, fmt.Errorf("update session: %w", err)
	}
	return &session, nil
}

// GetByID retrieves a session by its ObjectID hex string.
func (s *SessionService) GetByID(ctx context.Context, id string) (*models.SessionLog, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, fmt.Errorf("invalid session ID: %w", err)
	}

	var session models.SessionLog
	err = s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: oid}}).Decode(&session)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("session not found")
		}
		return nil, fmt.Errorf("find session: %w", err)
	}
	return &session, nil
}
