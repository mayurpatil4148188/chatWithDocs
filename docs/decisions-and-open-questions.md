# Decisions and Open Questions

## Decisions for the initial baseline

1. Use a server-side JCode orchestration layer rather than calling OpenAI directly from the browser.
2. Use Responses API capabilities for document input, File Search retrieval, and Structured Outputs.
3. Persist versioned JSON Schema templates and validate every extraction result server-side.
4. Treat bulk processing as queue-backed asynchronous work with per-document idempotency.
5. Make fallback agentic behavior bounded, observable, and tool allowlisted.
6. Design the main client as a responsive web app/PWA; native apps can reuse the API later.
7. Treat the repository as an open-source, self-hostable project with provider, storage, queue, and auth adapters.
8. Use SQLite as the initial provider-independent RAG metadata/content store, with FTS5 for lexical retrieval and optional embeddings for semantic retrieval. Export/import indexed content as schema-versioned JSONL.
9. Preserve page boundaries and require server-validated chunk references for every grounded answer citation.
10. Process uploads asynchronously in durable background jobs with separately visible upload, extraction, chunking, indexing, and ready states.
11. Use SQLite as the default database, with an adapter/configuration path for PostgreSQL or another compatible database.
12. Provide a Redis queue connector, while defaulting to a database-backed queue; use an inline queue for local development and small deployments.
13. Limit the first chat version to one ready document per chat, while allowing multiple independent chat tabs for the same document. Defer multi-document chat.
14. Support PDF and DOCX first, including OCR for image-based pages/content, and enable chat only after processing reaches `ready`.

## Questions that affect implementation

Please confirm these before coding the production implementation:

1. What does “JCode” refer to in this project: an existing internal framework/service, or should it be the name of the new orchestration module?
2. Should users sign in with your own product accounts/OIDC, or is a Codex/ChatGPT identity connection specifically required for end users? The recommended open-source default is optional single-user mode plus pluggable OIDC for workspace deployments.
3. What are the expected limits for file size, pages, documents per bulk job, and concurrent jobs?
4. Are documents sensitive or regulated (PII, financial, health, legal)? This determines retention, redaction, regional hosting, audit, and deletion requirements.
5. Which export formats are required first: JSON, CSV, XLSX, or webhook/API delivery?
6. Should templates be shared across a workspace, private to a user, or both?
7. Do you need multilingual OCR/extraction in the first release?
8. What is the preferred deployment target and stack, if any (for example Next.js + Node, React + Python, or another standard)?
9. Which open-source license should the repository use: MIT, Apache-2.0, GPL/AGPL, or another license?
10. Which dependencies may send data to external services by default, and should anonymous telemetry be disabled by default?
11. Do you have sample documents and 3–5 target extraction examples for acceptance tests?

## RAG implementation plan

### Initial release scope and risk controls

The initial implementation is intentionally constrained to a local-first PDF RAG application:

- **Fixed workflow:** upload, extract, OCR fallback, chunk, index, retrieve, answer, and cite.
- **Orchestration:** JCode owns the deterministic workflow and invokes agentic recovery only for defined failures or ambiguity; agentic behavior is not the default path.
- **API:** publish the first API contract through OpenAPI.
- **LLM connector:** support `mock` locally, OpenAI-compatible providers, and a dedicated DeepSeek configuration using a server-side `DEEPSEEK_API_KEY`.
- **Persistence:** SQLite first, with migrations and repository interfaces that allow a later database adapter.
- **Jobs:** database-backed queue by default; inline queue for local development; Redis connector later.
- **Retrieval:** SQLite FTS5 and page-aware chunks first; embeddings are optional and must not be required for local startup.
- **Documents:** PDF and DOCX are supported in the first vertical slice, with PDF as the primary acceptance fixture. Image/OCR support uses the same extraction contract.
- **Chat:** one ready document per chat, with multiple chats allowed for the same document. Multi-document chat is later.
- **Quality gate:** no chat before `ready`; no answer without validated evidence references; OCR is fallback-only.

Risk controls are acceptance criteria: SQLite WAL mode and lock retries, idempotent job steps, bounded retries, file-size/page limits, isolated local storage, API-key server-side handling, prompt-injection defenses, no document content in logs, and automated citation/page-accuracy tests.

1. Define versioned schemas for `DocumentPage`, `DocumentChunk`, citation objects, and the JSONL manifest.
2. Implement SQLite migrations, tenant/version indexes, FTS5 indexing, and idempotent writes keyed by document-version checksum.
3. Implement PDF/DOCX parsing and page-preserving chunking; add OCR only for pages with insufficient native text, with confidence metadata.
4. Add JSONL export/import with checksum and schema validation.
5. Add hybrid retrieval and adjacent-chunk expansion, returning stable chunk/page references.
6. Add grounded answer validation that rejects unresolvable or unauthorized citations and returns `not_found` when evidence is insufficient.
7. Add evaluation fixtures for page recall, citation validity, page-number accuracy, and unsupported-claim rate.
8. Add the vertical-slice UI behavior: clickable citations open the source document at the referenced page.
9. Add OpenAPI documentation and a local quickstart that starts SQLite, the database-backed queue, API, worker, and web app.
10. Add durable job recovery tests for worker restart, retry, duplicate delivery, partial failure, and browser navigation away from the Documents page.
11. Add chat-scope tests for one-document chats, multiple independent conversations for the same document, authorization, ready-only access, and pending documents. Add multi-document chat tests when that later phase begins.

The RAG slice is complete when the same question returns the same page/chunk references after a restart, a re-indexed immutable version remains auditable, and an answer cannot cite content outside the retrieved authorized evidence.

The background-processing slice is complete when uploading a file returns immediately, every processing step is visible in the Documents page, retries are idempotent, and a browser restart does not lose job state.

## Default assumptions if no answer is provided

- Responsive web/PWA, TypeScript client and server, SQLite by default with a database adapter, private object storage, and a database-backed queue by default.
- PDF and DOCX first; other formats behind a feature flag.
- Redis queue connector available; inline queue for local development.
- One ready document per chat; multiple chat tabs for the same document; multi-document chat deferred.
- Optional single-user mode for local deployments; OIDC for multi-user deployments; provider credentials are server-only.
- Workspace-shared templates with version history.
- JSON and CSV exports first; XLSX later.
- No external side-effect tools in the agentic fallback.
- Human review is required for ambiguous or schema-invalid fields.
- OpenAI is the initial reference adapter, not a mandatory hosted service.
