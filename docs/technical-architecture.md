# Technical Architecture

## 1. Product definition

Chat With Docs is an open-source, responsive web application for:

1. Uploading PDF or DOCX documents.
2. Asking grounded questions about selected documents.
3. Generating a reusable extraction template from a document or a user description.
4. Extracting matching structured data from one document or a bulk document set.
5. Reviewing, correcting, exporting, and re-running extraction results.

The product has two complementary modes:

- **Chat mode:** conversational answers with document citations and quick actions.
- **Template mode:** schema-driven extraction that returns data in a stable user-defined format.

JCode is the application orchestration layer. It owns routing, validation, retries, policy, fallback decisions, job state, and audit events. The model is not allowed to silently invent a different output contract.

## 2. Design principles

- **Grounded by default:** document questions use retrieval or explicitly attached files; unsupported claims are stated as unknown.
- **Schema-first extraction:** every template has a versioned JSON Schema and display metadata.
- **Human-reviewable:** uncertain fields, missing fields, and validation failures are visible per document.
- **Progressive fallback:** a simple deterministic path is attempted first; JCode can escalate to agentic tool use when that path cannot complete safely.
- **Asynchronous bulk work:** large uploads and extraction runs never depend on a long-lived mobile request.
- **Mobile-first interaction:** upload, ask, choose a template, inspect status, and approve results all work on narrow screens.
- **Provider isolation:** OpenAI calls are behind an internal adapter so model/tool changes do not leak into the UI or persistence model.
- **Self-hostable by default:** a developer or organization can run the stack locally or on its own infrastructure with its own credentials and storage.
- **Composable dependencies:** authentication, storage, queue, retrieval, and model providers are replaceable integrations rather than hard-coded SaaS dependencies.
- **Least privilege:** API keys and file identifiers stay server-side; users access only tenant-authorized resources.

## 3. Proposed system shape

```text
Browser / PWA
   |
   v
API + Auth boundary  ------ WebSocket/SSE status stream (optional)
   |
   v
JCode Orchestrator
   |-- Intent/router
   |-- Chat workflow
   |-- Template workflow
   |-- Bulk job workflow
   |-- Fallback/repair policy
   |-- Usage, audit, and safety policy
   |
   +--> Document service ---- Object storage (original files)
   |          |
   |          +-------------- OpenAI Files / Vector Stores (retrieval index)
   |
   +--> Relational DB -------- users, tenants, chats, templates, jobs, results
   |
   +--> Queue/workers -------- ingestion, extraction, export, retry
   |
+--> Provider adapters ----- OpenAI Responses API, local/alternative LLMs, retrieval providers
```

### Suggested components

| Component | Responsibility |
|---|---|
| Web client | Responsive chat UI, upload UX, template builder, result review |
| API | Authenticated commands/queries, signed upload URLs, pagination |
| JCode | Workflow selection, tool policy, fallback, validation, retries |
| Document service | MIME/size validation, malware scan hook, storage metadata, indexing lifecycle |
| Worker service | Bulk fan-out, rate limiting, idempotency, result persistence |
| SQLite (default) or PostgreSQL-compatible database | Durable application state, RAG metadata, and audit trail |
| Object storage | Original documents and generated exports |
| Provider adapters | Typed model/retrieval calls and provider error normalization |
| Queue | Durable asynchronous jobs and backpressure |

OpenAI File Search is an appropriate default retrieval implementation for a document knowledge base. For direct file inputs, the Responses API supports PDFs and common document formats; PDFs can include text and page-image processing, while non-PDF documents are text-extracted. For extraction, Structured Outputs with a JSON Schema should be used instead of parsing unconstrained prose. The adapter contract must also allow alternatives such as local parsing, self-hosted vector search, or another compatible model provider. See the [official File Search guide](https://developers.openai.com/api/docs/guides/tools-file-search), [file inputs guide](https://developers.openai.com/api/docs/guides/file-inputs), and [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).

## 4. Core domain model

### Tenant and identity

- `User`: authenticated person.
- `Workspace`: tenant boundary for documents, templates, conversations, and jobs.
- `Membership`: user role in a workspace (`owner`, `admin`, `member`, `viewer`).

### Documents

- `Document`: logical user-visible document.
- `DocumentVersion`: immutable uploaded file version with checksum, MIME type, page count if known, and processing status.
- `DocumentIndex`: provider/index metadata, status, and last error. Provider IDs are opaque and never used as the primary key.
- `DocumentPage`: normalized text and metadata for one page, including the original page number and optional layout/OCR information.
- `DocumentChunk`: a retrievable passage linked to exactly one document version and page range. Chunks retain enough metadata to produce a user-visible reference.
- `DocumentProcessingJob`: durable background workflow for upload finalization, extraction, chunking, indexing, and RAG readiness, with per-step status and retry information.

Recommended document states: `uploading`, `queued`, `indexing`, `ready`, `failed`, `deleted`.

Recommended processing steps are independently observable: `upload`, `extract`, `chunk`, `embed` (when enabled), `index`, and `ready`. A document may be visible in the Documents page while processing, but it must not be selectable for grounded chat until the required steps finish.

### Background document processing

Document upload is an asynchronous workflow and must not depend on a long-running browser request:

```text
Create document/version
  -> upload original to private storage
  -> enqueue DocumentProcessingJob
  -> finalize upload and verify checksum
  -> extract text/pages and metadata
  -> create deterministic page/chunk records
  -> build FTS and optional embedding indexes
  -> validate index consistency
  -> mark document ready for chat
```

The API returns a document ID and processing-job ID immediately after the upload session is created. Workers execute each step idempotently and persist a checkpoint after successful completion. A transient failure retries with bounded backoff; a deterministic failure sets the failed step and actionable error while preserving any safe partial artifacts. Retrying resumes from the failed step or explicitly rebuilds downstream artifacts when an upstream result changes.

The processing job must expose:

```json
{
  "jobId": "job_123",
  "documentVersionId": "ver_123",
  "overallStatus": "processing",
  "currentStep": "extract",
  "steps": [
    {"name":"upload","status":"complete","progress":1},
    {"name":"extract","status":"running","progress":0.42},
    {"name":"chunk","status":"queued","progress":0},
    {"name":"index","status":"queued","progress":0},
    {"name":"ready","status":"queued","progress":0}
  ],
  "error": null,
  "updatedAt": "2026-09-30T12:00:00Z"
}
```

Progress is indicative, not a claim that every step has equal cost. The UI should show the current step, completed steps, elapsed time, retry action, and a human-readable failure reason. Status updates use SSE/WebSocket when available and polling as the fallback. Navigation or closing the browser must not cancel the job.

### Conversations

- `Conversation`: selected workspace and document scope.
- `Message`: user/assistant/tool event with timestamps and status.
- `Citation`: source document, page/section when available, and provider reference metadata.

In the first version, each conversation is scoped to exactly one ready document. A document can have multiple independent conversations, each with its own message history, title, and archived state. The retrieval query must always apply the conversation's document scope and workspace authorization before searching. Multi-document chat is reserved for a later phase and must not be simulated by silently mixing documents into one conversation.

### Document RAG persistence and citation plan

The application must persist a provider-independent representation of every indexed document. The canonical format for the initial implementation is SQLite, because it supports local/self-hosted deployments, transactions, full-text search (FTS5), and deterministic inspection without requiring a separate vector database. PostgreSQL can use the same logical schema in workspace deployments. JSONL is the interchange and backup format; it is not the primary query store.

The original file remains in private object storage. SQLite stores extracted content and retrieval metadata, never a replacement for the original binary.

#### Canonical SQLite entities

```text
documents
  id, workspace_id, title, source_filename, mime_type, created_at
document_versions
  id, document_id, checksum_sha256, page_count, parser, language, status, created_at
document_pages
  id, document_version_id, page_no, text, text_sha256, width, height, ocr_used,
  parser_metadata_json, created_at
document_chunks
  id, document_version_id, first_page_no, last_page_no, ordinal, text,
  text_sha256, token_count, embedding_json_or_blob, metadata_json, created_at
document_fts
  chunk_id, text
document_indexes
  id, document_version_id, provider, provider_index_id, status, error_json, created_at
```

Required invariants:

- `page_no` is the original 1-based page number and is never inferred from chunk order.
- A chunk has stable `id`, `ordinal`, and content hash; re-indexing the same immutable version is idempotent.
- Every chunk points to a document version, and every citation points to a chunk or page in that version.
- Parser/OCR/layout details are stored in metadata so the answerer can distinguish extracted text from OCR text.
- Deleted or superseded versions are excluded from retrieval by status and tenant checks.
- Provider IDs are optional metadata and cannot be the only source reference.

For portability, each indexed version can also be exported as JSONL. The first record is the manifest, followed by one page record and one or more chunk records per page:

```json
{"type":"manifest","documentVersionId":"ver_123","checksumSha256":"...","pageCount":12,"schemaVersion":1}
{"type":"page","documentVersionId":"ver_123","pageId":"page_004","pageNo":4,"text":"...","ocrUsed":false,"metadata":{"width":612,"height":792}}
{"type":"chunk","chunkId":"chunk_004_02","pageId":"page_004","pageNo":4,"text":"...","ordinal":2,"textSha256":"..."}
```

JSON exports must be treated as untrusted input and validated against a versioned schema before import. A JSON array containing an entire document is discouraged because JSONL permits streaming, partial recovery, and large-document processing.

#### Retrieval and answer contract

The retrieval workflow is:

1. Resolve and authorize the document/workspace scope.
2. Search the SQLite FTS index and, when embeddings are available, the vector index.
3. Merge lexical and semantic results, remove duplicates, and expand adjacent chunks from the same page when needed.
4. Pass only ranked evidence with `chunkId`, `documentVersionId`, `pageNo`, and text to the answer model.
5. Require the model to return a normalized answer plus evidence references; the server verifies every reference against the retrieved evidence before persisting or streaming it.
6. If no evidence meets the configured threshold, return `grounding: "not_found"` and say that the document does not provide enough information. Do not answer from model memory.

The normalized response must use stable references rather than page numbers typed by the model alone:

```json
{
  "text": "The payment term is 30 days.",
  "grounding": "supported",
  "citations": [{
    "citationId": "cite_1",
    "documentId": "doc_123",
    "documentVersionId": "ver_123",
    "chunkId": "chunk_004_02",
    "pageStart": 4,
    "pageEnd": 4,
    "label": "Payment terms"
  }]
}
```

The UI resolves a citation to the original document and opens the cited page. Page references are displayed as `p. 4` or `pp. 4–5`; the chunk ID remains available for debugging and audit. Citation validation must reject references to pages/chunks that were not retrieved or do not belong to the authorized document scope.

#### Accuracy and evaluation requirements

- Preserve page boundaries during parsing; do not flatten a document into one untraceable text blob.
- Use deterministic chunking with overlap and record the chosen parameters in `DocumentIndex` metadata.
- Keep tables, headings, lists, and OCR confidence/layout metadata when the parser can provide them.
- Run retrieval tests with expected page/chunk references and answer tests with supported, partially supported, and not-found questions.
- Measure recall@k for expected evidence, citation validity rate, unsupported-claim rate, and page-number accuracy.
- Low-confidence OCR or ambiguous retrieval should produce `partially_supported` or `not_found`, request clarification, or use the page-fetcher fallback; it must not silently become a confident answer.

### Templates

- `Template`: stable identity and current version pointer.
- `TemplateVersion`: name, description, JSON Schema, UI schema, extraction instructions, and compatibility metadata.
- `ExtractionResult`: one result per document version and template version.
- `FieldReview`: optional per-field correction, confidence, evidence, and reviewer identity.

### Jobs

- `BulkJob`: requested operation, input document set, template version, progress counters, and final status.
- `BulkItem`: idempotent per-document work unit with attempts, status, result/error reference, and timestamps.

## 5. Template contract

The persisted template must contain both machine and presentation metadata. Example:

```json
{
  "templateId": "invoice-v1",
  "version": 1,
  "name": "Invoice extraction",
  "description": "Extract billing and totals from supplier invoices.",
  "jsonSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["invoiceNumber", "invoiceDate", "supplier", "total"],
    "properties": {
      "invoiceNumber": { "type": ["string", "null"] },
      "invoiceDate": { "type": ["string", "null"], "description": "ISO-8601 date" },
      "supplier": { "type": ["string", "null"] },
      "total": {
        "type": ["object", "null"],
        "additionalProperties": false,
        "required": ["amount", "currency"],
        "properties": {
          "amount": { "type": ["number", "null"] },
          "currency": { "type": ["string", "null"] }
        }
      }
    }
  },
  "uiSchema": {
    "order": ["invoiceNumber", "invoiceDate", "supplier", "total"]
  },
  "extractionPolicy": {
    "allowNullForMissing": true,
    "includeEvidence": true,
    "normalizeDates": true
  }
}
```

Extraction should persist the raw structured payload, validation errors, evidence/citations, and a normalized display form. If a value is not present or cannot be supported, the extractor returns `null` plus a reason/evidence status rather than guessing.

## 6. JCode routing and fallback policy

The normal path is intentionally predictable:

1. Classify request: chat, template generation, single extraction, bulk extraction, export, or document operation.
2. Validate permissions, inputs, file readiness, and template schema.
3. Execute the smallest suitable workflow.
4. Validate the model result against the expected contract.
5. Retry only transient failures with bounded exponential backoff.
6. If the path cannot complete, escalate to an agentic workflow with a narrow tool allowlist.
7. If the agentic workflow also fails, return a clear partial/failed state and preserve diagnostics for retry.

Agentic escalation may use file search, schema inspection, a document-page fetcher, a normalization function, and a validator. It must not gain arbitrary network, filesystem, or external side-effect tools by default.

Escalation triggers:

- Retrieval returns no usable evidence for a question that requires document grounding.
- Input document is complex (scanned pages, tables, multi-column layout) and direct text extraction is insufficient.
- Structured output fails schema validation after one repair attempt.
- Multiple documents require cross-document comparison or reconciliation.
- A bulk item needs a targeted retry with a different extraction strategy.

### Initial implementation boundary

The first release is a local-first vertical slice:

```text
PDF/DOCX upload -> background job -> native page/text extraction -> OCR fallback when needed
  -> deterministic page/chunk records -> SQLite FTS5 RAG index -> one-document chat with citations
```

JCode owns this fixed workflow, state transitions, validation, retries, and error reporting. The normal path is deterministic. JCode invokes agentic recovery only for defined failures or ambiguity, such as unreadable pages, insufficient extracted text, complex tables, retrieval failure, or failed citation validation. Agentic recovery receives only document inspection, page retrieval, normalization, and validation tools; it is not used for every request.

The initial API is documented with OpenAPI and runs locally with SQLite, a database-backed queue, local file storage, and one configured LLM API provider. PostgreSQL, Redis, alternative providers, and hosted retrieval remain extension targets rather than first-release requirements.

## 7. Authentication and provider connectors

The application should support two deployment profiles:

- **Personal mode:** one local user, optional login, local storage, and a single configured provider key.
- **Workspace mode:** application identity provider (OIDC/OAuth2 or equivalent), workspace-level authorization, shared templates, audit events, quotas, and optional external storage.

“Codex auth” should be treated as development/operator access unless a deployment explicitly requires end-user Codex login. End users should not receive a shared OpenAI API key. Open-source users should be able to bring their own OpenAI key or configure a compatible provider without editing application code.

Recommended server configuration:

```text
OPENAI_API_KEY                 server secret only
OPENAI_MODEL_CHAT              configurable chat model
DEEPSEEK_API_KEY               optional server-side DeepSeek API key
DEEPSEEK_BASE_URL              optional, defaults to https://api.deepseek.com
DEEPSEEK_MODEL                 optional DeepSeek chat model
OPENAI_MODEL_EXTRACTION        configurable extraction model
OPENAI_VECTOR_STORE_MODE       hosted | self-managed (initially hosted)
MODEL_PROVIDER                 openai | deepseek | compatible | local
RETRIEVAL_PROVIDER             openai_file_search | local | custom
AUTH_ISSUER                    OIDC issuer
AUTH_AUDIENCE                  API audience
STORAGE_BUCKET                 private object-storage bucket
STORAGE_PROVIDER               local | s3-compatible | custom
DATABASE_URL                   server-side database connection
QUEUE_URL                      worker queue connection
QUEUE_PROVIDER                 inline | database | redis | custom
```

The provider adapter should provide typed operations such as:

- `createDocumentIndex(documentVersion)`
- `answerWithRetrieval(scope, messages)`
- `generateTemplate(documentScope, intent)`
- `extractWithSchema(documentVersion, templateVersion)`
- `repairStructuredResult(previousResult, validationErrors)`

Do not expose raw provider request bodies to the browser. Log request IDs, latency, model alias, token/usage metadata where available, and normalized error class; never log document contents, secrets, or full prompts by default. Provider-specific capabilities should be feature-detected and surfaced as configuration warnings, not assumed by the core domain layer.

## 8. Bulk processing

Bulk extraction is a durable job, not a loop inside an HTTP request.

1. Create a `BulkJob` with an immutable document list and template version.
2. Enqueue one idempotent `BulkItem` per document.
3. Workers verify document readiness, execute extraction, validate schema, and persist the result.
4. Transient failures retry with a limit; deterministic failures move to `needs_review` or `failed`.
5. Update aggregate progress transactionally.
6. Generate CSV/JSON/XLSX only from persisted results.
7. Keep successful items when some items fail; support retry-failed-only.

Initial safety limits should be configurable: maximum file size, pages per document, documents per job, concurrent items per workspace, and maximum retries. The UI should show `completed`, `needs review`, `failed`, and `remaining`, rather than only a percentage.

## 9. UI structure

Mobile-first routes/views:

- `/inbox`: recent conversations, documents, templates, active jobs.
- `/chat/:conversationId`: message thread, source chips, quick actions, composer, attachment picker.
- `/documents`: separate document library with upload, processing status, filters, document preview, retry/delete actions, and “start chat” or “add to chat” actions.
- `/templates`: template list and builder.
- `/templates/:id/run`: choose documents, start extraction, view job progress.
- `/jobs/:id`: bulk result table/cards, filters, review and export.

Responsive behavior:

- Bottom-sheet actions on small screens; side panels on larger screens.
- Sticky composer with safe-area padding and upload progress.
- Result tables become stacked cards with field-level status.
- Long-running jobs survive navigation and reconnect through polling or SSE.
- Keyboard navigation, visible focus, readable contrast, reduced-motion support, and screen-reader labels are acceptance criteria.

## 10. Reliability, security, and observability

- Tenant checks on every document, conversation, template, and job query.
- Private storage with short-lived signed URLs.
- MIME sniffing, extension allowlist, size limits, malware-scan integration point.
- Encryption in transit and at rest; secrets in a managed secret store.
- Retention and deletion workflows covering app storage and provider indexes.
- Background-job recovery after worker, API, or browser restart; no processing step should rely on in-memory state.
- Prompt-injection defense: treat document text as untrusted data; tool instructions come only from the server policy.
- Idempotency keys for uploads, extraction requests, and exports.
- Trace IDs across API, JCode, queue item, provider request, and result.
- Metrics: upload success, indexing latency, retrieval-empty rate, schema-valid rate, fallback rate, retry rate, bulk throughput, cost per job, and user correction rate.
- Audit events for sharing, deletion, template changes, extraction runs, exports, and admin actions.

## 11. Delivery phases

### Phase 1 — vertical slice

Local-first PDF upload, OpenAPI-described API, SQLite persistence, database-backed background queue, native extraction with OCR fallback, page/chunk RAG, background step indicators, a separate document library, multiple one-document chat tabs per document, citations, and basic retry/error UI. Chat is enabled only after the document reaches `ready`.

### Phase 2 — reusable templates

Template generation, versioning, schema editor, extraction review, JSON/CSV export, and saved quick actions in chat.

### Phase 3 — bulk and agentic fallback

Queue-backed bulk jobs, retry-failed-only, agentic escalation, detailed audit events, rate limits, and operational dashboards.

### Phase 4 — hardening

Retention/deletion controls, red-team prompt-injection tests, accessibility audit, load tests, cost controls, and provider failover strategy.

Multi-document chat is intentionally deferred until after the first release. It will require a new conversation scope model, cross-document ranking, source-document disambiguation, and evaluation fixtures for conflicting answers.

The first release should also defer templates, bulk extraction, Redis, PostgreSQL, hosted retrieval, and multiple LLM providers unless the core vertical slice is already stable. These remain documented extension points, not required acceptance criteria.

### Open-source readiness

Before the first public release, include a license, contributor guide, local setup, `.env.example`, migration commands, seed/demo data, provider configuration documentation, security policy, code of conduct, issue templates, and a clear support boundary. CI should run linting, unit tests, integration tests with mocked providers, schema compatibility checks, and a minimal self-hosted smoke test.
