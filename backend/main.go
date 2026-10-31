package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"log"
	"os"
	"regexp"
	"strings"
	"time"
)

const roomKey = "room:313131"
const leaseMS int64 = 12000

type record struct {
	PK      string `dynamodbav:"pk" json:"-"`
	SK      string `dynamodbav:"sk" json:"-"`
	Expires int64  `dynamodbav:"expires" json:"-"`
	Owner   string `dynamodbav:"owner" json:"-"`
	Lease   int64  `dynamodbav:"lease" json:"-"`
	Epoch   string `dynamodbav:"epoch" json:"epoch,omitempty"`
	Peer    string `dynamodbav:"peer" json:"peer,omitempty"`
	Offer   string `dynamodbav:"offer" json:"offer,omitempty"`
	Answer  string `dynamodbav:"answer" json:"answer,omitempty"`
}
type store interface {
	Get(context.Context, string, string) (record, error)
	Put(context.Context, record) error
	Update(context.Context, string, string, string, map[string]any) error
	Peers(context.Context, string) ([]record, error)
}
type dbStore struct {
	client *dynamodb.Client
	table  string
}

func keyMap(pk, sk string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: pk}, "sk": &types.AttributeValueMemberS{Value: sk}}
}
func (d dbStore) Get(ctx context.Context, pk, sk string) (record, error) {
	out, err := d.client.GetItem(ctx, &dynamodb.GetItemInput{TableName: &d.table, Key: keyMap(pk, sk), ConsistentRead: aws.Bool(true)})
	if err != nil {
		return record{}, err
	}
	var r record
	err = attributevalue.UnmarshalMap(out.Item, &r)
	return r, err
}
func (d dbStore) Put(ctx context.Context, r record) error {
	item, err := attributevalue.MarshalMap(r)
	if err != nil {
		return err
	}
	_, err = d.client.PutItem(ctx, &dynamodb.PutItemInput{TableName: &d.table, Item: item})
	return err
}
func (d dbStore) Update(ctx context.Context, sk, expression, condition string, values map[string]any) error {
	// Alias field names so DynamoDB reserved words cannot invalidate expressions.
	names := map[string]string{}
	fields := regexp.MustCompile(`\b(owner|epoch|lease|expires|offer|answer)\b`)
	alias := func(expression string) string {
		return fields.ReplaceAllStringFunc(expression, func(field string) string {
			names["#"+field] = field
			return "#" + field
		})
	}
	expression = strings.ReplaceAll(alias(expression), ":#", ":")
	condition = strings.ReplaceAll(alias(condition), ":#", ":")
	av, err := attributevalue.MarshalMap(values)
	if err != nil {
		return err
	}
	_, err = d.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{TableName: &d.table, Key: keyMap(roomKey, sk), UpdateExpression: &expression, ConditionExpression: &condition, ExpressionAttributeValues: av, ExpressionAttributeNames: names})
	return err
}
func (d dbStore) Peers(ctx context.Context, epoch string) ([]record, error) {
	out, err := d.client.Query(ctx, &dynamodb.QueryInput{TableName: &d.table, KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"), ExpressionAttributeValues: map[string]types.AttributeValue{":pk": &types.AttributeValueMemberS{Value: roomKey}, ":prefix": &types.AttributeValueMemberS{Value: "peer:" + epoch + ":"}}, ConsistentRead: aws.Bool(true), Limit: aws.Int32(50)})
	if err != nil {
		return nil, err
	}
	peers := []record{}
	err = attributevalue.UnmarshalListOfMaps(out.Items, &peers)
	return peers, err
}

type request struct {
	Action string `json:"action"`
	Code   string `json:"code"`
	Epoch  string `json:"epoch"`
	Peer   string `json:"peer"`
	SDP    string `json:"sdp"`
	Offer  string `json:"offer"`
}
type server struct {
	db  store
	now func() time.Time
}

func response(status int, body any) (events.LambdaFunctionURLResponse, error) {
	b, _ := json.Marshal(body)
	return events.LambdaFunctionURLResponse{StatusCode: status, Headers: map[string]string{"Content-Type": "application/json", "Cache-Control": "no-store"}, Body: string(b)}, nil
}
func fail(status int, message string) (events.LambdaFunctionURLResponse, error) {
	return response(status, map[string]string{"error": message})
}
func tokenKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func randomID() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func conditional(err error) bool {
	var c *types.ConditionalCheckFailedException
	return errors.As(err, &c)
}
func (s server) handle(ctx context.Context, event events.LambdaFunctionURLRequest) (events.LambdaFunctionURLResponse, error) {
	if event.RequestContext.HTTP.Method != "POST" {
		return fail(405, "Use POST")
	}
	if event.IsBase64Encoded || len(event.Body) > 60000 {
		return fail(413, "Invalid request body")
	}
	var req request
	if json.Unmarshal([]byte(event.Body), &req) != nil {
		return fail(400, "Invalid JSON")
	}
	now := s.now().UnixMilli()
	if req.Action == "join" {
		if req.Code != "313131" {
			return fail(401, "Incorrect code")
		}
		token := randomID()
		if err := s.db.Put(ctx, record{PK: "session:" + tokenKey(token), SK: "session", Expires: now/1000 + 7200}); err != nil {
			log.Print(err)
			return fail(503, "Try again")
		}
		return response(200, map[string]string{"token": token})
	}
	auth := event.Headers["authorization"]
	if auth == "" {
		auth = event.Headers["Authorization"]
	}
	token := strings.TrimPrefix(auth, "Bearer ")
	if len(token) != 64 {
		return fail(401, "Enter the code again")
	}
	owner := tokenKey(token)
	session, err := s.db.Get(ctx, "session:"+owner, "session")
	if err != nil {
		log.Print(err)
		return fail(503, "Try again")
	}
	if session.Expires <= now/1000 {
		return fail(401, "Enter the code again")
	}
	if req.Action == "claim" {
		epoch := randomID()
		err = s.db.Update(ctx, "state", "SET owner = :owner, epoch = :epoch, lease = :lease, expires = :ttl", "attribute_not_exists(lease) OR lease <= :now", map[string]any{":owner": owner, ":epoch": epoch, ":lease": now + leaseMS, ":now": now, ":ttl": now/1000 + 7200})
		if conditional(err) {
			return fail(409, "Someone is already sharing")
		}
		if err != nil {
			log.Print(err)
			return fail(503, "Try again")
		}
		return response(200, map[string]string{"epoch": epoch})
	}
	room, err := s.db.Get(ctx, roomKey, "state")
	if err != nil {
		log.Print(err)
		return fail(503, "Try again")
	}
	active := room.Lease > now
	if req.Action == "status" {
		return response(200, map[string]any{"active": active, "sharing": active && room.Owner == owner, "epoch": room.Epoch})
	}
	if req.Action == "release" {
		err = s.db.Update(ctx, "state", "SET lease = :zero REMOVE owner, epoch", "owner = :owner AND epoch = :epoch", map[string]any{":owner": owner, ":epoch": req.Epoch, ":zero": 0})
	} else {
		if !active || req.Epoch != room.Epoch {
			return fail(409, "Sharing ended")
		}
		sharer := owner == room.Owner
		switch req.Action {
		case "heartbeat":
			if !sharer {
				return fail(403, "Sharer only")
			}
			err = s.db.Update(ctx, "state", "SET lease = :lease, expires = :ttl", "owner = :owner AND epoch = :epoch AND lease > :now", map[string]any{":owner": owner, ":epoch": req.Epoch, ":now": now, ":lease": now + leaseMS, ":ttl": now/1000 + 7200})
		case "offer":
			if sharer || len(req.SDP) < 10 || len(req.SDP) > 20000 {
				return fail(400, "Invalid offer")
			}
			err = s.db.Put(ctx, record{PK: roomKey, SK: "peer:" + req.Epoch + ":" + owner, Epoch: req.Epoch, Peer: owner, Offer: req.SDP, Expires: now/1000 + 7200})
		case "answer":
			if !sharer {
				return fail(403, "Sharer only")
			}
			if len(req.Peer) != 64 || len(req.SDP) < 10 || len(req.SDP) > 20000 {
				return fail(400, "Invalid answer")
			}
			err = s.db.Update(ctx, "peer:"+req.Epoch+":"+req.Peer, "SET answer = :answer", "offer = :offer", map[string]any{":answer": req.SDP, ":offer": req.Offer})
		case "peers":
			if !sharer {
				return fail(403, "Sharer only")
			}
			peers, e := s.db.Peers(ctx, req.Epoch)
			if e != nil {
				log.Print(e)
				return fail(503, "Try again")
			}
			return response(200, map[string]any{"peers": peers})
		case "connection":
			peer, e := s.db.Get(ctx, roomKey, "peer:"+req.Epoch+":"+owner)
			if e != nil {
				log.Print(e)
				return fail(503, "Try again")
			}
			return response(200, map[string]string{"answer": peer.Answer})
		default:
			return fail(400, "Unknown action")
		}
	}
	if conditional(err) {
		return fail(409, "Sharing changed")
	}
	if err != nil {
		log.Print(err)
		return fail(503, "Try again")
	}
	return response(200, map[string]bool{"ok": true})
}
func main() {
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	s := server{db: dbStore{dynamodb.NewFromConfig(cfg), os.Getenv("TABLE_NAME")}, now: time.Now}
	lambda.Start(s.handle)
}
