# Jackrabbit Issue Tracker

## Capabilities

- **Ticket CRUD**: Create, read, update tickets via API
- **Status transitions**: Open → Groomed → In Progress → Ready for Review → Complete (Rejected)
- **Ticket types**: Epic (specs), Story (tickets), Bug, Spike
- **Blocking links**: Native `blocks`/`blocked_by` relationships for task graph dependencies
- **Epic→Story hierarchy**: Native `parent`/`child` links
- **Triage roles**: Labels mapped to canonical roles via `/triage/roles` endpoint
- **Transition metadata**: Branch name, PR URL, and groomed fields recorded during status transitions

## Configuration

- **API base**: `http://localhost:8080/api/v1` (configurable)
- **Project**: Selected during setup
- **Full API docs**: `http://localhost:8080/docs` (OpenAPI 3.1)

## Triage Label Mapping

Fetched from `GET /api/v1/triage/roles` at setup time. Canonical roles → Jackrabbit label strings.