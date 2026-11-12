# Model and Provider Fallback Design

## Intent

Make the review action resilient to temporary model-provider failures without tying its behavior
to a specific consuming repository. The action should keep its current Gemini-only interface
working, while allowing callers to opt into an ordered list of fallback models, including OpenAI.

This design implements [Shion1305/ai-review-actions#6](https://github.com/Shion1305/ai-review-actions/issues/6).

## Goals

- Preserve the existing `model` and `gemini-api-key` behavior when no fallback is configured.
- Let callers provide an ordered list of fallback model identifiers.
- Support Google and OpenAI models without hard-coding a particular fallback model.
- Fall back only for temporary provider failures: HTTP 429, HTTP 5xx, and request timeouts.
- Keep authentication, invalid input, and local usage-limit failures visible instead of hiding them
  behind another model.
- Fail the action when every configured model fails, with a concise Actions Summary.
- Log which model failed and which model produced a response without exposing credentials or request
  contents.

## Non-goals

- Enforcing an account-wide or monthly spending limit. Provider billing state is outside the action.
- Supporting arbitrary providers in the first change. The construction boundary should make another
  provider straightforward, but this change implements Google and OpenAI only.
- Selecting fallback models on behalf of callers.
- Changing review prompts, evidence requirements, or publication policy.
- Treating a valid but evidence-limited review report as a provider failure. A provider exhaustion
  must fail; a successfully generated report may still state that investigation is incomplete.

## Public interface

The existing inputs remain valid:

- `model`: the primary Google model name, unchanged.
- `gemini-api-key`: the primary Google credential, unchanged and still required.

Two optional inputs are added:

- `fallback-models`: a JSON array of model identifiers, defaulting to `[]`.
- `openai-api-key`: the OpenAI credential, defaulting to an empty string.

Model identifiers use these rules:

- An unqualified name such as `gemini-2.5-flash-lite` is a Google model.
- `google:<name>` explicitly selects Google.
- `openai:<name>` selects OpenAI.
- Unknown provider prefixes, non-array JSON, empty names, duplicates, and more than five fallback
  models are rejected before a network request.
- Configuring an OpenAI fallback without `openai-api-key` is rejected before a network request.

Example:

```yaml
with:
  gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
  model: gemini-3.8-flash
  fallback-models: '["google:gemini-2.5-flash-lite", "openai:gpt-5-nano"]'
  openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

The action does not provide this list by default, so existing users incur no new provider calls or
costs.

## Runtime design

`ReviewConfig` parses and validates fallback identifiers and retains credentials as secret fields.
A model factory constructs provider-specific Pydantic AI models:

- Google models use `GoogleProvider`, the existing JSON schema transformer, and the Gemini key.
- OpenAI models use `OpenAIProvider` and the OpenAI model implementation supplied by Pydantic AI.

Each concrete model remains wrapped by `BoundedReviewModel` so request-size accounting, bounded
same-model retries, and usage logging continue to apply. Pydantic AI's `FallbackModel` wraps the
ordered concrete models and uses a narrow exception predicate:

- fall back for `ModelHTTPError` with status 429 or 500–599;
- fall back for provider/network timeout exceptions;
- do not fall back for 400, 401, 403, configuration errors, schema errors, or local
  `UsageLimitExceeded` failures.

The existing final-429 conversion to `UsageLimitExceeded` is removed so a provider rate limit can
reach the fallback layer. If all models fail, Pydantic AI raises the grouped failure rather than
creating an empty `ReviewReport`.

Generic `ModelSettings` are used for temperature, timeout, and token limits so the same agent can
invoke either provider. Provider-specific profiles remain attached to each concrete model.

## Observability and failure behavior

The transient-error predicate logs the failed model and HTTP status. Successful response logging
includes the response model name. Credentials, prompts, source, and response bodies are not logged.

When the fallback chain is exhausted, `main()` writes a short section to `GITHUB_STEP_SUMMARY` with:

- the ordered model names attempted;
- one sanitized status or exception class per failed model;
- an explicit statement that no review report was produced.

The original exception is then re-raised so the composite action fails. The summary helper is a
no-op when `GITHUB_STEP_SUMMARY` is unavailable, which keeps local execution predictable.

## Compatibility and documentation

With `fallback-models: []`, model construction and retry behavior remain equivalent to the current
Google-only path. Existing workflow files do not need to change. README examples document both the
legacy single-model setup and an opt-in multi-provider setup, including the fact that paid-provider
cost controls must be handled by the caller's provider account and model choice.

## Testing

Tests cover:

- parsing valid Google/OpenAI fallback identifiers;
- rejecting malformed, duplicate, excessive, unsupported, or credential-less configurations;
- falling back on 429, 5xx, and timeouts;
- not falling back on 4xx authentication/input failures or local usage limits;
- preserving model messages and tool results across fallback;
- all-model failure and sanitized Actions Summary output;
- no-fallback backward compatibility;
- action metadata wiring for both new inputs;
- README examples and dependency extras through existing format, type, and unit checks.
