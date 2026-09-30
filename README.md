# Chat With Docs

Local-first, citation-grounded document RAG built around a fixed JCode workflow.

## Current vertical slice

`PDF/DOCX upload -> background processing -> page/chunk extraction -> SQLite FTS5 -> ready-only one-document chat`

The first implementation uses SQLite, a database-backed queue, local file storage, and a deterministic retrieval path. JCode should invoke an agentic recovery path only when extraction, retrieval, or citation validation fails. `LLM_PROVIDER=mock` keeps local startup credential-free. Set `LLM_PROVIDER=deepseek` and `DEEPSEEK_API_KEY` to use the DeepSeek connector, or use another OpenAI-compatible provider with `LLM_API_KEY`. The server assigns citations from retrieved chunks, so the model cannot invent page references.

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

The web UI and API start at `http://localhost:3000`. OpenAPI is in [`openapi.yaml`](./openapi.yaml).

Upload JSON example:

```json
{
  "filename": "example.pdf",
  "mimeType": "application/pdf",
  "contentBase64": "<base64 file contents>"
}
```

The upload returns a job ID. Poll `GET /v1/jobs/{jobId}` until the document reaches `ready`, then call `POST /v1/documents/{documentId}/chat` with `{ "question": "..." }`.

## Planned adapters

- OCR adapter for image-only PDF/DOCX content
- OpenAI-compatible LLM answer adapter
- DeepSeek API connector (`DEEPSEEK_API_KEY`)
- Inline queue for local development
- Redis queue connector
- PostgreSQL repository adapter
