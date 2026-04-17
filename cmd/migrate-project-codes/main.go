// migrate-project-codes converts all projectId ObjectID references to project code strings.
// Run once after deploying the schema changes.
//
// Usage: go run ./cmd/migrate-project-codes
//
// Reads MONGODB_URI and DATABASE_NAME from .env or environment.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/joho/godotenv"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func main() {
	godotenv.Load()

	uri := os.Getenv("MONGODB_URI")
	dbName := os.Getenv("DATABASE_NAME")
	if uri == "" || dbName == "" {
		log.Fatal("MONGODB_URI and DATABASE_NAME must be set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer client.Disconnect(ctx)

	db := client.Database(dbName)

	// Step 1: Build project ID → code mapping
	projectsColl := db.Collection("projects")
	cursor, err := projectsColl.Find(ctx, bson.D{})
	if err != nil {
		log.Fatalf("find projects: %v", err)
	}
	type proj struct {
		ID   bson.ObjectID `bson:"_id"`
		Code string        `bson:"code"`
	}
	var projects []proj
	cursor.All(ctx, &projects)
	cursor.Close(ctx)

	idToCode := map[string]string{} // hex ObjectID → project code
	for _, p := range projects {
		idToCode[p.ID.Hex()] = p.Code
	}
	fmt.Printf("Found %d projects\n", len(projects))

	// Collections to migrate: {collection name, field name, nullable}
	type migration struct {
		collection string
		field      string // current BSON field name
		nullable   bool   // true if field is *bson.ObjectID (can be nil)
	}

	migrations := []migration{
		{"issues", "projectId", false},
		{"decisions", "projectId", false},
		{"comments", "projectId", false},
		{"sessions", "projectId", false},
		{"health_records", "projectId", false},
		{"project_members", "projectId", false},
		{"checkouts", "projectId", false},
		{"intents", "projectId", false},
		{"plans", "projectId", true},
		{"prompts", "projectId", true},
		{"feedback", "projectId", true},
		{"activity_logs", "projectId", true},
		{"code_deltas", "projectId", true},
	}

	for _, m := range migrations {
		coll := db.Collection(m.collection)

		// Find all documents with an ObjectID-type projectId
		cursor, err := coll.Find(ctx, bson.D{
			{Key: m.field, Value: bson.D{{Key: "$type", Value: "objectId"}}},
		})
		if err != nil {
			fmt.Printf("  %s: find error: %v\n", m.collection, err)
			continue
		}

		type doc struct {
			ID        bson.ObjectID  `bson:"_id"`
			ProjectID *bson.ObjectID `bson:"projectId,omitempty"`
		}
		var docs []doc
		cursor.All(ctx, &docs)
		cursor.Close(ctx)

		if len(docs) == 0 {
			fmt.Printf("  %s: 0 documents to migrate (already done or empty)\n", m.collection)
			continue
		}

		migrated := 0
		orphaned := 0
		for _, d := range docs {
			if d.ProjectID == nil {
				// Nullable field, already nil — set to empty string
				coll.UpdateByID(ctx, d.ID, bson.D{
					{Key: "$set", Value: bson.D{{Key: "projectCode", Value: ""}}},
					{Key: "$unset", Value: bson.D{{Key: "projectId", Value: ""}}},
				})
				migrated++
				continue
			}

			code, ok := idToCode[d.ProjectID.Hex()]
			if !ok {
				// Orphaned reference — project was deleted
				code = "UNKNOWN_" + d.ProjectID.Hex()[:8]
				orphaned++
			}

			// Set projectCode (new field) and remove projectId (old ObjectID field)
			_, err := coll.UpdateByID(ctx, d.ID, bson.D{
				{Key: "$set", Value: bson.D{{Key: "projectCode", Value: code}}},
				{Key: "$unset", Value: bson.D{{Key: "projectId", Value: ""}}},
			})
			if err != nil {
				fmt.Printf("  %s: update %s error: %v\n", m.collection, d.ID.Hex(), err)
			} else {
				migrated++
			}
		}

		fmt.Printf("  %s: migrated %d documents (%d orphaned)\n", m.collection, migrated, orphaned)
	}

	// Also migrate chat_history — it uses string projectId already, but rename the field
	chatColl := db.Collection("chat_history")
	result, err := chatColl.UpdateMany(ctx,
		bson.D{{Key: "projectId", Value: bson.D{{Key: "$exists", Value: true}}}},
		bson.A{
			bson.D{{Key: "$set", Value: bson.D{{Key: "projectCode", Value: "$projectId"}}}},
			bson.D{{Key: "$unset", Value: "projectId"}},
		},
	)
	if err != nil {
		fmt.Printf("  chat_history: error: %v\n", err)
	} else {
		fmt.Printf("  chat_history: renamed projectId→projectCode for %d documents\n", result.ModifiedCount)
	}

	// chat_sessions — already string, rename field
	chatSessionColl := db.Collection("chat_sessions")
	result, err = chatSessionColl.UpdateMany(ctx,
		bson.D{{Key: "projectId", Value: bson.D{{Key: "$exists", Value: true}}}},
		bson.A{
			bson.D{{Key: "$set", Value: bson.D{{Key: "projectCode", Value: "$projectId"}}}},
			bson.D{{Key: "$unset", Value: "projectId"}},
		},
	)
	if err != nil {
		fmt.Printf("  chat_sessions: error: %v\n", err)
	} else {
		fmt.Printf("  chat_sessions: renamed projectId→projectCode for %d documents\n", result.ModifiedCount)
	}

	// git_baselines — already string, rename
	blColl := db.Collection("git_baselines")
	result, err = blColl.UpdateMany(ctx,
		bson.D{{Key: "projectId", Value: bson.D{{Key: "$exists", Value: true}}}},
		bson.A{
			bson.D{{Key: "$set", Value: bson.D{{Key: "projectCode", Value: "$projectId"}}}},
			bson.D{{Key: "$unset", Value: "projectId"}},
		},
	)
	if err != nil {
		fmt.Printf("  git_baselines: error: %v\n", err)
	} else {
		fmt.Printf("  git_baselines: renamed projectId→projectCode for %d documents\n", result.ModifiedCount)
	}

	// claude_usage_records — already string, rename
	usageColl := db.Collection("claude_usage_records")
	result, err = usageColl.UpdateMany(ctx,
		bson.D{{Key: "projectId", Value: bson.D{{Key: "$exists", Value: true}}}},
		bson.A{
			bson.D{{Key: "$set", Value: bson.D{{Key: "projectCode", Value: "$projectId"}}}},
			bson.D{{Key: "$unset", Value: "projectId"}},
		},
	)
	if err != nil {
		fmt.Printf("  claude_usage_records: error: %v\n", err)
	} else {
		fmt.Printf("  claude_usage_records: renamed projectId→projectCode for %d documents\n", result.ModifiedCount)
	}

	fmt.Println("\nMigration complete! Now update indexes by restarting the server.")
}
