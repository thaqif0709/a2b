# Mixed Ride journey screenshots

Captured from this PR against local Wrangler on 5 November 2026, in a 390×844 browser viewport. The Worker used the committed GTFS data and its actual `/api/transit` endpoint; route responses were not mocked. GPS was set to public locations for testing. No live traffic probes were enabled.

- `bus-to-train-preview.png`: AJ52 Hub Sri Nilam → AJ2A bus → Ampang Line → Kelana Jaya Line → Suria KLCC.
- `transfer-details.png`: the preview's walking and line changes.
- `bus-guidance.png`: active guidance on the bus portion.
- `transfer-guidance.png`: alight from AJ2A and walk to Cahaya station.
- `train-guidance.png`: the onward Ampang Line after confirming arrival at Cahaya.
- `train-to-bus-preview.png`: the reverse journey, ending with the AJ2A bus.

Active-guidance checks used the app's “I'm here” position confirmations to move between legs. GPS was then withheld to confirm the journey did not announce arrival solely from missing fixes. These are browser checks, not a physical ride or validation of live bus arrivals. Timetable estimates and map positions reflect the test session.

The automated cases in `test/mixed-transit.test.js` also cover both directions, transfer timing, catching a later departure after a longer real walk, missing the final departure, unreachable transfers, expired/disconnected services, and retaining a direct rail option.
