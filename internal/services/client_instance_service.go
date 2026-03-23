package services

import (
	"context"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// ClientInstanceService manages client instance records in the database.
type ClientInstanceService struct {
	col *mongo.Collection
}

func NewClientInstanceService(db *mongo.Database) *ClientInstanceService {
	return &ClientInstanceService{col: db.Collection("client_instances")}
}

func (s *ClientInstanceService) EnsureIndexes(ctx context.Context) error {
	_, err := s.col.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "userId", Value: 1}},
		Options: options.Index().SetName("userId_1"),
	})
	return err
}

// Create inserts a new client instance owned by userID.
func (s *ClientInstanceService) Create(ctx context.Context, userID bson.ObjectID, req models.CreateClientInstanceRequest) (*models.ClientInstance, error) {
	now := time.Now()
	inst := &models.ClientInstance{
		ID:           bson.NewObjectID(),
		UserID:       userID,
		Name:         req.Name,
		Description:  req.Description,
		ProjectPaths: []models.ProjectPathEntry{},
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	_, err := s.col.InsertOne(ctx, inst)
	if err != nil {
		return nil, err
	}
	return inst, nil
}

// ListByUser returns all client instances owned by userID.
func (s *ClientInstanceService) ListByUser(ctx context.Context, userID bson.ObjectID) ([]*models.ClientInstance, error) {
	cur, err := s.col.Find(ctx, bson.M{"userId": userID})
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	var results []*models.ClientInstance
	return results, cur.All(ctx, &results)
}

// GetByID returns a client instance by its primary key.
func (s *ClientInstanceService) GetByID(ctx context.Context, id bson.ObjectID) (*models.ClientInstance, error) {
	var inst models.ClientInstance
	err := s.col.FindOne(ctx, bson.M{"_id": id}).Decode(&inst)
	if err != nil {
		return nil, err
	}
	return &inst, nil
}

// Update applies a partial update to a client instance and returns the updated record.
func (s *ClientInstanceService) Update(ctx context.Context, id bson.ObjectID, req models.UpdateClientInstanceRequest) (*models.ClientInstance, error) {
	update := bson.M{"updatedAt": time.Now()}
	if req.Name != "" {
		update["name"] = req.Name
	}
	if req.Description != "" {
		update["description"] = req.Description
	}
	if req.ProjectPaths != nil {
		update["projectPaths"] = req.ProjectPaths
	}
	_, err := s.col.UpdateOne(ctx, bson.M{"_id": id}, bson.M{"$set": update})
	if err != nil {
		return nil, err
	}
	return s.GetByID(ctx, id)
}

// Touch updates the lastSeenAt timestamp to now.
func (s *ClientInstanceService) Touch(ctx context.Context, id bson.ObjectID) error {
	now := time.Now()
	_, err := s.col.UpdateOne(ctx, bson.M{"_id": id}, bson.M{"$set": bson.M{"lastSeenAt": now}})
	return err
}

// Delete removes a client instance.
func (s *ClientInstanceService) Delete(ctx context.Context, id bson.ObjectID) error {
	_, err := s.col.DeleteOne(ctx, bson.M{"_id": id})
	return err
}
