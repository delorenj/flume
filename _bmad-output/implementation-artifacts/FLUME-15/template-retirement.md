# FLUME-15 canonical template retirement

The remaining registry projection was retired in canonical hermes-agent-template commit `4ae890a5f27c8f6ee914fa80a0a66b0e1ca63f74`, landed and pushed to main on October 5, 2026. Flume consumes it through the templates/hermes-agent gitlink.

The current 70-systemd.sh header and unavailable-manager status already describe heartbeat retirement correctly. No changes were needed there. The 80-registry.sh writer now emits only the employee gateway unit and removes the old managed systemd.heartbeat_timer field on reprovision. It preserves other employees, operator extension fields, timestamps, and role.yaml.

The parent ran the existing Bloodbank-consumer, named-identity, and repository-privacy template suites: **55 passed**. Independent reviewer `01a10b9c-3392-7612-80ed-05ebb45a845a` returned **PASS**, independently reran the same 55 tests, checked shell/Python argument alignment, and exercised the actual registry writer for preservation and a byte-identical second run. The review diff digest was `b341eb5e9a72cd412cd8c331e4f61bab5ed14cbc6f8b02c5c7c1e5e9ef1e1ae8`.

This is template source and isolated provisioning proof. It does not claim operator registry rows were reprovisioned, services were changed, or the Flume handbook/observer unit was complete at this checkpoint. Historical timer fields remain compatible input for that observer change.
