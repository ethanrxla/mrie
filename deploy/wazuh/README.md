# Wazuh integration deployment

MRE targets Wazuh 4.14.7 for its first tested integration. Wazuh is an
independently installed security data plane; this repository does not silently
install it, copy its rules, or expose its APIs.

Use the [official Wazuh installation options](https://wazuh.com/install/) and
[current quickstart](https://documentation.wazuh.com/current/quickstart.html).
For a disposable lab, the official single-node container/all-in-one guidance is
acceptable. Production separates and sizes the Wazuh server/indexer/dashboard
as appropriate.

## MRE connection checklist

1. Keep Wazuh server API 55000 and indexer API 9200 on private networking.
2. Configure verified TLS and give MRE the CA bundle.
3. Create a dedicated server API user with allow-only read permissions for
   manager status, agents, inventory, rules/decoders, and required health data.
4. Create a dedicated indexer role that can read only the needed
   `wazuh-alerts-*`, monitoring, and statistics indices.
5. Put credentials in a secret store or `.env`, never YAML or Git.
6. Copy `config/mrie.example.yaml` to ignored `config/mrie.yaml`, then set the
   two base URLs and CA bundle paths.
7. Run `python -m mrie status`, then use the capability/contract tests before
   enabling continuous polling.
8. Add a filtered Wazuh custom Integrator webhook only after authenticated MRE
   event ingress exists. Treat the webhook as a wake-up hint and reconcile from
   the indexer.

Required environment references are:

```text
WAZUH_API_USERNAME
WAZUH_API_PASSWORD
WAZUH_INDEXER_USERNAME
WAZUH_INDEXER_PASSWORD
```

TLS verification cannot be disabled by the adapter. Use a trusted internal CA
rather than `curl -k`.

## Honeypot pilot

Begin with Cowrie on an isolated hostile VLAN/DMZ and Suricata for corroborating
network evidence. Write one-line Cowrie JSON to an append-only volume and let a
host Wazuh agent or protected relay collect it with `log_format=json`. Put custom
decoders/rules in Wazuh's local customization directories and validate samples
with `wazuh-logtest`.

The sensor must have no route to trusted or management networks, no real
credentials, and constrained/audited egress. Captured files stay in quarantine;
MRE receives hashes and metadata only. Never auto-block or attribute a person
solely from honeypot evidence.

## Sources

- [Wazuh architecture and ports](https://documentation.wazuh.com/current/getting-started/architecture.html)
- [Server API and JWT authentication](https://documentation.wazuh.com/current/user-manual/api/getting-started.html)
- [Indexer query examples](https://documentation.wazuh.com/current/user-manual/indexer-api/use-case.html)
- [Indexer RBAC](https://documentation.wazuh.com/current/user-manual/user-administration/rbac.html)
- [Custom Integrator webhooks](https://documentation.wazuh.com/current/user-manual/manager/integration-with-external-apis.html)
- [JSON local-file collection](https://documentation.wazuh.com/current/user-manual/reference/ossec-conf/localfile.html)
- [Cowrie JSON schema](https://docs.cowrie.org/en/latest/OUTPUT.html)
