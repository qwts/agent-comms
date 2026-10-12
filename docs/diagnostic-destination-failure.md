# Diagnostic destination failure

After a diagnostic destination fails, its sink discards bounded pending work and
stays disabled without helper restart. Later recognized observation attempts
increment bounded component drop counts before detail construction or rate-clock
work; unknown and reserved tokens remain ignored. No summaries can be emitted
through that failed destination. Canonical delivery, security errors and audit
behavior remain independent. This avoids post-failure work; causation for the
observed failed-helper p95 budget failure and performance acceptance are unproven.
