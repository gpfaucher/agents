package server

import (
	"embed"
	"io/fs"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/gpfaucher/agents/apps/dashboard/internal/handlers"
	"github.com/gpfaucher/agents/apps/dashboard/internal/store"
)

type Server struct {
	store      *store.Store
	staticFS   embed.FS
	templateFS embed.FS
}

func New(s *store.Store, staticFS, templateFS embed.FS) *Server {
	return &Server{store: s, staticFS: staticFS, templateFS: templateFS}
}

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Compress(5))

	h := handlers.New(s.store, s.templateFS)

	// Pages
	r.Get("/", h.DashboardPage)
	r.Get("/runs", h.RunsPage)
	r.Get("/costs", h.CostsPage)
	r.Get("/tasks", h.TasksPage)
	r.Get("/live", h.LivePage)

	// Legacy redirects
	r.Get("/agents", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/runs", http.StatusMovedPermanently)
	})

	// API
	r.Post("/api/runs", h.CreateRun)
	r.Get("/api/runs", h.ListRunsAPI)
	r.Get("/api/stats", h.StatsAPI)
	r.Post("/api/tasks", h.CreateTask)

	// Agent status proxy
	r.Get("/api/agents/status/*", h.AgentStatus)

	// Static files
	sub, _ := fs.Sub(s.staticFS, "static")
	r.Handle("/static/*", http.StripPrefix("/static/", http.FileServer(http.FS(sub))))

	return r
}
