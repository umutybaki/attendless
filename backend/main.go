package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"log"
	"math/big"
	"os"
	"regexp"
	"strings"
	"time"
)

// Rooms and sessions live six hours past the host's last activity; the camera
// lease lapses 12 seconds after its last heartbeat; a viewer counts as present
// while it polled within the last 10 seconds.
const (
	lifetime     int64 = 6 * 3600
	leaseMS      int64 = 12000
	presenceMS   int64 = 10000
	codeAttempts       = 5
	maxSDP             = 20000
)

var validCode = regexp.MustCompile(`^\d{6}$`)

type record struct {
	PK      string `dynamodbav:"pk" json:"-"`
	SK      string `dynamodbav:"sk" json:"-"`
	Expires int64  `dynamodbav:"expires" json:"-"`
	ID      string `dynamodbav:"id" json:"-"`
	Code    string `dynamodbav:"code" json:"-"`
	Host    bool   `dynamodbav:"host" json:"-"`
	Owner   string `dynamodbav:"owner" json:"-"`
	Ended   bool   `dynamodbav:"ended" json:"-"`
	Paused  bool   `dynamodbav:"paused" json:"-"`
	Lease   int64  `dynamodbav:"lease" json:"-"`
	Seen    int64  `dynamodbav:"seen" json:"-"`
	Epoch   string `dynamodbav:"epoch" json:"epoch,omitempty"`
	Peer    string `dynamodbav:"peer" json:"peer,omitempty"`
	Offer   string `dynamodbav:"offer" json:"offer,omitempty"`
	Answer  string `dynamodbav:"answer" json:"answer,omitempty"`
}

// Items: room:<code>/room (the room), session:<token hash>/session,
// room:<code>/viewer:<token hash> (presence), room:<code>/peer:<epoch>:<token hash> (signaling).
type store interface {
	Get(ctx context.Context, pk, sk string) (record, error)
	Put(ctx context.Context, r record, condition string, values map[string]any) error
	Update(ctx context.Context, pk, sk, expression, condition string, values map[string]any) error
	Query(ctx context.Context, pk, prefix string) ([]record, error)
}
type dbStore struct {
	client *dynamodb.Client
	table  string
}

func keyMap(pk, sk string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: pk}, "sk": &types.AttributeValueMemberS{Value: sk}}
}

// Alias field names so DynamoDB reserved words cannot invalidate expressions;
// :placeholders keep their names.
var fields = regexp.MustCompile(`:?\b(owner|epoch|lease|expires|offer|answer|ended|paused|seen|id|code|host)\b`)

func alias(names map[string]string, expression string) string {
	return fields.ReplaceAllStringFunc(expression, func(match string) string {
		if strings.HasPrefix(match, ":") {
			return match
		}
		names["#"+match] = match
		return "#" + match
	})
}
func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
func nonEmpty(names map[string]string) map[string]string {
	if len(names) == 0 {
		return nil
	}
	return names
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
func (d dbStore) Put(ctx context.Context, r record, condition string, values map[string]any) error {
	item, err := attributevalue.MarshalMap(r)
	if err != nil {
		return err
	}
	names := map[string]string{}
	condition = alias(names, condition)
	var av map[string]types.AttributeValue
	if len(values) > 0 {
		if av, err = attributevalue.MarshalMap(values); err != nil {
			return err
		}
	}
	_, err = d.client.PutItem(ctx, &dynamodb.PutItemInput{TableName: &d.table, Item: item, ConditionExpression: optional(condition), ExpressionAttributeNames: nonEmpty(names), ExpressionAttributeValues: av})
	return err
}
func (d dbStore) Update(ctx context.Context, pk, sk, expression, condition string, values map[string]any) error {
	names := map[string]string{}
	expression, condition = alias(names, expression), alias(names, condition)
	av, err := attributevalue.MarshalMap(values)
	if err != nil {
		return err
	}
	_, err = d.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{TableName: &d.table, Key: keyMap(pk, sk), UpdateExpression: &expression, ConditionExpression: optional(condition), ExpressionAttributeValues: av, ExpressionAttributeNames: nonEmpty(names)})
	return err
}
func (d dbStore) Query(ctx context.Context, pk, prefix string) ([]record, error) {
	out, err := d.client.Query(ctx, &dynamodb.QueryInput{TableName: &d.table, KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"), ExpressionAttributeValues: map[string]types.AttributeValue{":pk": &types.AttributeValueMemberS{Value: pk}, ":prefix": &types.AttributeValueMemberS{Value: prefix}}, ConsistentRead: aws.Bool(true)})
	if err != nil {
		return nil, err
	}
	items := []record{}
	err = attributevalue.UnmarshalListOfMaps(out.Items, &items)
	return items, err
}

type request struct {
	Action string `json:"action"`
	Code   string `json:"code"`
	Epoch  string `json:"epoch"`
	Peer   string `json:"peer"`
	SDP    string `json:"sdp"`
	Offer  string `json:"offer"`
	Paused bool   `json:"paused"`
}
type server struct {
	db   store
	now  func() time.Time
	code func() string
}

func response(status int, body any) (events.LambdaFunctionURLResponse, error) {
	b, _ := json.Marshal(body)
	return events.LambdaFunctionURLResponse{StatusCode: status, Headers: map[string]string{"Content-Type": "application/json", "Cache-Control": "no-store"}, Body: string(b)}, nil
}
func fail(status int, message string) (events.LambdaFunctionURLResponse, error) {
	return response(status, map[string]string{"error": message})
}
func unavailable(err error) (events.LambdaFunctionURLResponse, error) {
	log.Print(err)
	return fail(503, "Try again")
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
func randomCode() string {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		panic(err)
	}
	return fmt.Sprintf("%06d", n.Int64())
}
func conditional(err error) bool {
	var c *types.ConditionalCheckFailedException
	return errors.As(err, &c)
}
func roomKey(code string) string { return "room:" + code }

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
	expires := now/1000 + lifetime
	switch req.Action {
	case "create":
		return s.create(ctx, now, expires)
	case "join":
		return s.join(ctx, req.Code, now, expires)
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
		return unavailable(err)
	}
	if session.ID == "" || session.Expires <= now/1000 {
		return fail(401, "Enter the code again")
	}
	key := roomKey(session.Code)
	room, err := s.db.Get(ctx, key, "room")
	if err != nil {
		return unavailable(err)
	}
	// A reused code belongs to a new room; sessions of the old one see it as ended.
	if room.ID != session.ID || room.Ended || room.Expires <= now/1000 {
		return response(410, map[string]bool{"ended": true})
	}
	host := session.Host && room.Owner == owner
	live := room.Lease > now
	hostOnly := map[string]bool{"claim": true, "heartbeat": true, "release": true, "end": true, "peers": true, "answer": true}
	if hostOnly[req.Action] && !host {
		return fail(403, "Host only")
	}

	switch req.Action {
	case "status":
		if host {
			err = s.db.Update(ctx, key, "room", "SET expires = :ttl", "owner = :owner AND id = :id", map[string]any{":owner": owner, ":id": room.ID, ":ttl": expires})
		} else {
			err = s.db.Put(ctx, record{PK: key, SK: "viewer:" + owner, Seen: now, Expires: expires}, "", nil)
		}
		if err != nil && !conditional(err) {
			return unavailable(err)
		}
		viewers, err := s.viewers(ctx, key, now)
		if err != nil {
			return unavailable(err)
		}
		state := map[string]any{"live": live, "paused": live && room.Paused, "viewers": viewers, "host": host}
		if live {
			state["epoch"] = room.Epoch
		}
		return response(200, state)
	case "claim":
		epoch := randomID()
		err = s.db.Update(ctx, key, "room", "SET epoch = :epoch, lease = :lease, paused = :paused, expires = :ttl", "owner = :owner AND id = :id", map[string]any{":owner": owner, ":id": room.ID, ":epoch": epoch, ":lease": now + leaseMS, ":paused": false, ":ttl": expires})
		if err == nil {
			return response(200, map[string]string{"epoch": epoch})
		}
	case "heartbeat":
		err = s.db.Update(ctx, key, "room", "SET lease = :lease, paused = :paused, expires = :ttl", "owner = :owner AND epoch = :epoch AND lease > :now", map[string]any{":owner": owner, ":epoch": req.Epoch, ":now": now, ":lease": now + leaseMS, ":paused": req.Paused, ":ttl": expires})
		if err == nil {
			viewers, err := s.viewers(ctx, key, now)
			if err != nil {
				return unavailable(err)
			}
			return response(200, map[string]int{"viewers": viewers})
		}
	case "release":
		err = s.db.Update(ctx, key, "room", "SET lease = :zero REMOVE epoch", "owner = :owner AND epoch = :epoch", map[string]any{":owner": owner, ":epoch": req.Epoch, ":zero": 0})
	case "end":
		err = s.db.Update(ctx, key, "room", "SET ended = :true, lease = :zero", "owner = :owner AND id = :id", map[string]any{":owner": owner, ":id": room.ID, ":true": true, ":zero": 0})
	case "offer", "connection":
		if host || !live || req.Epoch != room.Epoch {
			return fail(409, "Sharing ended")
		}
		peerKey := "peer:" + req.Epoch + ":" + owner
		if req.Action == "connection" {
			peer, err := s.db.Get(ctx, key, peerKey)
			if err != nil {
				return unavailable(err)
			}
			return response(200, map[string]string{"answer": peer.Answer})
		}
		if len(req.SDP) < 10 || len(req.SDP) > maxSDP {
			return fail(400, "Invalid offer")
		}
		err = s.db.Put(ctx, record{PK: key, SK: peerKey, Epoch: req.Epoch, Peer: owner, Offer: req.SDP, Expires: expires}, "", nil)
	case "peers":
		if !live || req.Epoch != room.Epoch {
			return fail(409, "Sharing ended")
		}
		peers, err := s.db.Query(ctx, key, "peer:"+req.Epoch+":")
		if err != nil {
			return unavailable(err)
		}
		return response(200, map[string]any{"peers": peers})
	case "answer":
		if !live || req.Epoch != room.Epoch {
			return fail(409, "Sharing ended")
		}
		if len(req.Peer) != 64 || len(req.SDP) < 10 || len(req.SDP) > maxSDP {
			return fail(400, "Invalid answer")
		}
		err = s.db.Update(ctx, key, "peer:"+req.Epoch+":"+req.Peer, "SET answer = :answer", "offer = :offer", map[string]any{":answer": req.SDP, ":offer": req.Offer})
	default:
		return fail(400, "Unknown action")
	}
	if conditional(err) {
		return fail(409, "Sharing changed")
	}
	if err != nil {
		return unavailable(err)
	}
	return response(200, map[string]bool{"ok": true})
}

// Creates a room under a fresh code. A code is free when no room holds it or
// its room ended or expired (TTL deletion can lag by days).
func (s server) create(ctx context.Context, now, expires int64) (events.LambdaFunctionURLResponse, error) {
	token := randomID()
	owner := tokenKey(token)
	id := randomID()[:32]
	for range codeAttempts {
		code := s.code()
		err := s.db.Put(ctx, record{PK: roomKey(code), SK: "room", ID: id, Code: code, Owner: owner, Expires: expires}, "attribute_not_exists(pk) OR ended = :true OR expires <= :now", map[string]any{":true": true, ":now": now / 1000})
		if conditional(err) {
			continue
		}
		if err != nil {
			return unavailable(err)
		}
		if err := s.db.Put(ctx, record{PK: "session:" + owner, SK: "session", ID: id, Code: code, Host: true, Expires: expires}, "", nil); err != nil {
			return unavailable(err)
		}
		return response(200, map[string]string{"code": code, "token": token})
	}
	return fail(503, "Try again")
}

func (s server) join(ctx context.Context, code string, now, expires int64) (events.LambdaFunctionURLResponse, error) {
	if !validCode.MatchString(code) {
		return fail(404, "No room with that code")
	}
	room, err := s.db.Get(ctx, roomKey(code), "room")
	if err != nil {
		return unavailable(err)
	}
	if room.ID == "" || room.Ended || room.Expires <= now/1000 {
		return fail(404, "No room with that code")
	}
	token := randomID()
	if err := s.db.Put(ctx, record{PK: "session:" + tokenKey(token), SK: "session", ID: room.ID, Code: code, Expires: expires}, "", nil); err != nil {
		return unavailable(err)
	}
	return response(200, map[string]string{"token": token})
}

func (s server) viewers(ctx context.Context, key string, now int64) (int, error) {
	items, err := s.db.Query(ctx, key, "viewer:")
	count := 0
	for _, item := range items {
		if item.Seen > now-presenceMS {
			count++
		}
	}
	return count, err
}

func main() {
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	s := server{db: dbStore{dynamodb.NewFromConfig(cfg), os.Getenv("TABLE_NAME")}, now: time.Now, code: randomCode}
	lambda.Start(s.handle)
}
