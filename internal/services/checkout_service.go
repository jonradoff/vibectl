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

const checkoutTTL = 12 * time.Hour

// CheckoutService manages exclusive code checkout locks per project.
type CheckoutService struct {
	col     *mongo.Collection
	userSvc *UserService
}

func NewCheckoutService(db *mongo.Database, userSvc *UserService) *CheckoutService {
	return &CheckoutService{col: db.Collection("code_checkouts"), userSvc: userSvc}
}

func (s *CheckoutService) EnsureIndexes(ctx context.Context) error {
	_, err := s.col.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "projectId", Value: 1}}, Options: options.Index().SetUnique(true)},
		// TTL: auto-expire documents when expiresAt passes
		{Keys: bson.D{{Key: "expiresAt", Value: 1}}, Options: options.Index().SetExpireAfterSeconds(0)},
	})
	return err
}

// GetStatus returns the current checkout status for a project.
func (s *CheckoutService) GetStatus(ctx context.Context, projectID, requestingUserID bson.ObjectID) (*models.CheckoutStatus, error) {
	var co models.CodeCheckout
	err := s.col.FindOne(ctx, bson.D{
		{Key: "projectId", Value: projectID},
		{Key: "expiresAt", Value: bson.D{{Key: "$gt", Value: time.Now().UTC()}}},
	}).Decode(&co)
	if err == mongo.ErrNoDocuments {
		return &models.CheckoutStatus{IsAvailable: true}, nil
	}
	if err != nil {
		return nil, err
	}
	status := &models.CheckoutStatus{
		Checkout:    &co,
		IsAvailable: false,
		IsYours:     co.UserID == requestingUserID,
	}
	if u, err := s.userSvc.GetByID(ctx, co.UserID); err == nil {
		status.HeldByUser = u
	}
	return status, nil
}

// Acquire tries to acquire the checkout for a project.
// Returns an error if already held by someone else (not expired).
func (s *CheckoutService) Acquire(ctx context.Context, projectID, userID bson.ObjectID) (*models.CodeCheckout, error) {
	now := time.Now().UTC()
	expires := now.Add(checkoutTTL)

	// Upsert: only succeed if not held by another user with a non-expired lock
	result := s.col.FindOneAndUpdate(ctx,
		bson.D{
			{Key: "projectId", Value: projectID},
			{Key: "$or", Value: bson.A{
				bson.D{{Key: "userId", Value: userID}},                            // already mine
				bson.D{{Key: "expiresAt", Value: bson.D{{Key: "$lte", Value: now}}}}, // expired
			}},
		},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "projectId", Value: projectID},
			{Key: "userId", Value: userID},
			{Key: "checkedOutAt", Value: now},
			{Key: "lastActivityAt", Value: now},
			{Key: "expiresAt", Value: expires},
		}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After),
	)
	var co models.CodeCheckout
	if err := result.Decode(&co); err != nil {
		// Check if another user holds a non-expired checkout
		existing, statErr := s.GetStatus(ctx, projectID, userID)
		if statErr == nil && existing.Checkout != nil && !existing.IsYours {
			return nil, fmt.Errorf("project is checked out by %s until %s",
				existing.HeldByUser.DisplayName, existing.Checkout.ExpiresAt.Format("15:04 MST"))
		}
		return nil, fmt.Errorf("acquiring checkout: %w", err)
	}
	return &co, nil
}

// Release releases the checkout held by the given user. Returns an error if not held by them.
func (s *CheckoutService) Release(ctx context.Context, projectID, userID bson.ObjectID) error {
	res, err := s.col.DeleteOne(ctx, bson.D{{Key: "projectId", Value: projectID}, {Key: "userId", Value: userID}})
	if err != nil {
		return err
	}
	if res.DeletedCount == 0 {
		return fmt.Errorf("you do not hold the checkout for this project")
	}
	return nil
}

// Reclaim force-releases the checkout regardless of who holds it. For project owners and super_admins.
func (s *CheckoutService) Reclaim(ctx context.Context, projectID bson.ObjectID) error {
	_, err := s.col.DeleteOne(ctx, bson.D{{Key: "projectId", Value: projectID}})
	return err
}

// TouchActivity refreshes the expiry of the current checkout (call during active prompt execution).
func (s *CheckoutService) TouchActivity(ctx context.Context, projectID, userID bson.ObjectID) error {
	now := time.Now().UTC()
	_, err := s.col.UpdateOne(ctx,
		bson.D{{Key: "projectId", Value: projectID}, {Key: "userId", Value: userID}},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "lastActivityAt", Value: now},
			{Key: "expiresAt", Value: now.Add(checkoutTTL)},
		}}},
	)
	return err
}
