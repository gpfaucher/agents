package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/gpfaucher/agents/apps/dashboard/internal/store"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Hub manages WebSocket subscribers per runKey.
type Hub struct {
	mu   sync.RWMutex
	subs map[string][]chan store.AgentMessage
}

func NewHub() *Hub {
	return &Hub{subs: make(map[string][]chan store.AgentMessage)}
}

func (h *Hub) Subscribe(runKey string) chan store.AgentMessage {
	ch := make(chan store.AgentMessage, 64)
	h.mu.Lock()
	h.subs[runKey] = append(h.subs[runKey], ch)
	h.mu.Unlock()
	return ch
}

func (h *Hub) Unsubscribe(runKey string, ch chan store.AgentMessage) {
	h.mu.Lock()
	defer h.mu.Unlock()
	subs := h.subs[runKey]
	for i, s := range subs {
		if s == ch {
			h.subs[runKey] = append(subs[:i], subs[i+1:]...)
			break
		}
	}
	if len(h.subs[runKey]) == 0 {
		delete(h.subs, runKey)
	}
	close(ch)
}

func (h *Hub) Broadcast(runKey string, msg store.AgentMessage) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, ch := range h.subs[runKey] {
		select {
		case ch <- msg:
		default:
			// slow consumer, drop message
		}
	}
}

// WsHandlers holds WebSocket-related HTTP handlers.
type WsHandlers struct {
	store *store.Store
	hub   *Hub
}

func NewWsHandlers(s *store.Store, hub *Hub) *WsHandlers {
	return &WsHandlers{store: s, hub: hub}
}

// StreamHandler upgrades to WebSocket and streams messages for a runKey.
// GET /ws/stream/{runKey}
func (wh *WsHandlers) StreamHandler(w http.ResponseWriter, r *http.Request) {
	runKey := extractRunKey(r.URL.Path, "/ws/stream/")
	if runKey == "" {
		http.Error(w, "Missing runKey", http.StatusBadRequest)
		return
	}

	// Get afterID for history replay
	afterID, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ws] Upgrade error: %v", err)
		return
	}
	defer conn.Close()

	// Send history first
	history, err := wh.store.ListMessages(runKey, 500, afterID)
	if err == nil {
		for _, msg := range history {
			data, _ := json.Marshal(msg)
			conn.WriteMessage(websocket.TextMessage, data)
		}
	}

	// Subscribe to live updates
	ch := wh.hub.Subscribe(runKey)
	defer wh.hub.Unsubscribe(runKey, ch)

	// Read pump (handles pongs and close)
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				break
			}
		}
	}()

	// Write pump
	for msg := range ch {
		data, _ := json.Marshal(msg)
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			break
		}
	}
}

// IngestHandler receives streamed messages from agents.
// POST /api/stream
func (wh *WsHandlers) IngestHandler(w http.ResponseWriter, r *http.Request) {
	var messages []store.AgentMessage

	// Support both single object and array
	body := json.NewDecoder(r.Body)
	var raw json.RawMessage
	if err := body.Decode(&raw); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if len(raw) > 0 && raw[0] == '[' {
		if err := json.Unmarshal(raw, &messages); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	} else {
		var msg store.AgentMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		messages = append(messages, msg)
	}

	for _, msg := range messages {
		if msg.RunKey == "" || msg.Content == "" {
			continue
		}
		id, err := wh.store.InsertMessage(msg)
		if err != nil {
			log.Printf("[ws] Insert error: %v", err)
			continue
		}
		msg.ID = id
		msg.CreatedAt = time.Now()
		wh.hub.Broadcast(msg.RunKey, msg)
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// ChatHandler receives chat messages from the browser and forwards to the agent.
// POST /api/chat/{runKey}
func (wh *WsHandlers) ChatHandler(w http.ResponseWriter, r *http.Request) {
	runKey := extractRunKey(r.URL.Path, "/api/chat/")
	if runKey == "" {
		http.Error(w, "Missing runKey", http.StatusBadRequest)
		return
	}

	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Content == "" {
		http.Error(w, "Content required", http.StatusBadRequest)
		return
	}

	// Parse runKey to get agent role
	parts := strings.SplitN(runKey, ":", 2)
	agentRole := parts[0]
	issueIdentifier := ""
	if len(parts) > 1 {
		issueIdentifier = parts[1]
	}

	// Store as chat_input message
	msg := store.AgentMessage{
		RunKey:          runKey,
		AgentRole:       agentRole,
		IssueIdentifier: issueIdentifier,
		MsgType:         "chat_input",
		Content:         req.Content,
	}
	id, err := wh.store.InsertMessage(msg)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	msg.ID = id
	msg.CreatedAt = time.Now()
	wh.hub.Broadcast(runKey, msg)

	// Forward to agent pod's /messages endpoint
	endpoint, ok := agentEndpoints[agentRole]
	if ok {
		go func() {
			body, _ := json.Marshal(map[string]string{"content": req.Content})
			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Post(endpoint+"/messages/"+runKey, "application/json", strings.NewReader(string(body)))
			if err != nil {
				log.Printf("[chat] Forward to %s failed: %v", agentRole, err)
				return
			}
			resp.Body.Close()
		}()
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]int64{"id": id})
}

// ActiveRunsHandler returns the list of active run keys.
// GET /api/active-runs
func (wh *WsHandlers) ActiveRunsHandler(w http.ResponseWriter, r *http.Request) {
	runs, err := wh.store.ActiveRuns()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(runs)
}

func extractRunKey(path, prefix string) string {
	return strings.TrimPrefix(path, prefix)
}
