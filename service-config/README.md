# Local service configuration

`service.properties` and the launch scripts are tracked templates with no
secrets. Runtime state under `state/` and `sandbox-state/` is ignored by Git.
`model-providers.properties` is a machine-local catalog that must be provided
per workstation; machine-specific credentials remain environment-only.

Before starting the service, provide the model secret in the current shell:

```powershell
$env:OPENCODE_GO_API_KEY = '<your-model-api-key>'
. .\service-config\set-cli-env.ps1
.\service-config\start-service.ps1
```

`model-providers.properties` is the source of truth. Each `PROVIDER_N_*`
record declares its base URL, wire protocol, credential environment variable,
and model list. The same endpoint may therefore expose separate Chat
Completions and Responses providers. `set-cli-env.ps1 -ProviderApiKey ...`
injects the supplied secret into every configured provider environment name.

The CLI uses the same local bearer token. In a second terminal, dot-source the
helper before invoking the CLI:

```powershell
. .\service-config\set-cli-env.ps1
.\distribution\build\business-agent-code-0.2.0-wp10-20260827-r3\bin\business-agent.ps1 --server http://127.0.0.1:8765 --json health
```

To use the prompt loop, start the same launcher without arguments:

```powershell
. .\service-config\set-cli-env.ps1
.\distribution\build\business-agent-code-0.2.0-wp10-20260827-r3\bin\business-agent.ps1
```

The defaults are in `interactive.properties`. Each entered prompt is submitted
through create → fingerprint approval → run → polling, and `:q` exits.

Never commit this directory or place a real model key in
`model-providers.properties`.

TencentDB memory is configured in the same local `service.properties`, while
its key remains in an environment variable:

```properties
memory.enabled=true
memory.provider=tencentdb
memory.single-user=true
memory.endpoint=http://127.0.0.1:8420
memory.api-key-env=TDAI_EXPERIMENT_API_KEY
memory.service-id=agent-framework-memory-lab
memory.project-namespace=local-business-agent
memory.user-id=local-operator
memory.capture-enabled=true
```

`memory.single-user=true` is a required safety acknowledgement: the verified
MemoryCore L0 fallback does not enforce `user_id` isolation. Tenant and agent
scope are re-checked client-side, but this binding must not be exposed as a
multi-user memory service.
