package handlers

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gpfaucher/agents/apps/dashboard/internal/store"
)

var agentNames = map[string]string{
	"pm": "Pieter", "engineer": "Joseph", "tester": "Hassan", "security": "Meneer", "docs": "Pierre",
}
var agentColors = map[string]string{
	"pm":       "bg-purple-500/20 text-purple-300",
	"engineer": "bg-blue-500/20 text-blue-300",
	"tester":   "bg-emerald-500/20 text-emerald-300",
	"security": "bg-amber-500/20 text-amber-300",
	"docs":     "bg-pink-500/20 text-pink-300",
}

var funcMap = template.FuncMap{
	"divMs": func(ms int64) int64 { return ms / 60000 },
	"div": func(a float64, b int) float64 {
		if b == 0 {
			return 0
		}
		return a / float64(b)
	},
	"pct": func(part, total float64) float64 {
		if total == 0 {
			return 0
		}
		return part / total * 100
	},
	"agentName": func(role string) string {
		if n, ok := agentNames[role]; ok {
			return n
		}
		return role
	},
	"agentColor": func(role string) string {
		if c, ok := agentColors[role]; ok {
			return c
		}
		return "bg-gray-500/20 text-gray-300"
	},
	"statusColor": func(status string) string {
		switch status {
		case "completed":
			return "text-emerald-400"
		case "failed":
			return "text-red-400"
		case "in_progress":
			return "text-blue-400"
		default:
			return "text-gray-400"
		}
	},
	"statusDot": func(status string) template.HTML {
		color := "bg-gray-500"
		switch status {
		case "completed":
			color = "bg-emerald-400"
		case "failed":
			color = "bg-red-400"
		case "in_progress":
			color = "bg-blue-400 pulse-dot"
		}
		return template.HTML(fmt.Sprintf(`<span class="w-1.5 h-1.5 rounded-full %s inline-block"></span> `, color))
	},
	"timeAgo": func(t time.Time) string {
		d := time.Since(t)
		switch {
		case d < time.Minute:
			return "just now"
		case d < time.Hour:
			return fmt.Sprintf("%dm ago", int(d.Minutes()))
		case d < 24*time.Hour:
			return fmt.Sprintf("%dh ago", int(d.Hours()))
		default:
			return fmt.Sprintf("%dd ago", int(d.Hours()/24))
		}
	},
	"prevOffset": func(offset int) int {
		n := offset - 50
		if n < 0 {
			return 0
		}
		return n
	},
	"nextOffset": func(offset int) int { return offset + 50 },
}

type Handlers struct {
	store     *store.Store
	templates map[string]*template.Template
}

func New(s *store.Store, templateFS embed.FS) *Handlers {
	h := &Handlers{store: s, templates: make(map[string]*template.Template)}

	pages := []string{"dashboard", "runs", "costs", "tasks", "live"}
	for _, p := range pages {
		tmpl, err := template.New("").Funcs(funcMap).ParseFS(templateFS, "templates/layout.html", "templates/"+p+".html")
		if err != nil {
			log.Fatalf("Failed to parse template %s: %v", p, err)
		}
		h.templates[p] = tmpl
	}
	return h
}

func (h *Handlers) render(w http.ResponseWriter, page string, data map[string]any) {
	tmpl, ok := h.templates[page]
	if !ok {
		http.Error(w, "Page not found", 404)
		return
	}
	data["Page"] = page
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := tmpl.ExecuteTemplate(w, "layout", data); err != nil {
		log.Printf("Template error (%s): %v", page, err)
		http.Error(w, "Render error", 500)
	}
}

func toJSON(v any) template.JS {
	b, _ := json.Marshal(v)
	return template.JS(b)
}

// ─── Pages ────────────────────────────────────────────────

func (h *Handlers) DashboardPage(w http.ResponseWriter, r *http.Request) {
	stats, _ := h.store.GetStats()
	runs, _ := h.store.ListRuns(10, 0, "", "")
	dailyCosts, _ := h.store.DailyCosts(14)
	roleCosts, _ := h.store.CostsByRole()

	h.render(w, "dashboard", map[string]any{
		"Stats":         stats,
		"RecentRuns":    runs,
		"DailyCostsJSON": toJSON(dailyCosts),
		"RoleCostsJSON":  toJSON(roleCosts),
	})
}

func (h *Handlers) RunsPage(w http.ResponseWriter, r *http.Request) {
	role := r.URL.Query().Get("role")
	status := r.URL.Query().Get("status")
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	if offset < 0 {
		offset = 0
	}

	runs, _ := h.store.ListRuns(50, offset, role, status)
	total, _ := h.store.CountRuns(role, status)

	h.render(w, "runs", map[string]any{
		"Runs":         runs,
		"TotalCount":   total,
		"FilterRole":   role,
		"FilterStatus": status,
		"Offset":       offset,
		"HasMore":      offset+50 < total,
	})
}

func (h *Handlers) CostsPage(w http.ResponseWriter, r *http.Request) {
	stats, _ := h.store.GetStats()
	summaries, _ := h.store.CostsByRole()
	dailyCosts, _ := h.store.DailyCosts(30)

	var totalCost float64
	var totalRuns int
	for _, s := range summaries {
		totalCost += s.TotalCost
		totalRuns += s.RunCount
	}

	h.render(w, "costs", map[string]any{
		"Summaries":     summaries,
		"TotalCost":     totalCost,
		"TotalRuns":     totalRuns,
		"WeekCost":      stats.WeekCost,
		"WeekRuns":      stats.WeekRuns,
		"TodayCost":     stats.TodayCost,
		"TodayRuns":     stats.TodayRuns,
		"AvgCost":       stats.AvgCostPerRun,
		"DailyCostsJSON": toJSON(dailyCosts),
		"RoleCostsJSON":  toJSON(summaries),
	})
}

func (h *Handlers) TasksPage(w http.ResponseWriter, r *http.Request) {
	tasks, _ := h.store.ListTasks(50, "")
	h.render(w, "tasks", map[string]any{
		"Tasks": tasks,
	})
}

func (h *Handlers) LivePage(w http.ResponseWriter, r *http.Request) {
	h.render(w, "live", map[string]any{})
}

// ─── API ──────────────────────────────────────────────────

func (h *Handlers) CreateRun(w http.ResponseWriter, r *http.Request) {
	var run store.AgentRun
	if err := json.NewDecoder(r.Body).Decode(&run); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	id, err := h.store.InsertRun(run)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int64{"id": id})
}

func (h *Handlers) ListRunsAPI(w http.ResponseWriter, r *http.Request) {
	runs, _ := h.store.ListRuns(100, 0, "", "")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(runs)
}

func (h *Handlers) StatsAPI(w http.ResponseWriter, r *http.Request) {
	stats, _ := h.store.GetStats()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

func (h *Handlers) CreateTask(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title       string `json:"title"`
		Description string `json:"description"`
		Repo        string `json:"repo"`
		Priority    int    `json:"priority"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Title == "" {
		http.Error(w, "Title is required", http.StatusBadRequest)
		return
	}
	if req.Priority == 0 {
		req.Priority = 3
	}

	task := store.Task{
		Title:       req.Title,
		Description: req.Description,
		Repo:        req.Repo,
		Priority:    req.Priority,
		Status:      "creating",
	}

	id, err := h.store.InsertTask(task)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Create Linear issue in background
	go h.createLinearIssue(id, req.Title, req.Description, req.Repo, req.Priority)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int64{"id": id})
}

func (h *Handlers) createLinearIssue(taskID int64, title, description, repo string, priority int) {
	apiKey := os.Getenv("LINEAR_API_KEY")
	teamID := os.Getenv("LINEAR_TEAM_ID")
	agentLabelID := os.Getenv("LINEAR_AGENT_LABEL_ID")
	repoLabelID := os.Getenv("LINEAR_REPO_LABEL_" + strings.ToUpper(strings.ReplaceAll(repo, "-", "_")))

	if apiKey == "" || teamID == "" {
		log.Printf("LINEAR_API_KEY or LINEAR_TEAM_ID not set, cannot create Linear issue for task %d", taskID)
		h.store.UpdateTaskStatus(taskID, "error")
		return
	}

	labelIDs := []string{}
	if agentLabelID != "" {
		labelIDs = append(labelIDs, `"`+agentLabelID+`"`)
	}
	if repoLabelID != "" {
		labelIDs = append(labelIDs, `"`+repoLabelID+`"`)
	}

	query := fmt.Sprintf(`mutation {
		issueCreate(input: {
			teamId: "%s"
			title: %s
			description: %s
			priority: %d
			labelIds: [%s]
		}) {
			success
			issue { id identifier url }
		}
	}`, teamID, jsonStr(title), jsonStr(description), priority, strings.Join(labelIDs, ","))

	body, _ := json.Marshal(map[string]string{"query": query})
	req, _ := http.NewRequest("POST", "https://api.linear.app/graphql", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("Linear API error for task %d: %v", taskID, err)
		h.store.UpdateTaskStatus(taskID, "error")
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	var result struct {
		Data struct {
			IssueCreate struct {
				Success bool `json:"success"`
				Issue   struct {
					ID         string `json:"id"`
					Identifier string `json:"identifier"`
					URL        string `json:"url"`
				} `json:"issue"`
			} `json:"issueCreate"`
		} `json:"data"`
	}

	if err := json.Unmarshal(respBody, &result); err != nil || !result.Data.IssueCreate.Success {
		log.Printf("Linear create failed for task %d: %s", taskID, string(respBody))
		h.store.UpdateTaskStatus(taskID, "error")
		return
	}

	issue := result.Data.IssueCreate.Issue
	h.store.UpdateTaskLinear(taskID, issue.ID, issue.Identifier, issue.URL)
	log.Printf("Created Linear issue %s for task %d", issue.Identifier, taskID)
}

func jsonStr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// ─── Agent Status Proxy ──────────────────────────────────

var agentEndpoints = map[string]string{
	"pm":       "http://agent-pm-api:3000",
	"engineer": "http://agent-engineer-api:3000",
	"tester":   "http://agent-reviewer-api:3000",
	"security": "http://agent-security-api:3000",
	"docs":     "http://agent-docs-api:3000",
}

func (h *Handlers) AgentStatus(w http.ResponseWriter, r *http.Request) {
	// Extract role from URL: /api/agents/status/{role}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/agents/status/"), "/")
	role := parts[0]

	endpoint, ok := agentEndpoints[role]
	if !ok {
		http.Error(w, "Unknown agent", 404)
		return
	}

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(endpoint + "/status")
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		json.NewEncoder(w).Encode(map[string]string{"status": "offline", "error": err.Error()})
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
