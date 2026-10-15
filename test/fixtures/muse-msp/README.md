These NDJSON files are copied verbatim from the official `mslsrc/muse-code-sdk`
stable MSP conformance corpus accompanying SDK 1.4.7. They are conformance
fixtures, not evidence of a paid live Muse session. `host.cjs` uses their actual
envelope, session, item, approval-choice and terminal shapes and substitutes the
client-generated command and turn identities. Tests run a real stdio process.
Source revision: `a0c8611b382584eb5091942b477f30e92e1c8d18`.

Sources: `schema/msp/transcripts/{text-run-single-turn,cancel-mid-turn,
provider-failure-turn,approval-deny-round-trip}/transcript.ndjson`.
