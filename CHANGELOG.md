# turva-llms-txt-validator changelog

## 0.1.1 (2026-07-18)

Restores the llms-txt-validate CLI command. npm rejected the ./-prefixed bin
path at publish time and stripped the bin mapping from 0.1.0, so 0.1.0
installs without the command. No code changes.

## 0.1.0 (2026-07-18)

First release. The seven structural checks of the hosted validator at
turva.dev/llms-txt-validator, extracted as an ES module with a CLI
(llms-txt-validate), a node:test suite, and the same JSON result shape as the
hosted endpoint.
