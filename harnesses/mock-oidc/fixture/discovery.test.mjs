import assert from 'node:assert/strict';
import { test } from 'node:test';

test('private mock issuer discovery', async () => {
  const issuer = process.env.OIDC_ISSUER;
  assert.equal(issuer, 'http://mock-oidc:8080/default');
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.equal(document.issuer, issuer);
  assert.equal(new URL(document.jwks_uri).origin, new URL(issuer).origin);
  assert.equal(new URL(document.authorization_endpoint).origin, new URL(issuer).origin);
  assert.equal(new URL(document.token_endpoint).origin, new URL(issuer).origin);
});
