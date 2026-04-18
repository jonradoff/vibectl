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

// CommentService manages issue comments.
type CommentService struct {
	db *mongo.Database
}

// NewCommentService creates a new CommentService.
func NewCommentService(db *mongo.Database) *CommentService {
	return &CommentService{db: db}
}

func (s *CommentService) collection() *mongo.Collection {
	return s.db.Collection("issue_comments")
}

// EnsureIndexes creates an index on issueKey for efficient querying.
func (s *CommentService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection().Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{{Key: "issueKey", Value: 1}},
	})
	return err
}

// ListByIssue returns all comments for an issue, sorted by createdAt ascending.
func (s *CommentService) ListByIssue(ctx context.Context, issueKey string) ([]models.IssueComment, error) {
	filter := bson.D{{Key: "issueKey", Value: issueKey}}
	opts := options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}})

	cursor, err := s.collection().Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("find comments: %w", err)
	}
	defer cursor.Close(ctx)

	var comments []models.IssueComment
	if err := cursor.All(ctx, &comments); err != nil {
		return nil, fmt.Errorf("decode comments: %w", err)
	}
	if comments == nil {
		comments = []models.IssueComment{}
	}
	return comments, nil
}

// Create inserts a new comment for an issue.
func (s *CommentService) Create(ctx context.Context, issueKey string, projectCode string, body, author string) (*models.IssueComment, error) {
	now := time.Now().UTC()
	comment := models.IssueComment{
		IssueKey:    issueKey,
		ProjectCode: projectCode,
		Body:        body,
		Author:      author,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	result, err := s.collection().InsertOne(ctx, comment)
	if err != nil {
		return nil, fmt.Errorf("insert comment: %w", err)
	}
	comment.ID = result.InsertedID.(bson.ObjectID)
	return &comment, nil
}

// Delete removes a comment by its ObjectID hex string.
func (s *CommentService) Delete(ctx context.Context, commentID string) error {
	oid, err := bson.ObjectIDFromHex(commentID)
	if err != nil {
		return fmt.Errorf("invalid comment ID: %w", err)
	}

	result, err := s.collection().DeleteOne(ctx, bson.D{{Key: "_id", Value: oid}})
	if err != nil {
		return fmt.Errorf("delete comment: %w", err)
	}
	if result.DeletedCount == 0 {
		return fmt.Errorf("comment not found")
	}
	return nil
}
