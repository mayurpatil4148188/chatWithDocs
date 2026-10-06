# Security policy

## Current scope

This project is currently a local, single-user prototype. The API does not provide authentication, authorization, rate limiting, or multi-tenant isolation. Keep it bound to `127.0.0.1` and do not expose it directly to the public internet.

The Docker profile binds the application inside the container on `0.0.0.0` for private self-hosting. Put it behind an authenticated reverse proxy and TLS termination; the application itself does not yet provide those controls.

Uploaded documents may be sent to the configured external LLM provider. Do not use confidential documents with an external provider unless that data flow is acceptable for your deployment.

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Use the repository's private security-advisory or maintainer contact mechanism when this project is hosted publicly. Include reproduction steps, affected endpoint or file, impact, and a suggested mitigation if available.

Until a supported-version policy is published, users should run the latest commit and review changes before deploying outside a local environment.
