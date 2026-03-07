/**
 * Linear workflow state names, configurable via environment variables.
 * Override these if your Linear workspace uses different state names.
 */
export const STATUS = {
  BACKLOG: process.env.STATUS_BACKLOG || "Backlog",
  IN_PROGRESS: process.env.STATUS_IN_PROGRESS || "In Progress",
  IN_DEVELOPMENT: process.env.STATUS_IN_DEVELOPMENT || "In Development",
  IN_REVIEW: process.env.STATUS_IN_REVIEW || "In Review",
  DONE: process.env.STATUS_DONE || "Done",
  WAITING: process.env.STATUS_WAITING || "Waiting",
} as const;
