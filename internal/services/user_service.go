package services

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"golang.org/x/crypto/bcrypt"
)

const bcryptCost = 12

// UserService manages VibeCtl user accounts in the `users` collection.
type UserService struct {
	col            *mongo.Collection
	encryptionKey  string
}

func NewUserService(db *mongo.Database, encryptionKey string) *UserService {
	return &UserService{col: db.Collection("users"), encryptionKey: encryptionKey}
}

func (s *UserService) EnsureIndexes(ctx context.Context) error {
	_, err := s.col.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "email", Value: 1}}, Options: options.Index().SetSparse(true).SetUnique(true)},
		{Keys: bson.D{{Key: "githubId", Value: 1}}, Options: options.Index().SetSparse(true)},
		{Keys: bson.D{{Key: "globalRole", Value: 1}}},
	})
	return err
}

// Count returns the total number of user accounts.
func (s *UserService) Count(ctx context.Context) (int64, error) {
	return s.col.CountDocuments(ctx, bson.D{})
}

// GetByID retrieves a user by ObjectID.
func (s *UserService) GetByID(ctx context.Context, id bson.ObjectID) (*models.User, error) {
	var u models.User
	err := s.col.FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&u)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	return &u, err
}

// GetByIDHex retrieves a user by hex string ID.
func (s *UserService) GetByIDHex(ctx context.Context, hex string) (*models.User, error) {
	id, err := bson.ObjectIDFromHex(hex)
	if err != nil {
		return nil, fmt.Errorf("invalid user id: %w", err)
	}
	return s.GetByID(ctx, id)
}

// GetByEmail finds a user by email address (case-insensitive).
func (s *UserService) GetByEmail(ctx context.Context, email string) (*models.User, error) {
	var u models.User
	err := s.col.FindOne(ctx, bson.D{{Key: "email", Value: bson.D{{Key: "$regex", Value: "^" + email + "$"}, {Key: "$options", Value: "i"}}}}).Decode(&u)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	return &u, err
}

// GetByGitHubID finds a user by their numeric GitHub user ID.
func (s *UserService) GetByGitHubID(ctx context.Context, githubID string) (*models.User, error) {
	var u models.User
	err := s.col.FindOne(ctx, bson.D{{Key: "githubId", Value: githubID}}).Decode(&u)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	return &u, err
}

// GetByGitHubUsername finds a user by their GitHub login handle.
func (s *UserService) GetByGitHubUsername(ctx context.Context, username string) (*models.User, error) {
	var u models.User
	err := s.col.FindOne(ctx, bson.D{{Key: "githubUsername", Value: bson.D{{Key: "$regex", Value: "^" + username + "$"}, {Key: "$options", Value: "i"}}}}).Decode(&u)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	return &u, err
}

// List returns all users sorted by display name.
func (s *UserService) List(ctx context.Context) ([]models.User, error) {
	cur, err := s.col.Find(ctx, bson.D{}, options.Find().SetSort(bson.D{{Key: "displayName", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var users []models.User
	if err := cur.All(ctx, &users); err != nil {
		return nil, err
	}
	return users, nil
}

// PreAuthorize creates a pre-authorized user slot identified by a GitHub username.
// The user has no password — they must sign in via GitHub OAuth.
func (s *UserService) PreAuthorize(ctx context.Context, githubUsername, displayName string, globalRole models.GlobalRole, createdBy *bson.ObjectID) (*models.User, error) {
	if githubUsername == "" {
		return nil, fmt.Errorf("githubUsername is required")
	}
	if globalRole != models.GlobalRoleSuperAdmin && globalRole != models.GlobalRoleMember {
		globalRole = models.GlobalRoleMember
	}
	if displayName == "" {
		displayName = githubUsername
	}
	existing, err := s.GetByGitHubUsername(ctx, githubUsername)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, fmt.Errorf("a user with GitHub username %q already exists", githubUsername)
	}
	now := time.Now().UTC()
	u := models.User{
		DisplayName:    displayName,
		GitHubUsername: githubUsername,
		GlobalRole:     globalRole,
		Disabled:       false,
		CreatedBy:      createdBy,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	res, err := s.col.InsertOne(ctx, u)
	if err != nil {
		return nil, fmt.Errorf("inserting pre-authorized user: %w", err)
	}
	u.ID = res.InsertedID.(bson.ObjectID)
	return &u, nil
}

// CreateEmailUser creates a user with an email and a random temporary password.
// Returns the user and the plaintext temporary password (displayed once to the admin).
func (s *UserService) CreateEmailUser(ctx context.Context, email, displayName string, globalRole models.GlobalRole, createdBy *bson.ObjectID) (*models.User, string, error) {
	if email == "" {
		return nil, "", fmt.Errorf("email is required")
	}
	if globalRole != models.GlobalRoleSuperAdmin && globalRole != models.GlobalRoleMember {
		globalRole = models.GlobalRoleMember
	}
	if displayName == "" {
		displayName = email
	}
	existing, err := s.GetByEmail(ctx, email)
	if err != nil {
		return nil, "", err
	}
	if existing != nil {
		return nil, "", fmt.Errorf("a user with email %q already exists", email)
	}
	tempPassword := generateRandomPassword(12)
	hash, err := bcrypt.GenerateFromPassword([]byte(tempPassword), bcryptCost)
	if err != nil {
		return nil, "", fmt.Errorf("hashing password: %w", err)
	}
	now := time.Now().UTC()
	u := models.User{
		DisplayName:       displayName,
		Email:             email,
		PasswordHash:      string(hash),
		IsDefaultPassword: true,
		GlobalRole:        globalRole,
		Disabled:          false,
		CreatedBy:         createdBy,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	res, err := s.col.InsertOne(ctx, u)
	if err != nil {
		return nil, "", fmt.Errorf("inserting email user: %w", err)
	}
	u.ID = res.InsertedID.(bson.ObjectID)
	return &u, tempPassword, nil
}

// SetEmailPassword adds email+password login to an existing user (e.g. a pre-authorized GitHub user).
// Returns the plaintext temporary password.
func (s *UserService) SetEmailPassword(ctx context.Context, id bson.ObjectID, email string) (string, error) {
	u, err := s.GetByID(ctx, id)
	if err != nil || u == nil {
		return "", fmt.Errorf("user not found")
	}
	if email != "" {
		// Check for email uniqueness
		existing, err := s.GetByEmail(ctx, email)
		if err != nil {
			return "", err
		}
		if existing != nil && existing.ID != id {
			return "", fmt.Errorf("email %q is already in use", email)
		}
	} else if u.Email != "" {
		email = u.Email
	} else {
		return "", fmt.Errorf("email is required")
	}
	tempPassword := generateRandomPassword(12)
	hash, err := bcrypt.GenerateFromPassword([]byte(tempPassword), bcryptCost)
	if err != nil {
		return "", fmt.Errorf("hashing password: %w", err)
	}
	_, err = s.col.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{
		{Key: "email", Value: email},
		{Key: "passwordHash", Value: string(hash)},
		{Key: "isDefaultPassword", Value: true},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}})
	if err != nil {
		return "", err
	}
	return tempPassword, nil
}

// generateRandomPassword generates a random alphanumeric password of the given length.
func generateRandomPassword(length int) string {
	const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	result := make([]byte, length)
	for i := range result {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		result[i] = chars[n.Int64()]
	}
	return string(result)
}

// CreateAdminFallback creates the built-in admin account from an existing bcrypt hash.
// Used during startup migration when upgrading from single-admin to multi-user.
func (s *UserService) CreateAdminFallback(ctx context.Context, passwordHash string) (*models.User, error) {
	now := time.Now().UTC()
	u := models.User{
		DisplayName:       "Admin",
		Email:             "admin",
		PasswordHash:      passwordHash,
		IsDefaultPassword: false,
		GlobalRole:        models.GlobalRoleSuperAdmin,
		IsAdminFallback:   true,
		Disabled:          false,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	res, err := s.col.InsertOne(ctx, u)
	if err != nil {
		return nil, fmt.Errorf("inserting admin fallback user: %w", err)
	}
	u.ID = res.InsertedID.(bson.ObjectID)
	return &u, nil
}

// Update applies partial updates to a user's profile.
func (s *UserService) Update(ctx context.Context, id bson.ObjectID, req *models.UpdateUserRequest) (*models.User, error) {
	set := bson.D{{Key: "updatedAt", Value: time.Now().UTC()}}
	if req.DisplayName != nil {
		set = append(set, bson.E{Key: "displayName", Value: *req.DisplayName})
	}
	if req.Email != nil {
		set = append(set, bson.E{Key: "email", Value: *req.Email})
	}
	if req.GitName != nil {
		set = append(set, bson.E{Key: "gitName", Value: *req.GitName})
	}
	if req.GitEmail != nil {
		set = append(set, bson.E{Key: "gitEmail", Value: *req.GitEmail})
	}
	if req.GlobalRole != nil {
		set = append(set, bson.E{Key: "globalRole", Value: *req.GlobalRole})
	}
	if req.GitHubUsername != nil {
		set = append(set, bson.E{Key: "githubUsername", Value: *req.GitHubUsername})
	}
	if req.Disabled != nil {
		set = append(set, bson.E{Key: "disabled", Value: *req.Disabled})
	}
	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var updated models.User
	err := s.col.FindOneAndUpdate(ctx,
		bson.D{{Key: "_id", Value: id}},
		bson.D{{Key: "$set", Value: set}},
		opts,
	).Decode(&updated)
	return &updated, err
}

// ChangePassword validates the current password and sets a new bcrypt hash.
// Clears IsDefaultPassword on success.
func (s *UserService) ChangePassword(ctx context.Context, id bson.ObjectID, currentPassword, newPassword string) error {
	u, err := s.GetByID(ctx, id)
	if err != nil || u == nil {
		return fmt.Errorf("user not found")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(currentPassword)); err != nil {
		return fmt.Errorf("current password is incorrect")
	}
	return s.setPasswordHash(ctx, id, newPassword, false)
}


func (s *UserService) setPasswordHash(ctx context.Context, id bson.ObjectID, password string, isDefault bool) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return err
	}
	_, err = s.col.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{
		{Key: "passwordHash", Value: string(hash)},
		{Key: "isDefaultPassword", Value: isDefault},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}})
	return err
}

// ValidatePassword checks an email+password pair and returns the user on success.
func (s *UserService) ValidatePassword(ctx context.Context, emailOrAdmin, password string) (*models.User, error) {
	var u *models.User
	var err error
	if emailOrAdmin == "admin" {
		// Admin fallback lookup
		var tmp models.User
		err = s.col.FindOne(ctx, bson.D{{Key: "isAdminFallback", Value: true}}).Decode(&tmp)
		if err == nil {
			u = &tmp
		}
	} else {
		u, err = s.GetByEmail(ctx, emailOrAdmin)
	}
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	if u == nil {
		return nil, nil
	}
	if u.Disabled {
		return nil, fmt.Errorf("account is disabled")
	}
	if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password)) != nil {
		return nil, nil
	}
	// Update last login
	now := time.Now().UTC()
	s.col.UpdateOne(ctx, bson.D{{Key: "_id", Value: u.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "lastLoginAt", Value: now}}}})
	u.LastLoginAt = &now
	return u, nil
}

// LinkGitHub sets the github_id and github_username on an existing user.
func (s *UserService) LinkGitHub(ctx context.Context, id bson.ObjectID, githubID, githubUsername string) error {
	_, err := s.col.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{
		{Key: "githubId", Value: githubID},
		{Key: "githubUsername", Value: githubUsername},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}})
	return err
}

// UpdateLastLogin sets lastLoginAt to now.
func (s *UserService) UpdateLastLogin(ctx context.Context, id bson.ObjectID) {
	now := time.Now().UTC()
	s.col.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "lastLoginAt", Value: now}}}})
}

// SetAnthropicKey encrypts and stores the user's personal Anthropic API key.
func (s *UserService) SetAnthropicKey(ctx context.Context, id bson.ObjectID, rawKey string) error {
	if rawKey == "" {
		_, err := s.col.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{
			{Key: "anthropicKeyEncrypted", Value: ""},
			{Key: "hasAnthropicKey", Value: false},
			{Key: "updatedAt", Value: time.Now().UTC()},
		}}})
		return err
	}
	enc, err := encryptString(s.encryptionKey, rawKey)
	if err != nil {
		return fmt.Errorf("encrypting API key: %w", err)
	}
	_, err = s.col.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{
		{Key: "anthropicKeyEncrypted", Value: enc},
		{Key: "hasAnthropicKey", Value: true},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}})
	return err
}

// GetAnthropicKey decrypts and returns the user's personal Anthropic API key, or "" if not set.
func (s *UserService) GetAnthropicKey(ctx context.Context, id bson.ObjectID) (string, error) {
	u, err := s.GetByID(ctx, id)
	if err != nil || u == nil || u.AnthropicKeyEncrypted == "" {
		return "", err
	}
	return decryptString(s.encryptionKey, u.AnthropicKeyEncrypted)
}

// SetGitHubPAT encrypts and stores the user's GitHub Personal Access Token.
func (s *UserService) SetGitHubPAT(ctx context.Context, id bson.ObjectID, rawPAT string) error {
	if rawPAT == "" {
		_, err := s.col.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{
			{Key: "githubPatEncrypted", Value: ""},
			{Key: "hasGitHubPAT", Value: false},
			{Key: "updatedAt", Value: time.Now().UTC()},
		}}})
		return err
	}
	enc, err := encryptString(s.encryptionKey, rawPAT)
	if err != nil {
		return fmt.Errorf("encrypting GitHub PAT: %w", err)
	}
	_, err = s.col.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{
		{Key: "githubPatEncrypted", Value: enc},
		{Key: "hasGitHubPAT", Value: true},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}})
	return err
}

// GetGitHubPAT decrypts and returns the user's GitHub PAT, or "" if not set.
func (s *UserService) GetGitHubPAT(ctx context.Context, id bson.ObjectID) (string, error) {
	u, err := s.GetByID(ctx, id)
	if err != nil || u == nil || u.GitHubPATEncrypted == "" {
		return "", err
	}
	return decryptString(s.encryptionKey, u.GitHubPATEncrypted)
}

