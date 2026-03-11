/**
 * Linear workflow state names, configurable via environment variables.
 * Override these if your Linear workspace uses different state names.
 */
export const STATUS = {
  BACKLOG: process.env.STATUS_BACKLOG || "Backlog",
  IN_PROGRESS: process.env.STATUS_IN_PROGRESS || "In Progress",
  IN_DEVELOPMENT: process.env.STATUS_IN_DEVELOPMENT || "In Development",
  IN_REVIEW: process.env.STATUS_IN_REVIEW || "In Review",
  READY_FOR_RELEASE: process.env.STATUS_READY_FOR_RELEASE || "Ready for Release",
  DONE: process.env.STATUS_DONE || "Done",
  WAITING: process.env.STATUS_WAITING || "Waiting",
  ON_HOLD: process.env.STATUS_ON_HOLD || "On Hold",
  READY_FOR_QA: process.env.STATUS_READY_FOR_QA || "Ready for QA",
} as const;
