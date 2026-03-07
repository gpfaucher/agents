package handlers

import (
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"

	"github.com/gpfaucher/agents/apps/dashboard/internal/store"
)

type Handlers struct {
	store *store.Store
}

func New(s *store.Store) *Handlers {
	return &Handlers{store: s}
}

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

func (h *Handlers) ListRuns(w http.ResponseWriter, r *http.Request) {
	runs, err := h.store.ListRuns(100)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(runs)
}

var agentsTemplate = template.Must(template.New("agents").Parse(`<!DOCTYPE html>
<html>
<head>
	<title>Agent Dashboard</title>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<script src="/static/htmx.min.js"></script>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
		h1 { margin-bottom: 1rem; color: #f1f5f9; }
		nav { margin-bottom: 2rem; }
		nav a { color: #38bdf8; text-decoration: none; margin-right: 1.5rem; font-weight: 500; }
		nav a:hover { text-decoration: underline; }
		table { width: 100%%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; }
		th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #334155; }
		th { background: #334155; color: #94a3b8; font-size: 0.85rem; text-transform: uppercase; }
		td { font-size: 0.9rem; }
		.badge { padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
		.badge-pm { background: #7c3aed; }
		.badge-engineer { background: #2563eb; }
		.badge-tester { background: #059669; }
		.cost { color: #fbbf24; }
	</style>
</head>
<body>
	<nav><a href="/agents">Agents</a><a href="/costs">Costs</a></nav>
	<h1>Recent Agent Runs</h1>
	<table>
		<thead>
			<tr><th>Issue</th><th>Role</th><th>Cost</th><th>Turns</th><th>Duration</th><th>Status</th><th>Time</th></tr>
		</thead>
		<tbody>
			{{range .Runs}}
			<tr>
				<td>{{.IssueIdentifier}}</td>
				<td><span class="badge badge-{{.AgentRole}}">{{.AgentRole}}</span></td>
				<td class="cost">${{printf "%.2f" .CostUsd}}</td>
				<td>{{.NumTurns}}</td>
				<td>{{printf "%.0f" (divMs .DurationMs)}}m</td>
				<td>{{.Status}}</td>
				<td>{{.CreatedAt.Format "Jan 02 15:04"}}</td>
			</tr>
			{{else}}
			<tr><td colspan="7" style="text-align:center;color:#64748b;">No runs yet</td></tr>
			{{end}}
		</tbody>
	</table>
</body>
</html>`))

func init() {
	agentsTemplate.Funcs(template.FuncMap{
		"divMs": func(ms int64) float64 { return float64(ms) / 60000 },
	})
	// Re-parse with funcs
	agentsTemplate = template.Must(template.New("agents").Funcs(template.FuncMap{
		"divMs": func(ms int64) float64 { return float64(ms) / 60000 },
	}).Parse(agentsTemplate.Tree.Root.String()))
}

func (h *Handlers) AgentsPage(w http.ResponseWriter, r *http.Request) {
	runs, err := h.store.ListRuns(50)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	tmpl := template.Must(template.New("agents").Funcs(template.FuncMap{
		"divMs": func(ms int64) float64 { return float64(ms) / 60000 },
	}).Parse(`<!DOCTYPE html>
<html>
<head>
	<title>Agent Dashboard</title>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
		h1 { margin-bottom: 1rem; color: #f1f5f9; }
		nav { margin-bottom: 2rem; }
		nav a { color: #38bdf8; text-decoration: none; margin-right: 1.5rem; font-weight: 500; }
		nav a:hover { text-decoration: underline; }
		table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; }
		th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #334155; }
		th { background: #334155; color: #94a3b8; font-size: 0.85rem; text-transform: uppercase; }
		td { font-size: 0.9rem; }
		.badge { padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
		.badge-pm { background: #7c3aed; }
		.badge-engineer { background: #2563eb; }
		.badge-tester { background: #059669; }
		.cost { color: #fbbf24; }
	</style>
</head>
<body>
	<nav><a href="/agents">Agents</a><a href="/costs">Costs</a></nav>
	<h1>Recent Agent Runs</h1>
	<table>
		<thead>
			<tr><th>Issue</th><th>Role</th><th>Cost</th><th>Turns</th><th>Duration</th><th>Status</th><th>Time</th></tr>
		</thead>
		<tbody>
			{{range .Runs}}
			<tr>
				<td>{{.IssueIdentifier}}</td>
				<td><span class="badge badge-{{.AgentRole}}">{{.AgentRole}}</span></td>
				<td class="cost">${{printf "%.2f" .CostUsd}}</td>
				<td>{{.NumTurns}}</td>
				<td>{{printf "%.0f" (divMs .DurationMs)}}m</td>
				<td>{{.Status}}</td>
				<td>{{.CreatedAt.Format "Jan 02 15:04"}}</td>
			</tr>
			{{else}}
			<tr><td colspan="7" style="text-align:center;color:#64748b;">No runs yet</td></tr>
			{{end}}
		</tbody>
	</table>
</body>
</html>`))

	w.Header().Set("Content-Type", "text/html")
	tmpl.Execute(w, map[string]any{"Runs": runs})
}

func (h *Handlers) CostsPage(w http.ResponseWriter, r *http.Request) {
	summaries, err := h.store.CostsByRole()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var totalCost float64
	var totalRuns int
	for _, s := range summaries {
		totalCost += s.TotalCost
		totalRuns += s.RunCount
	}

	tmpl := template.Must(template.New("costs").Parse(`<!DOCTYPE html>
<html>
<head>
	<title>Costs - Agent Dashboard</title>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
		h1 { margin-bottom: 1rem; color: #f1f5f9; }
		nav { margin-bottom: 2rem; }
		nav a { color: #38bdf8; text-decoration: none; margin-right: 1.5rem; font-weight: 500; }
		nav a:hover { text-decoration: underline; }
		.summary { display: flex; gap: 1.5rem; margin-bottom: 2rem; }
		.card { background: #1e293b; padding: 1.5rem; border-radius: 8px; min-width: 200px; }
		.card-label { color: #94a3b8; font-size: 0.85rem; text-transform: uppercase; margin-bottom: 0.5rem; }
		.card-value { font-size: 1.5rem; font-weight: 700; color: #fbbf24; }
		table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; }
		th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #334155; }
		th { background: #334155; color: #94a3b8; font-size: 0.85rem; text-transform: uppercase; }
	</style>
</head>
<body>
	<nav><a href="/agents">Agents</a><a href="/costs">Costs</a></nav>
	<h1>Cost Summary</h1>
	<div class="summary">
		<div class="card"><div class="card-label">Total Cost</div><div class="card-value">${{printf "%.2f" .TotalCost}}</div></div>
		<div class="card"><div class="card-label">Total Runs</div><div class="card-value">{{.TotalRuns}}</div></div>
	</div>
	<table>
		<thead><tr><th>Role</th><th>Cost</th><th>Runs</th><th>Avg Cost</th></tr></thead>
		<tbody>
			{{range .Summaries}}
			<tr>
				<td>{{.AgentRole}}</td>
				<td>${{printf "%.2f" .TotalCost}}</td>
				<td>{{.RunCount}}</td>
				<td>${{printf "%.2f" (div .TotalCost .RunCount)}}</td>
			</tr>
			{{end}}
		</tbody>
	</table>
</body>
</html>`))

	w.Header().Set("Content-Type", "text/html")
	tmpl.Funcs(template.FuncMap{
		"div": func(a float64, b int) float64 {
			if b == 0 {
				return 0
			}
			return a / float64(b)
		},
	})

	// Re-create with funcs
	costsTmpl := template.Must(template.New("costs").Funcs(template.FuncMap{
		"div": func(a float64, b int) float64 {
			if b == 0 {
				return 0
			}
			return a / float64(b)
		},
	}).Parse(fmt.Sprintf("%s", tmpl.Tree.Root.String())))

	costsTmpl.Execute(w, map[string]any{
		"Summaries": summaries,
		"TotalCost": totalCost,
		"TotalRuns": totalRuns,
	})
}
