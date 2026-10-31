package main

import (
	"context"
	"encoding/json"
	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"strings"
	"testing"
	"time"
)

type fakeStore struct {
	items       map[string]record
	condition   string
	values      map[string]any
	updateError error
	updates     int
}

func (f *fakeStore) Get(_ context.Context, pk, sk string) (record, error) {
	return f.items[pk+"/"+sk], nil
}
func (f *fakeStore) Put(_ context.Context, r record) error { f.items[r.PK+"/"+r.SK] = r; return nil }
func (f *fakeStore) Update(_ context.Context, sk, expression, condition string, values map[string]any) error {
	f.updates++
	f.condition = condition
	f.values = values
	return f.updateError
}
func (f *fakeStore) Peers(context.Context, string) ([]record, error) { return []record{}, nil }
func setup() (server, *fakeStore, string) {
	token := strings.Repeat("a", 64)
	db := &fakeStore{items: map[string]record{}}
	db.items["session:"+tokenKey(token)+"/session"] = record{Expires: 20000}
	db.items[roomKey+"/state"] = record{Owner: tokenKey(token), Lease: 10001000, Epoch: "epoch"}
	return server{db: db, now: func() time.Time { return time.UnixMilli(10000000) }}, db, token
}
func invoke(s server, token string, req request) events.LambdaFunctionURLResponse {
	b, _ := json.Marshal(req)
	out, _ := s.handle(context.Background(), events.LambdaFunctionURLRequest{Body: string(b), Headers: map[string]string{"authorization": "Bearer " + token}, RequestContext: events.LambdaFunctionURLRequestContext{HTTP: events.LambdaFunctionURLRequestContextHTTPDescription{Method: "POST"}}})
	return out
}
func TestJoin(t *testing.T) {
	s, db, _ := setup()
	if invoke(s, "", request{Action: "join", Code: "000000"}).StatusCode != 401 {
		t.Fatal("invalid code admitted")
	}
	r := invoke(s, "", request{Action: "join", Code: "313131"})
	var body map[string]string
	json.Unmarshal([]byte(r.Body), &body)
	session := db.items["session:"+tokenKey(body["token"])+"/session"]
	if r.StatusCode != 200 || len(body["token"]) != 64 || session.Expires != 17200 {
		t.Fatal("join or two-hour expiry failed")
	}
}
func TestExpiredSessionRejectedBeforeTTLDeletion(t *testing.T) {
	s, db, token := setup()
	db.items["session:"+tokenKey(token)+"/session"] = record{Expires: 9999}
	if invoke(s, token, request{Action: "claim"}).StatusCode != 401 || db.updates != 0 {
		t.Fatal("expired session was accepted")
	}
}
func TestClaimUsesAtomicLeaseCondition(t *testing.T) {
	s, db, token := setup()
	db.updateError = &types.ConditionalCheckFailedException{}
	r := invoke(s, token, request{Action: "claim"})
	if r.StatusCode != 409 || !strings.Contains(db.condition, "lease <= :now") {
		t.Fatal("claim must fail atomically while occupied")
	}
}
func TestViewerCannotAnswerOrRenew(t *testing.T) {
	s, db, token := setup()
	room := db.items[roomKey+"/state"]
	room.Owner = "another"
	db.items[roomKey+"/state"] = room
	for _, action := range []string{"answer", "heartbeat", "peers"} {
		if invoke(s, token, request{Action: action, Epoch: "epoch"}).StatusCode != 403 {
			t.Fatalf("viewer allowed %s", action)
		}
	}
}
func TestOldSharerCannotReleaseReplacement(t *testing.T) {
	s, db, token := setup()
	db.updateError = &types.ConditionalCheckFailedException{}
	if invoke(s, token, request{Action: "release", Epoch: "old"}).StatusCode != 409 || !strings.Contains(db.condition, "epoch = :epoch") {
		t.Fatal("release lacks generation protection")
	}
}
func TestExpiredLeaseRejectsSignaling(t *testing.T) {
	s, db, token := setup()
	room := db.items[roomKey+"/state"]
	room.Lease = 9999999
	db.items[roomKey+"/state"] = room
	if invoke(s, token, request{Action: "peers", Epoch: "epoch"}).StatusCode != 409 {
		t.Fatal("expired room allowed signaling")
	}
}
func TestViewerOfferCannotOverwriteOtherPeer(t *testing.T) {
	s, db, token := setup()
	room := db.items[roomKey+"/state"]
	room.Owner = "another"
	db.items[roomKey+"/state"] = room
	r := invoke(s, token, request{Action: "offer", Epoch: "epoch", Peer: "victim", SDP: "a-valid-offer"})
	key := roomKey + "/peer:epoch:" + tokenKey(token)
	if r.StatusCode != 200 || db.items[key].Peer != tokenKey(token) {
		t.Fatal("offer must use authenticated viewer identity")
	}
}
func TestHeartbeatCannotReviveExpiredOrReplacedLease(t *testing.T) {
	s, db, token := setup()
	invoke(s, token, request{Action: "heartbeat", Epoch: "epoch"})
	if !strings.Contains(db.condition, "lease > :now") || !strings.Contains(db.condition, "owner = :owner AND epoch = :epoch") {
		t.Fatal("heartbeat is missing lease fencing")
	}
}

func TestAnswerIsFencedToExactOffer(t *testing.T) {
	s, db, token := setup()
	db.updateError = &types.ConditionalCheckFailedException{}
	r := invoke(s, token, request{Action: "answer", Epoch: "epoch", Peer: strings.Repeat("b", 64), SDP: "answer-for-old-offer", Offer: "old-offer"})
	if r.StatusCode != 409 || db.condition != "offer = :offer" || db.values[":offer"] != "old-offer" {
		t.Fatal("a delayed answer must not overwrite a replacement offer")
	}
}
