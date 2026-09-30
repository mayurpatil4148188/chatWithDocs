# Open-Source and Self-Hosting Guide

## Goals

The project should be useful in three modes:

1. **Local personal use:** run the app with Docker or a simple development command and configure a personal provider key.
2. **Private organization deployment:** run the full stack with a database, object storage, queue, authentication, and workspace controls.
3. **Provider development:** implement or test a model/retrieval adapter without changing the UI or core extraction domain.

## Recommended repository layout

```text
apps/
  web/                 responsive client
  api/                 authenticated API and JCode orchestration
  worker/              asynchronous bulk processing
packages/
  domain/              entities, schemas, state machines
  provider-contract/   model and retrieval adapter interfaces
  providers/           openai, local, and compatible implementations
  ui/                  shared accessible components
  config/              typed environment configuration
docs/
  architecture, flows, deployment, security, contributing
infra/
  docker-compose, migrations, optional Kubernetes examples
```

The exact framework is still open, but the dependency boundaries should exist even in a single-repository first release.

## Minimum self-hosted profile

The simplest supported deployment should require:

- Web app and API.
- SQLite by default, with a database adapter for PostgreSQL and other compatible databases.
- Local filesystem storage for development.
- Inline queue mode for local development and small personal workloads.
- One configured model provider.
- Optional authentication for single-user mode.

The first release should provide a local quickstart for the PDF RAG vertical slice: API, web app, SQLite database, database-backed worker queue, and local file storage. Redis, PostgreSQL, hosted retrieval, and additional providers are optional extension profiles and are not required to run the project locally.

The production profile should support:

- PostgreSQL or another compatible database for larger deployments.
- S3-compatible private object storage.
- Redis queue connector or a durable database-backed queue; database-backed queue is the default production profile.
- OIDC authentication.
- Separate API and worker processes.
- TLS termination and secret management outside the repository.

## Provider adapter contract

Adapters should expose capabilities rather than provider-specific objects:

```ts
type ProviderCapabilities = {
  chat: boolean;
  fileInput: boolean;
  retrieval: boolean;
  structuredOutput: boolean;
  vision: boolean;
};

interface DocumentAIProvider {
  capabilities(): ProviderCapabilities;
  answer(request: GroundedChatRequest): Promise<GroundedChatResult>;
  proposeTemplate(request: TemplateProposalRequest): Promise<TemplateProposal>;
  extract(request: StructuredExtractionRequest): Promise<StructuredExtractionResult>;
}
```

The OpenAI implementation can use Responses API, File Search, and Structured Outputs. A local implementation may use a local model, a parser, and a self-hosted vector database. Both must return the same normalized domain result.

## Configuration and secrets

- Commit `.env.example`, never real credentials.
- Keep provider keys on the server.
- Document every environment variable with its mode, default, and security impact.
- Fail fast on invalid production configuration.
- Provide a configuration screen only for non-secret provider metadata; secret entry should use a secure deployment mechanism.
- Include a `doctor` command that checks database, storage, queue, provider connectivity, and migration state without printing secrets.

## Privacy defaults

- Store originals in private storage.
- Do not send documents to an external provider unless the operator configured that provider.
- Make provider submission visible in deployment documentation and the UI.
- Support deletion of originals, indexes, conversations, templates, results, and exports.
- Avoid logging document content and prompts by default.
- Make telemetry opt-in or clearly configurable, with a documented event list.

## License and project policy

The repository needs an explicit license decision before publishing. A permissive license such as Apache-2.0 or MIT is suitable for broad adoption; a copyleft license may be preferable if preserving downstream openness is a requirement. This is a project-owner decision and should not be assumed by implementation.

Also add:

- `CONTRIBUTING.md`: setup, architecture, tests, pull request expectations.
- `SECURITY.md`: vulnerability reporting and supported versions.
- `CODE_OF_CONDUCT.md`.
- `CHANGELOG.md` or release notes policy.
- `LICENSE`.
- Architecture Decision Records for provider, auth, storage, and queue choices.

## Testing strategy for open source

- Unit tests for routing, schema validation, state machines, and authorization.
- Contract tests that every provider adapter must pass.
- Mock-provider integration tests for chat, template generation, extraction, fallback, and bulk jobs.
- Optional live-provider tests disabled by default and enabled by explicit environment flags.
- End-to-end tests for personal mode and workspace mode.
- Security tests for tenant isolation, prompt injection, upload validation, SSRF prevention, and signed URL expiry.
- Reproducible demo fixtures with synthetic documents; never commit private customer documents.

## First public release checklist

- [ ] License selected and included.
- [ ] Local setup works from a clean checkout.
- [ ] Docker Compose profile starts successfully.
- [ ] `.env.example` is complete.
- [ ] OpenAI connector documented as optional/configurable.
- [ ] At least one mocked provider works without external credentials.
- [ ] Provider and storage adapters are documented.
- [ ] Database migrations and seed data are reproducible.
- [ ] Upload, chat, extraction, bulk, retry, and deletion flows have tests.
- [ ] Security policy and disclosure channel are published.
