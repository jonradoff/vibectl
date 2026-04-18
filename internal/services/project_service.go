package services

import (
	"context"
	"fmt"
	"regexp"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/jonradoff/vibectl/internal/events"
	"github.com/jonradoff/vibectl/internal/models"
)

var codePattern = regexp.MustCompile(`^[A-Z]{3,5}$`)

type ProjectService struct {
	db         *mongo.Database
	collection *mongo.Collection
	bus        *events.Bus
}

func NewProjectService(db *mongo.Database, bus *events.Bus) *ProjectService {
	return &ProjectService{
		db:         db,
		collection: db.Collection("projects"),
		bus:        bus,
	}
}

func (s *ProjectService) publish(eventType, projectCode string) {
	if s.bus != nil {
		s.bus.Publish(events.Event{Type: eventType, ProjectCode: projectCode})
	}
}

// EnsureIndexes creates indexes for the projects collection.
func (s *ProjectService) EnsureIndexes(ctx context.Context) error {
	_, err := s.collection.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "code", Value: 1}},
			Options: options.Index().SetUnique(true),
		},
		{
			Keys: bson.D{{Key: "parentId", Value: 1}},
		},
	})
	return err
}

// List returns all non-archived projects (including units), ordered by creation time descending.
func (s *ProjectService) List(ctx context.Context) ([]models.Project, error) {
	filter := bson.D{
		{Key: "archived", Value: bson.D{{Key: "$ne", Value: true}}},
	}
	opts := options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}})
	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("find projects: %w", err)
	}
	defer cursor.Close(ctx)

	var projects []models.Project
	if err := cursor.All(ctx, &projects); err != nil {
		return nil, fmt.Errorf("decode projects: %w", err)
	}
	if projects == nil {
		projects = []models.Project{}
	}
	return projects, nil
}

// ListArchived returns all archived projects, ordered by updatedAt descending.
func (s *ProjectService) ListArchived(ctx context.Context) ([]models.Project, error) {
	filter := bson.D{{Key: "archived", Value: true}}
	opts := options.Find().SetSort(bson.D{{Key: "updatedAt", Value: -1}})
	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("find archived projects: %w", err)
	}
	defer cursor.Close(ctx)

	var projects []models.Project
	if err := cursor.All(ctx, &projects); err != nil {
		return nil, fmt.Errorf("decode archived projects: %w", err)
	}
	if projects == nil {
		projects = []models.Project{}
	}
	return projects, nil
}

// Archive sets a project's archived flag to true. For multi-module projects, cascades to all units.
func (s *ProjectService) Archive(ctx context.Context, id string) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid project ID: %w", err)
	}
	now := time.Now().UTC()
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "archived", Value: true},
		{Key: "updatedAt", Value: now},
	}}}
	result, err := s.collection.UpdateByID(ctx, oid, update)
	if err != nil {
		return fmt.Errorf("archive project: %w", err)
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("project not found")
	}
	// Cascade archive to units if this is a multi-module project.
	s.collection.UpdateMany(ctx, bson.D{{Key: "parentId", Value: oid}}, update)
	s.publish("project.updated", id)
	return nil
}

// Unarchive sets a project's archived flag to false.
func (s *ProjectService) Unarchive(ctx context.Context, id string) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid project ID: %w", err)
	}
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "archived", Value: false},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}}
	result, err := s.collection.UpdateByID(ctx, oid, update)
	if err != nil {
		return fmt.Errorf("unarchive project: %w", err)
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("project not found")
	}
	s.publish("project.updated", id)
	return nil
}

// Create validates the request and inserts a new project.
// For multi-module projects (projectType="multi" with units), use CreateMultiModule instead.
func (s *ProjectService) Create(ctx context.Context, req *models.CreateProjectRequest) (*models.Project, error) {
	if req.Name == "" {
		return nil, fmt.Errorf("project name is required")
	}
	if req.Code == "" {
		return nil, fmt.Errorf("project code is required")
	}
	if !codePattern.MatchString(req.Code) {
		return nil, fmt.Errorf("project code must be 3-5 uppercase letters")
	}

	// Check uniqueness of code.
	count, err := s.collection.CountDocuments(ctx, bson.D{{Key: "code", Value: req.Code}})
	if err != nil {
		return nil, fmt.Errorf("check code uniqueness: %w", err)
	}
	if count > 0 {
		return nil, fmt.Errorf("project with code %q already exists", req.Code)
	}

	now := time.Now().UTC()
	goals := req.Goals
	if goals == nil {
		goals = []string{}
	}

	project := models.Project{
		Name:         req.Name,
		Code:         req.Code,
		Description:  req.Description,
		Links:        req.Links,
		Goals:        goals,
		ProjectType:  req.ProjectType,
		IssueCounter: 0,
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	result, err := s.collection.InsertOne(ctx, project)
	if err != nil {
		return nil, fmt.Errorf("insert project: %w", err)
	}

	project.ID = result.InsertedID.(bson.ObjectID)
	s.publish("project.created", project.Code)
	return &project, nil
}

// GetByID retrieves a project by its ObjectID hex string.
func (s *ProjectService) GetByID(ctx context.Context, id string) (*models.Project, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, fmt.Errorf("invalid project ID: %w", err)
	}

	var project models.Project
	err = s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: oid}}).Decode(&project)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("project not found")
		}
		return nil, fmt.Errorf("find project: %w", err)
	}
	return &project, nil
}

// GetByCode retrieves a project by its unique code.
func (s *ProjectService) GetByCode(ctx context.Context, code string) (*models.Project, error) {
	var project models.Project
	err := s.collection.FindOne(ctx, bson.D{{Key: "code", Value: code}}).Decode(&project)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("project not found")
		}
		return nil, fmt.Errorf("find project by code: %w", err)
	}
	return &project, nil
}

// Update applies partial updates to a project identified by its ObjectID hex string.
func (s *ProjectService) Update(ctx context.Context, id string, req *models.UpdateProjectRequest) (*models.Project, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, fmt.Errorf("invalid project ID: %w", err)
	}

	setFields := bson.D{
		{Key: "updatedAt", Value: time.Now().UTC()},
	}
	if req.Name != nil {
		setFields = append(setFields, bson.E{Key: "name", Value: *req.Name})
	}
	if req.Description != nil {
		setFields = append(setFields, bson.E{Key: "description", Value: *req.Description})
	}
	if req.Links != nil {
		setFields = append(setFields, bson.E{Key: "links", Value: *req.Links})
	}
	if req.Goals != nil {
		setFields = append(setFields, bson.E{Key: "goals", Value: *req.Goals})
	}
	if req.HealthCheck != nil {
		setFields = append(setFields, bson.E{Key: "healthCheck", Value: *req.HealthCheck})
	}
	if req.Deployment != nil {
		setFields = append(setFields, bson.E{Key: "deployment", Value: *req.Deployment})
	}
	if req.Webhooks != nil {
		setFields = append(setFields, bson.E{Key: "webhooks", Value: *req.Webhooks})
	}
	if req.Tags != nil {
		setFields = append(setFields, bson.E{Key: "tags", Value: *req.Tags})
	}
	if req.Inactive != nil {
		setFields = append(setFields, bson.E{Key: "inactive", Value: *req.Inactive})
	}

	update := bson.D{{Key: "$set", Value: setFields}}

	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var project models.Project
	err = s.collection.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: oid}}, update, opts).Decode(&project)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("project not found")
		}
		return nil, fmt.Errorf("update project: %w", err)
	}
	s.publish("project.updated", id)
	return &project, nil
}

// SetField sets a single field on a project.
func (s *ProjectService) SetField(ctx context.Context, id string, field string, value interface{}) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return err
	}
	_, err = s.collection.UpdateByID(ctx, oid, bson.D{{Key: "$set", Value: bson.D{{Key: field, Value: value}}}})
	return err
}

// ListStale returns non-archived, non-inactive projects with no prompt_sent activity in `days` days.
func (s *ProjectService) ListStale(ctx context.Context, days int, activityLog *ActivityLogService) ([]models.Project, error) {
	projects, err := s.List(ctx)
	if err != nil {
		return nil, err
	}
	since := time.Now().UTC().AddDate(0, 0, -days)
	var stale []models.Project
	for _, p := range projects {
		if p.Archived || p.Inactive {
			continue
		}
		lastPrompt, err := activityLog.LastPromptAt(ctx, p.Code)
		if err != nil {
			continue
		}
		if lastPrompt == nil || lastPrompt.Before(since) {
			stale = append(stale, p)
		}
	}
	return stale, nil
}

// ListAllTags returns all unique tags across all non-archived projects.
func (s *ProjectService) ListAllTags(ctx context.Context) ([]string, error) {
	pipeline := bson.A{
		bson.D{{Key: "$match", Value: bson.D{{Key: "archived", Value: bson.D{{Key: "$ne", Value: true}}}}}},
		bson.D{{Key: "$unwind", Value: "$tags"}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$tags"}}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "_id", Value: 1}}}},
	}
	cursor, err := s.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("aggregate tags: %w", err)
	}
	defer cursor.Close(ctx)

	var tags []string
	for cursor.Next(ctx) {
		var result struct {
			ID string `bson:"_id"`
		}
		if err := cursor.Decode(&result); err == nil && result.ID != "" {
			tags = append(tags, result.ID)
		}
	}
	if tags == nil {
		tags = []string{}
	}
	return tags, nil
}

// Delete removes a project by its ObjectID hex string.
func (s *ProjectService) Delete(ctx context.Context, id string) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid project ID: %w", err)
	}

	result, err := s.collection.DeleteOne(ctx, bson.D{{Key: "_id", Value: oid}})
	if err != nil {
		return fmt.Errorf("delete project: %w", err)
	}
	if result.DeletedCount == 0 {
		return fmt.Errorf("project not found")
	}
	s.publish("project.deleted", id)
	return nil
}

// UpdateCloneStatus updates the cloneStatus and cloneError fields for a project.
func (s *ProjectService) UpdateCloneStatus(ctx context.Context, id, status, cloneErr string) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid project ID: %w", err)
	}
	_, err = s.collection.UpdateByID(ctx, oid, bson.D{{Key: "$set", Value: bson.D{
		{Key: "cloneStatus", Value: status},
		{Key: "cloneError", Value: cloneErr},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}})
	return err
}

// UpdateRecurringThemes sets the recurring themes for a project.
func (s *ProjectService) UpdateRecurringThemes(ctx context.Context, id string, themes []models.RecurringTheme) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid project ID: %w", err)
	}
	_, err = s.collection.UpdateByID(ctx, oid, bson.D{{Key: "$set", Value: bson.D{
		{Key: "recurringThemes", Value: themes},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}})
	return err
}

// UpdateArchitectureSummary sets the architecture summary for a project.
func (s *ProjectService) UpdateArchitectureSummary(ctx context.Context, id string, summary string) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid project ID: %w", err)
	}
	now := time.Now().UTC()
	_, err = s.collection.UpdateByID(ctx, oid, bson.D{{Key: "$set", Value: bson.D{
		{Key: "architectureSummary", Value: summary},
		{Key: "architectureUpdatedAt", Value: now},
		{Key: "updatedAt", Value: now},
	}}})
	return err
}

// SetPaused sets the paused state on a project.
func (s *ProjectService) SetPaused(ctx context.Context, id bson.ObjectID, paused bool) error {
	_, err := s.collection.UpdateByID(ctx, id, bson.D{{Key: "$set", Value: bson.D{
		{Key: "paused", Value: paused},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}})
	return err
}

// SetVibectlMdGeneratedAt updates the timestamp of last VIBECTL.md generation.
func (s *ProjectService) SetVibectlMdGeneratedAt(ctx context.Context, id string, t time.Time) error {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid project ID: %w", err)
	}
	_, err = s.collection.UpdateByID(ctx, oid, bson.D{{Key: "$set", Value: bson.D{
		{Key: "vibectlMdGeneratedAt", Value: t},
	}}})
	return err
}

// IncrementCounter atomically increments the project's issueCounter and returns the new value.
func (s *ProjectService) IncrementCounter(ctx context.Context, projectID bson.ObjectID) (int, error) {
	update := bson.D{{Key: "$inc", Value: bson.D{{Key: "issueCounter", Value: 1}}}}
	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)

	var project models.Project
	err := s.collection.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: projectID}}, update, opts).Decode(&project)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return 0, fmt.Errorf("project not found")
		}
		return 0, fmt.Errorf("increment counter: %w", err)
	}
	return project.IssueCounter, nil
}

// ── Multi-module methods ─────────────────────────────────────────────────────

// CreateMultiModule creates a multi-module orchestrator project and its initial units.
// Returns the parent project and the created unit projects.
func (s *ProjectService) CreateMultiModule(ctx context.Context, req *models.CreateProjectRequest) (*models.Project, []models.Project, error) {
	if len(req.Units) == 0 {
		return nil, nil, fmt.Errorf("multi-module project requires at least one unit")
	}

	// Validate all codes (parent + units) upfront.
	allCodes := []string{req.Code}
	for _, u := range req.Units {
		if u.Name == "" {
			return nil, nil, fmt.Errorf("unit name is required")
		}
		if u.Code == "" {
			return nil, nil, fmt.Errorf("unit code is required for %q", u.Name)
		}
		if !codePattern.MatchString(u.Code) {
			return nil, nil, fmt.Errorf("unit code %q must be 3-5 uppercase letters", u.Code)
		}
		if u.Path == "" {
			return nil, nil, fmt.Errorf("unit path is required for %q", u.Name)
		}
		allCodes = append(allCodes, u.Code)
	}

	// Check uniqueness of all codes in one query.
	count, err := s.collection.CountDocuments(ctx, bson.D{
		{Key: "code", Value: bson.D{{Key: "$in", Value: allCodes}}},
	})
	if err != nil {
		return nil, nil, fmt.Errorf("check code uniqueness: %w", err)
	}
	if count > 0 {
		return nil, nil, fmt.Errorf("one or more project codes already exist")
	}

	// Create parent project.
	req.ProjectType = "multi"
	parent, err := s.Create(ctx, req)
	if err != nil {
		return nil, nil, fmt.Errorf("create parent project: %w", err)
	}

	// Create unit projects.
	now := time.Now().UTC()
	units := make([]models.Project, 0, len(req.Units))
	for _, u := range req.Units {
		unitLocalPath := ""
		if parent.Links.LocalPath != "" {
			unitLocalPath = parent.Links.LocalPath + "/" + u.Path
		}
		unit := models.Project{
			Name:        u.Name,
			Code:        u.Code,
			Description: u.Description,
			Links: models.ProjectLinks{
				LocalPath: unitLocalPath,
			},
			Goals:        []string{},
			ProjectType:  "",
			ParentID:     &parent.ID,
			UnitName:     u.Name,
			UnitPath:     u.Path,
			IssueCounter: 0,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		result, insertErr := s.collection.InsertOne(ctx, unit)
		if insertErr != nil {
			return parent, units, fmt.Errorf("create unit %q: %w", u.Code, insertErr)
		}
		unit.ID = result.InsertedID.(bson.ObjectID)
		units = append(units, unit)
	}

	return parent, units, nil
}

// ListUnits returns all non-archived units for a multi-module project.
func (s *ProjectService) ListUnits(ctx context.Context, parentID bson.ObjectID) ([]models.Project, error) {
	filter := bson.D{
		{Key: "parentId", Value: parentID},
		{Key: "archived", Value: bson.D{{Key: "$ne", Value: true}}},
	}
	opts := options.Find().SetSort(bson.D{{Key: "unitName", Value: 1}})
	cursor, err := s.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("find units: %w", err)
	}
	defer cursor.Close(ctx)

	var units []models.Project
	if err := cursor.All(ctx, &units); err != nil {
		return nil, fmt.Errorf("decode units: %w", err)
	}
	if units == nil {
		units = []models.Project{}
	}
	return units, nil
}

// AddUnit creates a new unit under an existing multi-module project.
func (s *ProjectService) AddUnit(ctx context.Context, parentID bson.ObjectID, unit models.UnitDefinition) (*models.Project, error) {
	// Validate the unit definition.
	if unit.Name == "" {
		return nil, fmt.Errorf("unit name is required")
	}
	if unit.Code == "" {
		return nil, fmt.Errorf("unit code is required")
	}
	if !codePattern.MatchString(unit.Code) {
		return nil, fmt.Errorf("unit code must be 3-5 uppercase letters")
	}
	if unit.Path == "" {
		return nil, fmt.Errorf("unit path is required")
	}

	// Check code uniqueness.
	count, err := s.collection.CountDocuments(ctx, bson.D{{Key: "code", Value: unit.Code}})
	if err != nil {
		return nil, fmt.Errorf("check code uniqueness: %w", err)
	}
	if count > 0 {
		return nil, fmt.Errorf("project with code %q already exists", unit.Code)
	}

	// Get parent to derive local path.
	var parent models.Project
	if err := s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: parentID}}).Decode(&parent); err != nil {
		return nil, fmt.Errorf("parent project not found")
	}
	if parent.ProjectType != "multi" {
		return nil, fmt.Errorf("parent project is not a multi-module project")
	}

	unitLocalPath := ""
	if parent.Links.LocalPath != "" {
		unitLocalPath = parent.Links.LocalPath + "/" + unit.Path
	}

	now := time.Now().UTC()
	project := models.Project{
		Name:         unit.Name,
		Code:         unit.Code,
		Description:  unit.Description,
		Links:        models.ProjectLinks{LocalPath: unitLocalPath},
		Goals:        []string{},
		ParentID:     &parentID,
		UnitName:     unit.Name,
		UnitPath:     unit.Path,
		IssueCounter: 0,
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	result, err := s.collection.InsertOne(ctx, project)
	if err != nil {
		return nil, fmt.Errorf("insert unit: %w", err)
	}
	project.ID = result.InsertedID.(bson.ObjectID)
	s.publish("project.created", project.Code)
	return &project, nil
}

// DetachUnit removes the parent relationship from a unit, making it an independent project.
func (s *ProjectService) DetachUnit(ctx context.Context, unitID bson.ObjectID) error {
	update := bson.D{{Key: "$unset", Value: bson.D{
		{Key: "parentId", Value: ""},
		{Key: "unitName", Value: ""},
		{Key: "unitPath", Value: ""},
	}}, {Key: "$set", Value: bson.D{
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}}
	result, err := s.collection.UpdateByID(ctx, unitID, update)
	if err != nil {
		return fmt.Errorf("detach unit: %w", err)
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("unit not found")
	}
	s.publish("project.updated", unitID.Hex())
	return nil
}

// AttachUnit sets parentId on an existing project, making it a unit of a multi-module project.
func (s *ProjectService) AttachUnit(ctx context.Context, parentID, unitProjectID bson.ObjectID) (*models.Project, error) {
	var parent models.Project
	if err := s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: parentID}}).Decode(&parent); err != nil {
		return nil, fmt.Errorf("parent project not found")
	}
	if parent.ProjectType != "multi" {
		return nil, fmt.Errorf("parent project is not a multi-module project")
	}

	var target models.Project
	if err := s.collection.FindOne(ctx, bson.D{{Key: "_id", Value: unitProjectID}}).Decode(&target); err != nil {
		return nil, fmt.Errorf("target project not found")
	}
	if target.ParentID != nil {
		return nil, fmt.Errorf("project is already part of a multi-module project")
	}
	if target.ProjectType == "multi" {
		return nil, fmt.Errorf("cannot attach an orchestrator project as a unit")
	}

	unitPath := "units/" + target.Code
	update := bson.D{{Key: "$set", Value: bson.D{
		{Key: "parentId", Value: parentID},
		{Key: "unitName", Value: target.Name},
		{Key: "unitPath", Value: unitPath},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}}

	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var updated models.Project
	err := s.collection.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: unitProjectID}}, update, opts).Decode(&updated)
	if err != nil {
		return nil, fmt.Errorf("attach unit: %w", err)
	}
	s.publish("project.updated", unitProjectID.Hex())
	return &updated, nil
}
