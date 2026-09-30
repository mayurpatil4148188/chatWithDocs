# Chat With Docs

Greenfield product and engineering documentation for an open-source, self-hostable, mobile-friendly application that lets users chat with PDFs and documents, create reusable extraction templates, and process documents in bulk.

## Documentation map

- [Product and technical architecture](./technical-architecture.md)
- [User, API, and agent flows](./flows.md)
- [Open questions and decisions](./decisions-and-open-questions.md)
- [Open-source and self-hosting guide](./open-source.md)
- [RAG persistence and implementation plan](./decisions-and-open-questions.md#rag-implementation-plan)

## Current implementation stance

The first implementation should use a server-side orchestration layer (referred to as **JCode** in this documentation) over a provider adapter. OpenAI is the first-class connector, but the app must remain usable with self-hosted or alternative model/retrieval services. The application should keep provider credentials on the server, use retrieval for document grounding, and use Structured Outputs or equivalent JSON Schema validation for extraction.

This is a design baseline, not a production claim. Authentication, retention, quotas, supported file limits, and tenant isolation must be finalized before launch.
