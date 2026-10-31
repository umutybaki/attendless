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

// fakeStore keeps items in memory. Conditions are not evaluated, except that a
// conditional Put over a live room fails, which is what room creation relies on.
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
func (f *fakeStore) Put(_ context.Context, r record, condition string, values map[string]any) error {
	if old, ok := f.items[r.PK+"/"+r.SK]; ok && condition != "" && !old.Ended && old.Expires > values[":now"].(int64) {
		return &types.ConditionalCheckFailedException{}
	}
	f.items[r.PK+"/"+r.SK] = r
	return nil
}
func (f *fakeStore) Update(_ context.Context, pk, sk, expression, condition string, values map[string]any) error {
	f.updates++
	f.condition = condition
	f.values = values
	return f.updateError
}
func (f *fakeStore) Query(_ context.Context, pk, prefix string) ([]record, error) {
	items := []record{}
	for key, item := range f.items {
		if strings.HasPrefix(key, pk+"/"+prefix) {
			items = append(items, item)
		}
	}
	return items, nil
}

const now = 10000000 // ms
var hostToken, viewerToken = strings.Repeat("a", 64), strings.Repeat("b", 64)

// A live room 123456 with a host and one viewer.
func setup() (server, *fakeStore) {
	db := &fakeStore{items: map[string]record{}}
	db.items["session:"+tokenKey(hostToken)+"/session"] = record{ID: "room-id", Code: "123456", Host: true, Expires: 20000}
	db.items["session:"+tokenKey(viewerToken)+"/session"] = record{ID: "room-id", Code: "123456", Expires: 20000}
	db.items[roomKey("123456")+"/room"] = record{ID: "room-id", Code: "123456", Owner: tokenKey(hostToken), Lease: now + 1000, Epoch: "epoch", Expires: 20000}
	return server{db: db, now: func() time.Time { return time.UnixMilli(now) }, code: randomCode}, db
}
func codes(list ...string) func() string {
	return func() string {
		next := list[0]
		list = list[1:]
		return next
	}
}
func invoke(s server, token string, req request) (int, map[string]any) {
	b, _ := json.Marshal(req)
	out, _ := s.handle(context.Background(), events.LambdaFunctionURLRequest{Body: string(b), Headers: map[string]string{"authorization": "Bearer " + token}, RequestContext: events.LambdaFunctionURLRequestContext{HTTP: events.LambdaFunctionURLRequestContextHTTPDescription{Method: "POST"}}})
	var body map[string]any
	json.Unmarshal([]byte(out.Body), &body)
	return out.StatusCode, body
}

func TestCreateIssuesCodeAndHostSession(t *testing.T) {
	s, db := setup()
	status, body := invoke(s, "", request{Action: "create"})
	code, token := body["code"].(string), body["token"].(string)
	session := db.items["session:"+tokenKey(token)+"/session"]
	room := db.items[roomKey(code)+"/room"]
	if status != 200 || !validCode.MatchString(code) || len(token) != 64 {
		t.Fatalf("create failed: %d %v", status, body)
	}
	if !session.Host || session.Code != code || room.Owner != tokenKey(token) || room.ID != session.ID || session.Expires != now/1000+lifetime {
		t.Fatal("create must bind a host session to the new room")
	}
}
func TestCreateSkipsCodesOfLiveRoomsAndReusesFinishedOnes(t *testing.T) {
	s, db := setup()
	db.items[roomKey("222222")+"/room"] = record{ID: "ended", Ended: true, Expires: 20000}
	db.items[roomKey("333333")+"/room"] = record{ID: "expired", Expires: 9999}
	for _, free := range []string{"222222", "333333", "444444"} {
		s.code = codes("123456", free)
		if _, body := invoke(s, "", request{Action: "create"}); body["code"] != free {
			t.Fatalf("expected %s after a collision, got %v", free, body)
		}
	}
	s.code = codes("123456", "123456", "123456", "123456", "123456")
	if status, _ := invoke(s, "", request{Action: "create"}); status != 503 || db.items[roomKey("123456")+"/room"].ID != "room-id" {
		t.Fatal("a live room's code was reused")
	}
}
func TestJoinRejectsUnknownEndedAndExpiredRooms(t *testing.T) {
	s, db := setup()
	for _, code := range []string{"000000", "12345", "abcdef"} {
		if status, _ := invoke(s, "", request{Action: "join", Code: code}); status != 404 {
			t.Fatalf("join %q admitted", code)
		}
	}
	room := db.items[roomKey("123456")+"/room"]
	for _, changed := range []record{{ID: room.ID, Ended: true, Expires: 20000}, {ID: room.ID, Expires: 9999}} {
		db.items[roomKey("123456")+"/room"] = changed
		if status, _ := invoke(s, "", request{Action: "join", Code: "123456"}); status != 404 {
			t.Fatal("join admitted an ended or expired room")
		}
	}
	db.items[roomKey("123456")+"/room"] = room
	status, body := invoke(s, "", request{Action: "join", Code: "123456"})
	session := db.items["session:"+tokenKey(body["token"].(string))+"/session"]
	if status != 200 || session.Host || session.ID != "room-id" {
		t.Fatal("join must create a viewer session for that room")
	}
}
func TestExpiredSessionRejectedBeforeTTLDeletion(t *testing.T) {
	s, db := setup()
	db.items["session:"+tokenKey(hostToken)+"/session"] = record{ID: "room-id", Code: "123456", Host: true, Expires: 9999}
	if status, _ := invoke(s, hostToken, request{Action: "claim"}); status != 401 || db.updates != 0 {
		t.Fatal("expired session was accepted")
	}
}
func TestSessionsOfAReusedCodeSeeTheirRoomEnded(t *testing.T) {
	s, db := setup()
	room := db.items[roomKey("123456")+"/room"]
	room.ID = "new-room"
	db.items[roomKey("123456")+"/room"] = room
	if status, body := invoke(s, viewerToken, request{Action: "status"}); status != 410 || body["ended"] != true {
		t.Fatal("an old session must not reach a new room under the same code")
	}
}
func TestViewerCannotUseHostActions(t *testing.T) {
	s, db := setup()
	for _, action := range []string{"claim", "heartbeat", "release", "end", "peers", "answer"} {
		if status, _ := invoke(s, viewerToken, request{Action: action, Epoch: "epoch"}); status != 403 {
			t.Fatalf("viewer allowed %s", action)
		}
	}
	if db.updates != 0 {
		t.Fatal("a rejected action wrote")
	}
}
func TestStatusCountsRecentViewersAndRecordsPresence(t *testing.T) {
	s, db := setup()
	db.items[roomKey("123456")+"/viewer:stale"] = record{Seen: now - presenceMS - 1}
	status, body := invoke(s, viewerToken, request{Action: "status"})
	if status != 200 || body["viewers"] != 1.0 || body["live"] != true || body["epoch"] != "epoch" || body["host"] != false {
		t.Fatalf("status wrong: %v", body)
	}
	if db.items[roomKey("123456")+"/viewer:"+tokenKey(viewerToken)].Seen != now {
		t.Fatal("viewer presence not recorded")
	}
	_, body = invoke(s, hostToken, request{Action: "status"})
	if body["host"] != true || body["viewers"] != 1.0 || db.items[roomKey("123456")+"/viewer:"+tokenKey(hostToken)].Seen != 0 {
		t.Fatal("the host must not count as a viewer")
	}
}
func TestHeartbeatIsFencedAndCarriesPause(t *testing.T) {
	s, db := setup()
	invoke(s, hostToken, request{Action: "heartbeat", Epoch: "epoch", Paused: true})
	if !strings.Contains(db.condition, "lease > :now") || !strings.Contains(db.condition, "owner = :owner AND epoch = :epoch") || db.values[":paused"] != true {
		t.Fatal("heartbeat is missing lease fencing or the pause flag")
	}
}
func TestOldSharerCannotReleaseReplacement(t *testing.T) {
	s, db := setup()
	db.updateError = &types.ConditionalCheckFailedException{}
	if status, _ := invoke(s, hostToken, request{Action: "release", Epoch: "old"}); status != 409 || !strings.Contains(db.condition, "epoch = :epoch") {
		t.Fatal("release lacks generation protection")
	}
}
func TestEndedRoomIsGoneForEveryone(t *testing.T) {
	s, db := setup()
	if status, _ := invoke(s, hostToken, request{Action: "end"}); status != 200 || db.values[":true"] != true {
		t.Fatal("host could not end the room")
	}
	room := db.items[roomKey("123456")+"/room"]
	room.Ended = true
	db.items[roomKey("123456")+"/room"] = room
	if status, _ := invoke(s, viewerToken, request{Action: "status"}); status != 410 {
		t.Fatal("viewer of an ended room was not told")
	}
}
func TestExpiredLeaseRejectsSignaling(t *testing.T) {
	s, db := setup()
	room := db.items[roomKey("123456")+"/room"]
	room.Lease = now - 1
	db.items[roomKey("123456")+"/room"] = room
	for _, action := range []string{"peers", "answer"} {
		if status, _ := invoke(s, hostToken, request{Action: action, Epoch: "epoch"}); status != 409 {
			t.Fatalf("expired lease allowed %s", action)
		}
	}
	if status, _ := invoke(s, viewerToken, request{Action: "offer", Epoch: "epoch", SDP: "a-valid-offer"}); status != 409 {
		t.Fatal("expired lease allowed an offer")
	}
}
func TestViewerOfferUsesAuthenticatedIdentity(t *testing.T) {
	s, db := setup()
	status, _ := invoke(s, viewerToken, request{Action: "offer", Epoch: "epoch", Peer: "victim", SDP: "a-valid-offer"})
	key := roomKey("123456") + "/peer:epoch:" + tokenKey(viewerToken)
	if status != 200 || db.items[key].Peer != tokenKey(viewerToken) {
		t.Fatal("offer must use authenticated viewer identity")
	}
	_, body := invoke(s, hostToken, request{Action: "peers", Epoch: "epoch"})
	if peers := body["peers"].([]any); len(peers) != 1 || peers[0].(map[string]any)["offer"] != "a-valid-offer" {
		t.Fatal("host did not receive the offer")
	}
}
func TestAnswerIsFencedToExactOffer(t *testing.T) {
	s, db := setup()
	db.updateError = &types.ConditionalCheckFailedException{}
	status, _ := invoke(s, hostToken, request{Action: "answer", Epoch: "epoch", Peer: strings.Repeat("c", 64), SDP: "answer-for-old-offer", Offer: "old-offer"})
	if status != 409 || db.condition != "offer = :offer" || db.values[":offer"] != "old-offer" {
		t.Fatal("a delayed answer must not overwrite a replacement offer")
	}
}
func TestAliasKeepsPlaceholders(t *testing.T) {
	names := map[string]string{}
	got := alias(names, "owner = :owner AND id = :id REMOVE epoch")
	if got != "#owner = :owner AND #id = :id REMOVE #epoch" || len(names) != 3 {
		t.Fatalf("alias: %q %v", got, names)
	}
}
