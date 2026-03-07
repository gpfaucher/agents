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
			issue_id TEXT NOT NULL,
			issue_identifier TEXT NOT NULL,
			cost_usd REAL NOT NULL DEFAULT 0,
			num_turns INTEGER NOT NULL DEFAULT 0,
			duration_ms INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'completed',
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_agent_runs_role ON agent_runs(agent_role);
		CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at);
	`)
	return err
}

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

func (s *Store) ListRuns(limit int) ([]AgentRun, error) {
	rows, err := s.db.Query(
		`SELECT id, agent_role, issue_id, issue_identifier, cost_usd, num_turns, duration_ms, status, created_at
		 FROM agent_runs ORDER BY created_at DESC LIMIT ?`, limit,
	)
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

type CostSummary struct {
	AgentRole string  `json:"agentRole"`
	TotalCost float64 `json:"totalCost"`
	RunCount  int     `json:"runCount"`
}

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
