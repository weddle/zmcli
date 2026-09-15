const EXPECTED = Object.freeze({
  version: 1,
  service: 'chat',
  scenario: 'natural_zak_expiry_490_remint_resume',
  outcome: 'verified_recovery',
  interactiveLoginDuringObservation: false,
  syntheticExpiry: false,
  mutationsEnabled: false,
});

const ORDERED_TIMESTAMPS = Object.freeze([
  'startedAt',
  'initialZakIssuedAt',
  'initialZakExpiresAt',
  'first490At',
  'remintAt',
  'rotatedCredentialAt',
  'identityInvariantVerifiedAt',
  'replayAt',
  'resumedReadAt',
  'stoppedAt',
]);

function invalid(message, details = {}) {
  return Object.assign(new Error(message), { code: 'INVALID_ZAK_EXPIRY_EVIDENCE', details });
}

export function validateZakExpiryEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Evidence must be one JSON object.');
  for (const [field, expected] of Object.entries(EXPECTED)) {
    if (value[field] !== expected) throw invalid(`Evidence field ${field} does not match the accepted natural-expiry result.`, { field, expected, actual: value[field] });
  }
  const times = {};
  for (const field of ORDERED_TIMESTAMPS) {
    if (typeof value[field] !== 'string' || !Number.isFinite(Date.parse(value[field]))) throw invalid(`Evidence field ${field} must be an ISO timestamp.`, { field });
    times[field] = Date.parse(value[field]);
  }
  if (typeof value.boundedPostExpiryDeadline !== 'string' || !Number.isFinite(Date.parse(value.boundedPostExpiryDeadline))) {
    throw invalid('Evidence field boundedPostExpiryDeadline must be an ISO timestamp.', { field: 'boundedPostExpiryDeadline' });
  }
  for (let index = 1; index < ORDERED_TIMESTAMPS.length; index++) {
    const previous = ORDERED_TIMESTAMPS[index - 1], field = ORDERED_TIMESTAMPS[index];
    if (times[field] < times[previous]) throw invalid(`Evidence timestamps are out of order at ${field}.`, { previous, field });
  }
  if (times.first490At < times.initialZakExpiresAt) {
    throw invalid('The first 490 preceded the advertised ZAK expiry and cannot establish natural-expiry recovery.', { field: 'first490At' });
  }
  if (times.first490At > Date.parse(value.boundedPostExpiryDeadline)) {
    throw invalid('The first natural 490 occurred outside the bounded post-expiry observation window.', { field: 'first490At' });
  }
  return Object.freeze({
    accepted: true,
    scenario: value.scenario,
    observed: Object.freeze({
      natural490AfterAdvertisedExpiry: times.first490At >= times.initialZakExpiresAt,
      oneSafeReadRemint: true,
      credentialRotated: true,
      identityInvariantVerified: true,
      replaySucceeded: true,
      readResumed: true,
      interactiveLogin: false,
      syntheticExpiry: false,
      mutation: false,
    }),
  });
}
