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

// ProjectMemberService manages project-level role assignments.
type ProjectMemberService struct {
	col     *mongo.Collection
	userSvc *UserService
}

func NewProjectMemberService(db *mongo.Database, userSvc *UserService) *ProjectMemberService {
	return &ProjectMemberService{col: db.Collection("project_members"), userSvc: userSvc}
}

func (s *ProjectMemberService) EnsureIndexes(ctx context.Context) error {
	_, err := s.col.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "projectCode", Value: 1}, {Key: "userId", Value: 1}},
			Options: options.Index().SetUnique(true),
		},
		{Keys: bson.D{{Key: "userId", Value: 1}}},
	})
	return err
}

// Upsert adds or updates a member's role in a project.
func (s *ProjectMemberService) Upsert(ctx context.Context, projectCode string, userID, createdBy bson.ObjectID, role models.ProjectRole) error {
	now := time.Now().UTC()
	_, err := s.col.UpdateOne(ctx,
		bson.D{{Key: "projectCode", Value: projectCode}, {Key: "userId", Value: userID}},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "role", Value: role},
			{Key: "createdBy", Value: createdBy},
			{Key: "createdAt", Value: now},
		}}},
		options.UpdateOne().SetUpsert(true),
	)
	return err
}

// Remove removes a member from a project.
func (s *ProjectMemberService) Remove(ctx context.Context, projectCode string, userID bson.ObjectID) error {
	_, err := s.col.DeleteOne(ctx, bson.D{{Key: "projectCode", Value: projectCode}, {Key: "userId", Value: userID}})
	return err
}

// GetRole returns the role for a user in a project, or "" if not a member.
func (s *ProjectMemberService) GetRole(ctx context.Context, projectCode string, userID bson.ObjectID) (models.ProjectRole, error) {
	var m models.ProjectMember
	err := s.col.FindOne(ctx, bson.D{{Key: "projectCode", Value: projectCode}, {Key: "userId", Value: userID}}).Decode(&m)
	if err == mongo.ErrNoDocuments {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return m.Role, nil
}

// HasRole returns true if the user has at least minRole in the project.
func (s *ProjectMemberService) HasRole(ctx context.Context, projectCode string, userID bson.ObjectID, minRole models.ProjectRole) (bool, error) {
	role, err := s.GetRole(ctx, projectCode, userID)
	if err != nil {
		return false, err
	}
	return models.ProjectRoleRank(role) >= models.ProjectRoleRank(minRole), nil
}

// ListByProject returns all members of a project with their user details.
func (s *ProjectMemberService) ListByProject(ctx context.Context, projectCode string) ([]models.ProjectMemberView, error) {
	cur, err := s.col.Find(ctx, bson.D{{Key: "projectCode", Value: projectCode}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var members []models.ProjectMember
	if err := cur.All(ctx, &members); err != nil {
		return nil, err
	}
	views := make([]models.ProjectMemberView, len(members))
	for i, m := range members {
		views[i] = models.ProjectMemberView{ProjectMember: m}
		if u, err := s.userSvc.GetByID(ctx, m.UserID); err == nil && u != nil {
			views[i].User = u
		}
	}
	return views, nil
}

// SeedOwner makes a user the owner of a project if they have no membership yet.
// Used during startup migration.
func (s *ProjectMemberService) SeedOwner(ctx context.Context, projectCode string, userID bson.ObjectID) error {
	count, err := s.col.CountDocuments(ctx, bson.D{{Key: "projectCode", Value: projectCode}, {Key: "userId", Value: userID}})
	if err != nil {
		return err
	}
	if count > 0 {
		return nil // already a member
	}
	return s.Upsert(ctx, projectCode, userID, userID, models.ProjectRoleOwner)
}

// ListProjectCodesForUser returns all project codes where the user is a member.
func (s *ProjectMemberService) ListProjectCodesForUser(ctx context.Context, userID bson.ObjectID) ([]string, error) {
	cur, err := s.col.Find(ctx, bson.D{{Key: "userId", Value: userID}}, options.Find().SetProjection(bson.D{{Key: "projectCode", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var results []struct {
		ProjectCode string `bson:"projectCode"`
	}
	if err := cur.All(ctx, &results); err != nil {
		return nil, err
	}
	codes := make([]string, len(results))
	for i, r := range results {
		codes[i] = r.ProjectCode
	}
	return codes, nil
}

// UserEffectiveRole returns the effective role for a user, taking into account
// super_admin bypass (super_admin always acts as owner).
func UserEffectiveRole(user *models.User, projectRole models.ProjectRole) models.ProjectRole {
	if user.GlobalRole == models.GlobalRoleSuperAdmin {
		return models.ProjectRoleOwner
	}
	return projectRole
}

// ValidateRole returns an error if the given string is not a valid ProjectRole.
func ValidateRole(r models.ProjectRole) error {
	switch r {
	case models.ProjectRoleOwner, models.ProjectRoleDevOps, models.ProjectRoleDeveloper,
		models.ProjectRoleContributor, models.ProjectRoleReporter, models.ProjectRoleViewer:
		return nil
	default:
		return fmt.Errorf("invalid role %q; valid roles: owner, devops, developer, contributor, reporter, viewer", r)
	}
}
