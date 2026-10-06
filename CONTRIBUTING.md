# Contributing

Thanks for helping improve Chat With Docs.

## Local setup

```bash
npm ci
cp .env.example .env
npm run typecheck
npm test
npm run dev
```

The default configuration uses the credential-free mock provider and binds only to `127.0.0.1`.

## Before opening a pull request

- Keep changes focused and explain user-visible behavior.
- Add or update tests for changed API, extraction, retrieval, or queue behavior.
- Run `npm run typecheck` and `npm test`.
- Do not commit `.env`, database files, uploaded documents, API keys, or private fixtures.
- Update the README or OpenAPI description when configuration or API behavior changes.

## Design expectations

Document text is untrusted input. Provider prompts must keep server instructions separate from document evidence, and citations must be derived from retrieved stored chunks rather than accepted from model output.
