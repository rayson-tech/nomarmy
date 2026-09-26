# Mock OIDC

Enable explicitly in your repository's `.nomarmy.yml` (there are no detection rules):

```yaml
harnesses: [mock-oidc]
verification:
  auth:
    commands: [npm test]
```

Point your application's issuer/discovery configuration at `OIDC_ISSUER` or
`OAUTH2_ISSUER`, both exported as `http://mock-oidc:8080/default` during nomArmy
verification. Configure your test client ID, redirect URI and audience to match
what your application expects; allow HTTP only in this test configuration.

The pinned NAV mock OAuth2 server supplies discovery, signing keys, token and
mock authorization flows. It is not an Okta/Auth0 tenant: it does not prove real
identity, MFA, tenant policies, upstream federation or production compatibility.
Never use real credentials with this fake.

nomArmy pulls the pinned image on the host if missing, then starts it without
published ports on a per-run `--internal` Podman network. Discovery must return
2xx within 30 seconds before commands run. Containers and the network are
removed even if verification fails. Workers remain `--network none`; only
nomArmy's own verification can reach the fake. Env maps in harness manifests
are non-secret literals, not secret references or host-environment imports.

`fixture/` is a tiny Node-built-ins-only repository. Run its `quick` profile
through nomArmy verification. It fetches discovery over the private network;
it requires no internet or npm packages. It is not a host-side unit test.
