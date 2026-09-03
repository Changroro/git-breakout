# Contributing to GitBreakout

Thank you for helping improve GitBreakout. Contributions that make discovery more accurate, methodology more transparent, or the interface easier to use are welcome.

## Development setup

Requirements:

- Node.js 22 or newer
- npm
- A GitHub API token for collector work

```bash
npm ci
npm run dev
```

Collector changes require a local snapshot:

```bash
GITHUB_TOKEN=your_token npm run collect
```

Never commit API tokens, database credentials, tunnel credentials, production data, or local cache files.

## Before submitting a change

```bash
npm test
npm run typecheck
npm run build
```

Add or update tests for observable behavior. Ranking changes must document the signal, data requirement, confidence behavior, and expected bias. Do not silently replace missing evidence with zeroes or inferred historical values.

## Pull requests

- Keep each pull request focused on one logical change.
- Explain the user-visible result and the verification performed.
- Include screenshots for visual changes on desktop and mobile.
- Call out schema, migration, collection-cost, and API-rate-limit effects.
- Preserve historical snapshots unless a migration explicitly requires otherwise.

By contributing, you agree that your contribution is licensed under the project's MIT License.
