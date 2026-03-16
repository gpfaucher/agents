package store

import (
	"database/sql"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

type Store struct {
	db *sql.DB
}

type AgentRun struct {
	ID              int64     `json:"id"`
	AgentRole       string    `json:"agentRole"`
	IssueID         string    `json:"issueId"`
	IssueIdentifier string    `json:"issueIdentifier"`
	CostUsd         float64   `json:"costUsd"`
	NumTurns        int       `json:"numTurns"`
	DurationMs      int64     `json:"durationMs"`
	Status          string    `json:"status"`
	CreatedAt       time.Time `json:"createdAt"`
}

type Task struct {
	ID               int64     `json:"id"`
	Title            string    `json:"title"`
	Description      string    `json:"description"`
	Repo             string    `json:"repo"`
	AgentRole        string    `json:"agentRole"`
	Priority         int       `json:"priority"`
	Status           string    `json:"status"`
	LinearIssueID    string    `json:"linearIssueId"`
	LinearIdentifier string    `json:"linearIdentifier"`
	LinearURL        string    `json:"linearUrl"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

type CostSummary struct {
	AgentRole string  `json:"agentRole"`
	TotalCost float64 `json:"totalCost"`
	RunCount  int     `json:"runCount"`
}

type DailyCost struct {
	Date string  `json:"date"`
	Cost float64 `json:"cost"`
	Runs int     `json:"runs"`
}

type Stats struct {
	TotalRuns     int     `json:"totalRuns"`
	TotalCost     float64 `json:"totalCost"`
	TodayRuns     int     `json:"todayRuns"`
	TodayCost     float64 `json:"todayCost"`
	WeekRuns      int     `json:"weekRuns"`
	WeekCost      float64 `json:"weekCost"`
	SuccessRate   float64 `json:"successRate"`
	AvgCostPerRun float64 `json:"avgCostPerRun"`
	AvgDurationMs int64   `json:"avgDurationMs"`
	AvgTurns      int     `json:"avgTurns"`
}

func New(dbPath string) (*Store, error) {
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL")
	if err != nil {
		return nil, err
	}
	if err := migrate(db); err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func migrate(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS agent_runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			agent_role TEXT NOT NULL,
			issue_id TEXT NOT NULL DEFAULT '',
			issue_identifier TEXT NOT NULL DEFAULT '',
			cost_usd REAL NOT NULL DEFAULT 0,
			num_turns INTEGER NOT NULL DEFAULT 0,
			duration_ms INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'completed',
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_agent_runs_role ON agent_runs(agent_role);
		CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at);
		CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);

		CREATE TABLE IF NOT EXISTS tasks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			repo TEXT NOT NULL DEFAULT '',
			agent_role TEXT NOT NULL DEFAULT '',
			priority INTEGER NOT NULL DEFAULT 3,
			status TEXT NOT NULL DEFAULT 'pending',
			linear_issue_id TEXT NOT NULL DEFAULT '',
			linear_identifier TEXT NOT NULL DEFAULT '',
			linear_url TEXT NOT NULL DEFAULT '',
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

		CREATE TABLE IF NOT EXISTS agent_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			run_key TEXT NOT NULL,
			agent_role TEXT NOT NULL,
			issue_identifier TEXT NOT NULL DEFAULT '',
			msg_type TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_agent_messages_run ON agent_messages(run_key);
	`)
	return err
}

// ─── Runs ─────────────────────────────────────────────────

func (s *Store) InsertRun(run AgentRun) (int64, error) {
	result, err := s.db.Exec(
		`INSERT INTO agent_runs (agent_role, issue_id, issue_identifier, cost_usd, num_turns, duration_ms, status)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		run.AgentRole, run.IssueID, run.IssueIdentifier, run.CostUsd, run.NumTurns, run.DurationMs, run.Status,
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

func (s *Store) ListRuns(limit, offset int, role, status string) ([]AgentRun, error) {
	query := `SELECT id, agent_role, issue_id, issue_identifier, cost_usd, num_turns, duration_ms, status, created_at
		FROM agent_runs WHERE 1=1`
	args := []any{}
	if role != "" {
		query += " AND agent_role = ?"
		args = append(args, role)
	}
	if status != "" {
		query += " AND status = ?"
		args = append(args, status)
	}
	query += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
	args = append(args, limit, offset)

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var runs []AgentRun
	for rows.Next() {
		var r AgentRun
		if err := rows.Scan(&r.ID, &r.AgentRole, &r.IssueID, &r.IssueIdentifier, &r.CostUsd, &r.NumTurns, &r.DurationMs, &r.Status, &r.CreatedAt); err != nil {
			return nil, err
		}
		runs = append(runs, r)
	}
	return runs, nil
}

func (s *Store) CountRuns(role, status string) (int, error) {
	query := `SELECT COUNT(*) FROM agent_runs WHERE 1=1`
	args := []any{}
	if role != "" {
		query += " AND agent_role = ?"
		args = append(args, role)
	}
	if status != "" {
		query += " AND status = ?"
		args = append(args, status)
	}
	var count int
	err := s.db.QueryRow(query, args...).Scan(&count)
	return count, err
}

// ─── Costs ────────────────────────────────────────────────

func (s *Store) CostsByRole() ([]CostSummary, error) {
	rows, err := s.db.Query(
		`SELECT agent_role, SUM(cost_usd), COUNT(*) FROM agent_runs GROUP BY agent_role ORDER BY SUM(cost_usd) DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var summaries []CostSummary
	for rows.Next() {
		var cs CostSummary
		if err := rows.Scan(&cs.AgentRole, &cs.TotalCost, &cs.RunCount); err != nil {
			return nil, err
		}
		summaries = append(summaries, cs)
	}
	return summaries, nil
}

func (s *Store) DailyCosts(days int) ([]DailyCost, error) {
	rows, err := s.db.Query(
		`SELECT date(created_at) as d, SUM(cost_usd), COUNT(*)
		 FROM agent_runs
		 WHERE created_at >= date('now', ? || ' days')
		 GROUP BY d ORDER BY d`, -days,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var costs []DailyCost
	for rows.Next() {
		var dc DailyCost
		if err := rows.Scan(&dc.Date, &dc.Cost, &dc.Runs); err != nil {
			return nil, err
		}
		costs = append(costs, dc)
	}
	return costs, nil
}

// ─── Stats ────────────────────────────────────────────────

func (s *Store) GetStats() (Stats, error) {
	var st Stats

	s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(cost_usd),0), COALESCE(AVG(cost_usd),0), COALESCE(AVG(duration_ms),0), COALESCE(AVG(num_turns),0) FROM agent_runs`).
		Scan(&st.TotalRuns, &st.TotalCost, &st.AvgCostPerRun, &st.AvgDurationMs, &st.AvgTurns)

	s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(cost_usd),0) FROM agent_runs WHERE date(created_at) = date('now')`).
		Scan(&st.TodayRuns, &st.TodayCost)

	s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(cost_usd),0) FROM agent_runs WHERE created_at >= date('now', '-7 days')`).
		Scan(&st.WeekRuns, &st.WeekCost)

	var completed, total int
	s.db.QueryRow(`SELECT COUNT(*) FROM agent_runs WHERE status = 'completed'`).Scan(&completed)
	s.db.QueryRow(`SELECT COUNT(*) FROM agent_runs`).Scan(&total)
	if total > 0 {
		st.SuccessRate = float64(completed) / float64(total) * 100
	}

	return st, nil
}

// ─── Tasks ────────────────────────────────────────────────

func (s *Store) InsertTask(t Task) (int64, error) {
	result, err := s.db.Exec(
		`INSERT INTO tasks (title, description, repo, agent_role, priority, status, linear_issue_id, linear_identifier, linear_url)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.Title, t.Description, t.Repo, t.AgentRole, t.Priority, t.Status, t.LinearIssueID, t.LinearIdentifier, t.LinearURL,
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

func (s *Store) ListTasks(limit int, status string) ([]Task, error) {
	query := `SELECT id, title, description, repo, agent_role, priority, status, linear_issue_id, linear_identifier, linear_url, created_at, updated_at
		FROM tasks WHERE 1=1`
	args := []any{}
	if status != "" {
		query += " AND status = ?"
		args = append(args, status)
	}
	query += " ORDER BY created_at DESC LIMIT ?"
	args = append(args, limit)

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []Task
	for rows.Next() {
		var t Task
		if err := rows.Scan(&t.ID, &t.Title, &t.Description, &t.Repo, &t.AgentRole, &t.Priority, &t.Status, &t.LinearIssueID, &t.LinearIdentifier, &t.LinearURL, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		tasks = append(tasks, t)
	}
	return tasks, nil
}

func (s *Store) UpdateTaskLinear(id int64, linearID, identifier, url string) error {
	_, err := s.db.Exec(
		`UPDATE tasks SET linear_issue_id=?, linear_identifier=?, linear_url=?, status='submitted', updated_at=CURRENT_TIMESTAMP WHERE id=?`,
		linearID, identifier, url, id,
	)
	return err
}

func (s *Store) UpdateTaskStatus(id int64, status string) error {
	_, err := s.db.Exec(`UPDATE tasks SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, status, id)
	return err
}

// ─── Agent Messages ──────────────────────────────────────

type AgentMessage struct {
	ID              int64     `json:"id"`
	RunKey          string    `json:"runKey"`
	AgentRole       string    `json:"agentRole"`
	IssueIdentifier string    `json:"issueIdentifier"`
	MsgType         string    `json:"msgType"`
	Content         string    `json:"content"`
	CreatedAt       time.Time `json:"createdAt"`
}

func (s *Store) InsertMessage(msg AgentMessage) (int64, error) {
	result, err := s.db.Exec(
		`INSERT INTO agent_messages (run_key, agent_role, issue_identifier, msg_type, content) VALUES (?, ?, ?, ?, ?)`,
		msg.RunKey, msg.AgentRole, msg.IssueIdentifier, msg.MsgType, msg.Content,
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

func (s *Store) ListMessages(runKey string, limit int, afterID int64) ([]AgentMessage, error) {
	rows, err := s.db.Query(
		`SELECT id, run_key, agent_role, issue_identifier, msg_type, content, created_at
		 FROM agent_messages WHERE run_key = ? AND id > ? ORDER BY id ASC LIMIT ?`,
		runKey, afterID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []AgentMessage
	for rows.Next() {
		var m AgentMessage
		if err := rows.Scan(&m.ID, &m.RunKey, &m.AgentRole, &m.IssueIdentifier, &m.MsgType, &m.Content, &m.CreatedAt); err != nil {
			return nil, err
		}
		msgs = append(msgs, m)
	}
	return msgs, nil
}

func (s *Store) ActiveRuns() ([]string, error) {
	rows, err := s.db.Query(
		`SELECT DISTINCT run_key FROM agent_messages
		 WHERE created_at >= datetime('now', '-2 hours')
		 ORDER BY created_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var runs []string
	for rows.Next() {
		var rk string
		if err := rows.Scan(&rk); err != nil {
			return nil, err
		}
		runs = append(runs, rk)
	}
	return runs, nil
}
