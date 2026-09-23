/**
 * One-off STAGING signup smoke test.
 * Refuses every environment except staging.
 */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  if (process.env['APP_ENV'] !== 'staging') {
    throw new Error('Refusing to run outside staging.');
  }

  const api = required('SMOKE_API_URL').replace(/\/+$/, '');
  const email = required('SMOKE_SIGNUP_EMAIL');
  const password = required('SMOKE_SIGNUP_PASSWORD');

  const policyResponse = await fetch(`${api}/v1/account/signup/policy`);
  const policyText = await policyResponse.text();
  if (!policyResponse.ok) {
    throw new Error(`Policy request failed: ${policyResponse.status} ${policyText.slice(0, 200)}`);
  }

  const policy = JSON.parse(policyText) as {
    open: boolean;
    minPasswordLength: number;
    legalDocuments: Array<{
      key: string;
      version: string;
      required: boolean;
    }>;
  };

  if (!policy.open) throw new Error('Staging signup is currently closed.');
  if (password.length < policy.minPasswordLength) {
    throw new Error('Smoke password is shorter than the configured staging minimum.');
  }

  const acceptedDocuments = policy.legalDocuments
    .filter((doc) => doc.required)
    .map((doc) => ({ key: doc.key, version: doc.version }));

  const signupResponse = await fetch(`${api}/v1/account/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      name: 'Mohamed Mostafa',
      locale: 'EN',
      timezone: 'Asia/Riyadh',
      acceptedDocuments,
    }),
  });

  const signupText = await signupResponse.text();
  console.log(`SMOKE_POLICY_STATUS=${policyResponse.status}`);
  console.log(`SMOKE_REQUIRED_DOCS=${acceptedDocuments.length}`);
  console.log(`SMOKE_SIGNUP_STATUS=${signupResponse.status}`);
  console.log(`SMOKE_SIGNUP_RESPONSE=${signupText.slice(0, 300)}`);

  if (!signupResponse.ok) {
    throw new Error(`Signup smoke failed with HTTP ${signupResponse.status}`);
  }

  const body = JSON.parse(signupText) as { acknowledged?: boolean };
  if (body.acknowledged !== true) {
    throw new Error('Signup endpoint did not acknowledge the request.');
  }

  console.log('STAGING_SIGNUP_SMOKE_OK');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Staging signup smoke failed.');
  process.exitCode = 1;
});
